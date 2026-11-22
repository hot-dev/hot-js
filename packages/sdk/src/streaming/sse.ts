import { clampTimeoutMs } from "../retry.js";
import { toStreamEvent, type StreamEvent } from "./types.js";

/** Maximum uncommitted SSE event buffer size (16 MiB) before raising an error. */
export const MAX_SSE_BUFFER_BYTES = 16 * 1024 * 1024;

export interface SseBlock {
  /** Raw lines of the event block without line terminators. */
  lines: string[];
  /** `data:` field values joined with `"\n"` per WHATWG SSE §9.2.6, or `null` if no `data` field was present. */
  data: string | null;
}

export function extractBlockData(lines: readonly string[]): string | null {
  let dataLines: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      (dataLines ??= []).push(line.slice(6));
    } else if (line.startsWith("data:")) {
      (dataLines ??= []).push(line.slice(5));
    } else if (line === "data") {
      (dataLines ??= []).push("");
    }
  }
  return dataLines === null ? null : dataLines.join("\n");
}

/**
 * Incremental O(N) SSE framing parser supporting `\r\n`, `\n`, and `\r` line
 * endings, leading UTF-8 BOM removal, WHATWG §9.2.6 multi-line `data:`
 * joining, and a bounded uncommitted buffer size.
 */
export class SseParser {
  private readonly maxBufferChars: number;
  private bomChecked = false;
  private pendingLine = "";
  private pendingCr = false;
  private currentLines: string[] = [];
  private bufferedChars = 0;

  constructor(maxBufferChars = MAX_SSE_BUFFER_BYTES) {
    this.maxBufferChars = maxBufferChars;
  }

  /** Feed a decoded text chunk and return all complete SSE blocks found in it. */
  push(chunk: string): SseBlock[] {
    if (!chunk) return [];
    let input = chunk;
    if (!this.bomChecked) {
      this.bomChecked = true;
      if (input.startsWith("\uFEFF")) input = input.slice(1);
      if (!input) return [];
    }

    const blocks: SseBlock[] = [];
    let start = 0;

    if (this.pendingCr) {
      this.pendingCr = false;
      if (input.charCodeAt(0) === 10 /* \n */) {
        start = 1;
      }
    }

    const len = input.length;
    for (let i = start; i < len; ) {
      const ch = input.charCodeAt(i);
      if (ch !== 10 && ch !== 13) {
        i += 1;
        continue;
      }

      const segment = input.slice(start, i);
      const line = this.pendingLine ? this.pendingLine + segment : segment;
      this.pendingLine = "";

      if (ch === 13) {
        if (i + 1 < len) {
          i += input.charCodeAt(i + 1) === 10 ? 2 : 1;
        } else {
          this.pendingCr = true;
          i += 1;
        }
      } else {
        i += 1;
      }
      start = i;

      if (line === "") {
        if (this.currentLines.length > 0) {
          blocks.push({ lines: this.currentLines, data: extractBlockData(this.currentLines) });
          this.currentLines = [];
          this.bufferedChars = 0;
        }
      } else {
        this.bufferedChars += line.length + 1;
        if (this.bufferedChars > this.maxBufferChars) {
          throw new Error(`SSE buffer exceeded maximum size of ${this.maxBufferChars} bytes`);
        }
        this.currentLines.push(line);
      }
    }

    if (start < len) {
      const tail = input.slice(start);
      this.pendingLine += tail;
      if (this.bufferedChars + this.pendingLine.length > this.maxBufferChars) {
        throw new Error(`SSE buffer exceeded maximum size of ${this.maxBufferChars} bytes`);
      }
    }

    return blocks;
  }

  /** Flush any trailing uncommitted lines at EOF. */
  flush(): SseBlock | undefined {
    this.pendingCr = false;
    if (this.pendingLine.length > 0) {
      this.currentLines.push(this.pendingLine);
      this.pendingLine = "";
    }
    if (this.currentLines.length === 0) return undefined;
    const lines = this.currentLines;
    this.currentLines = [];
    this.bufferedChars = 0;
    return { lines, data: extractBlockData(lines) };
  }
}

/**
 * Split complete SSE blocks out of a string buffer in a single O(N) pass,
 * handling `\r\n`, `\n`, and `\r` line endings and optional leading UTF-8 BOM.
 */
export function splitSseBlocks(
  buffer: string,
  stripBom = false,
  maxBufferChars = MAX_SSE_BUFFER_BYTES,
): [SseBlock[], string] {
  const input = stripBom && buffer.startsWith("\uFEFF") ? buffer.slice(1) : buffer;
  if (input.length > maxBufferChars) {
    throw new Error(`SSE buffer exceeded maximum size of ${maxBufferChars} bytes`);
  }

  const len = input.length;
  const blocks: SseBlock[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let lines: string[] = [];

  for (let i = 0; i < len; ) {
    const ch = input.charCodeAt(i);
    if (ch !== 10 /* \n */ && ch !== 13 /* \r */) {
      i += 1;
      continue;
    }

    // A trailing bare \r at the end of a non-empty line could be the first
    // half of a \r\n split across chunks: keep this uncommitted block in rest.
    if (ch === 13 && i + 1 === len && i > lineStart) {
      break;
    }

    const line = input.slice(lineStart, i);
    if (ch === 13 && i + 1 < len && input.charCodeAt(i + 1) === 10) {
      i += 2;
    } else {
      i += 1;
    }
    lineStart = i;

    if (line === "") {
      if (lines.length > 0) {
        blocks.push({ lines, data: extractBlockData(lines) });
        lines = [];
      }
      blockStart = i;
    } else {
      lines.push(line);
    }
  }

  return [blocks, blockStart === 0 ? input : input.slice(blockStart)];
}

function parseJsonData<T>(data: string, map: (value: unknown) => T | undefined): T | undefined {
  try {
    return map(JSON.parse(data) as unknown);
  } catch {
    // ignore non-JSON keepalives
    return undefined;
  }
}

/**
 * Parse one or more SSE `data:` blocks from a buffer. Events of a type this SDK
 * does not know are wrapped as `{ type: "unknown", event_type, data }`.
 */
export function consumeSseBlocks(buffer: string): [StreamEvent[], string] {
  const [blocks, rest] = splitSseBlocks(buffer, true);
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    if (block.data === null) continue;
    const event = parseJsonData(block.data, toStreamEvent);
    if (event) events.push(event);
  }
  return [events, rest];
}

export interface ConsumeSseOptions {
  signal?: AbortSignal;
  /**
   * Fail with a transient error when no bytes arrive for this long. Hot sends
   * a keepalive comment every 15 s, so silence means a dead connection.
   */
  idleTimeoutMs?: number;
  /** Maximum uncommitted SSE event buffer size in characters/bytes. Defaults to 16 MiB. */
  maxBufferBytes?: number;
}

/** Raised when an SSE connection goes silent for longer than `idleTimeoutMs`. */
export class StreamIdleError extends Error {
  constructor(idleTimeoutMs: number) {
    super(`No data on the event stream for ${idleTimeoutMs} ms`);
    this.name = "StreamIdleError";
  }
}

/**
 * Read an SSE HTTP response and yield parsed Hot stream events.
 * Releases the reader when the consumer stops early.
 */
export function consumeSseResponse(
  loadResponse: () => Promise<Response>,
  options?: ConsumeSseOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  return readSse(loadResponse, toStreamEvent, options);
}

/** Read an SSE response, yielding each JSON payload that `map` accepts. */
export async function* readSse<T>(
  loadResponse: () => Promise<Response>,
  map: (value: unknown) => T | undefined,
  options?: ConsumeSseOptions,
): AsyncGenerator<T, void, undefined> {
  const response = await loadResponse();
  if (!response.body) {
    throw new Error("SSE response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(options?.maxBufferBytes ?? MAX_SSE_BUFFER_BYTES);

  try {
    while (true) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error("Aborted");
      }

      const { done, value } = await readWithIdleTimeout(
        reader,
        options?.idleTimeoutMs,
        options?.signal,
      );
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const block of parser.push(text)) {
        if (block.data === null) continue;
        const item = parseJsonData(block.data, map);
        if (item !== undefined) yield item;
      }
    }

    const extra = decoder.decode();
    if (extra) {
      for (const block of parser.push(extra)) {
        if (block.data === null) continue;
        const item = parseJsonData(block.data, map);
        if (item !== undefined) yield item;
      }
    }

    const tail = parser.flush();
    if (tail && tail.data !== null) {
      const item = parseJsonData(tail.data, map);
      if (item !== undefined) yield item;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Aborted");
  }

  const readPromise = reader.read();
  if (!idleTimeoutMs && !signal) return readPromise;

  const racers: Array<Promise<ReadableStreamReadResult<Uint8Array>>> = [readPromise];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  if (idleTimeoutMs) {
    racers.push(new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StreamIdleError(idleTimeoutMs)),
        clampTimeoutMs(idleTimeoutMs),
      );
    }));
  }

  if (signal) {
    racers.push(new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }));
  }

  try {
    return await Promise.race(racers);
  } catch (error) {
    // Prevent an unhandled rejection if the abandoned read() rejects later
    // (for example when finally calls reader.cancel()).
    readPromise.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
