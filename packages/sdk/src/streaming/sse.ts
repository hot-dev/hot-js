import { toStreamEvent, type StreamEvent } from "./types.js";

/** Split complete SSE blocks out of `buffer` and JSON-parse their `data:` payloads. */
function takeSseData(buffer: string): [unknown[], string] {
  const values: unknown[] = [];
  let remaining = buffer;

  while (true) {
    const idx = remaining.indexOf("\n\n");
    if (idx === -1) break;

    const block = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 2);

    let dataPayload: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        dataPayload = (dataPayload ?? "") + line.slice(6);
      } else if (line.startsWith("data:")) {
        dataPayload = (dataPayload ?? "") + line.slice(5);
      }
    }

    if (dataPayload === null) continue;

    try {
      values.push(JSON.parse(dataPayload) as unknown);
    } catch {
      // ignore non-JSON keepalives
    }
  }

  return [values, remaining];
}

/**
 * Parse one or more SSE `data:` blocks from a buffer. Events of a type this SDK
 * does not know are wrapped as `{ type: "unknown", event_type, data }`.
 */
export function consumeSseBlocks(buffer: string): [StreamEvent[], string] {
  const [values, rest] = takeSseData(buffer);
  const events: StreamEvent[] = [];
  for (const value of values) {
    const event = toStreamEvent(value);
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
  let buffer = "";

  try {
    while (true) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error("Aborted");
      }

      const { done, value } = await readWithIdleTimeout(reader, options?.idleTimeoutMs);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const [values, rest] = takeSseData(buffer);
      buffer = rest;
      for (const raw of values) {
        const item = map(raw);
        if (item !== undefined) yield item;
      }
    }

    buffer += decoder.decode();
    const [tail] = takeSseData(`${buffer}\n\n`);
    for (const raw of tail) {
      const item = map(raw);
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
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!idleTimeoutMs) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamIdleError(idleTimeoutMs)), idleTimeoutMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}
