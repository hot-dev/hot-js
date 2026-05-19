import { isStreamEvent, type StreamEvent } from "./types.js";

/** Parse one or more SSE `data:` blocks from a buffer. */
export function consumeSseBlocks(buffer: string): [StreamEvent[], string] {
  const events: StreamEvent[] = [];
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
      const parsed = JSON.parse(dataPayload) as unknown;
      if (isStreamEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // ignore non-JSON keepalives
    }
  }

  return [events, remaining];
}

export interface ConsumeSseOptions {
  signal?: AbortSignal;
}

/**
 * Read an SSE HTTP response and yield parsed Hot stream events.
 * Releases the reader when the consumer stops early.
 */
export async function* consumeSseResponse(
  loadResponse: () => Promise<Response>,
  options?: ConsumeSseOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
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

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const [events, rest] = consumeSseBlocks(buffer);
      buffer = rest;
      for (const evt of events) {
        yield evt;
      }
    }

    buffer += decoder.decode();
    const [tail] = consumeSseBlocks(`${buffer}\n\n`);
    for (const evt of tail) {
      yield evt;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
}
