import type { HttpClient } from "../http.js";
import type { RunRecord } from "../types.js";
import { consumeSseResponse } from "./sse.js";
import type {
  RunCancelEvent,
  RunFailEvent,
  RunStartEvent,
  RunStopEvent,
  StreamDataEvent,
  StreamEvent,
} from "./types.js";
import { eventIdFromRun, runIdFromEvent } from "./types.js";

export interface WaitForRunOptions {
  timeoutMs?: number;
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}

class RunTerminalError extends Error {}

/**
 * Subscribe to a stream and wait for the run associated with `eventId`.
 * Optionally invoke `onChunk` for `ai:delta` stream:data events.
 */
export async function waitForRunResult(
  http: HttpClient,
  streamId: string,
  eventId: string,
  options?: WaitForRunOptions,
): Promise<RunRecord> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Timeout waiting for run result")),
    timeoutMs,
  );

  const signal = mergeAbortSignals([options?.signal, controller.signal]);

  let currentRunId: string | null = null;

  let reconnectAttempts = 0;
  try {
    while (true) {
      try {
        for await (const evt of consumeSseResponse(
          async () => {
            return http.requestRaw("GET", `/streams/${streamId}/subscribe`, {
              headers: { Accept: "text/event-stream" },
              signal,
            });
          },
          { signal },
        )) {
          if (evt.type === "run:start") {
            const run = (evt as RunStartEvent).run;
            if (run && eventIdFromRun(run) === eventId) {
              currentRunId = run.run_id;
            }
          }

          if (evt.type === "stream:data") {
            const data = evt as StreamDataEvent;
            // Stream data does not carry event_id, so only forward chunks once
            // run:start has correlated this request to a concrete run_id.
            if (currentRunId && data.run_id === currentRunId) {
              const text = data.payload?.text;
              if (typeof text === "string" && options?.onChunk) {
                options.onChunk(text);
              }
            }
          }

          if (
            evt.type === "run:stop" ||
            evt.type === "run:fail" ||
            evt.type === "run:cancel"
          ) {
            const lifecycle = evt as RunStopEvent | RunFailEvent | RunCancelEvent;
            const run = lifecycle.run;
            if (run && eventIdFromRun(run) === eventId) {
              if (evt.type === "run:fail") {
                throw new RunTerminalError(runResultMessage(run, "Run failed"));
              }
              if (evt.type === "run:cancel") {
                throw new RunTerminalError(runResultMessage(run, "Run cancelled"));
              }
              return run;
            }
          }
        }
      } catch (error) {
        if (error instanceof RunTerminalError) throw error;
        if (signal.aborted) throw error;
        if (reconnectAttempts >= (options?.maxReconnectAttempts ?? 5)) throw error;
      }
      if (reconnectAttempts >= (options?.maxReconnectAttempts ?? 5)) {
        throw new Error("Stream ended before run completed");
      }
      reconnectAttempts += 1;
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function runResultMessage(run: RunRecord, fallback: string): string {
  return resultMessage(run.result) ?? `${fallback}${run.status ? ` (${run.status})` : ""}`;
}

export function resultMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["$err", "$val", "error", "message", "msg", "reason", "err"]) {
    const message = resultMessage(record[key]);
    if (message) return message;
  }
  return undefined;
}

export function matchesRunEvent(event: StreamEvent, runId: string | null, eventId: string | null): boolean {
  if (event.type === "run:stop" || event.type === "run:fail" || event.type === "run:cancel") {
    const lifecycle = event as RunStopEvent | RunFailEvent | RunCancelEvent;
    const runEventId = eventIdFromRun(lifecycle.run);
    const rid = runIdFromEvent(event);
    if (eventId && runEventId === eventId) return true;
    if (runId && rid === runId) return true;
  }
  return false;
}
