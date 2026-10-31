import type { HttpClient } from "../http.js";
import { StreamsResource } from "../resources/streams.js";
import { mergeAbortSignals, timeoutError } from "../retry.js";
import type { RunRecord } from "../types.js";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  followStream,
  Reconnector,
  RunCorrelator,
  type RunOutcomeEvent,
  STREAM_IDLE_TIMEOUT_MS,
} from "./durable.js";
import type { StreamDataEvent, StreamEvent } from "./types.js";
import { eventIdFromRun, isRunTerminalEvent, runIdFromEvent } from "./types.js";

export { mergeAbortSignals } from "../retry.js";

export interface WaitForRunOptions {
  timeoutMs?: number;
  /** Consecutive failed connections tolerated. Default 5; rollovers reset it. */
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}

class RunTerminalError extends Error {}

/**
 * Subscribe to a stream and wait for the run associated with `eventId`.
 * Optionally invoke `onChunk` for `stream:data` events whose payload has
 * `text`, in order, including chunks that arrive before `run:start`. A failed
 * attempt that will be retried (`pending_retry`) is followed to its retry run.
 */
export async function waitForRunResult(
  http: HttpClient,
  streamId: string,
  eventId: string,
  options?: WaitForRunOptions,
): Promise<RunRecord> {
  const streams = new StreamsResource(http);
  return waitForCorrelatedRun(
    (signal, reconnector, correlator) => followStream({
      streamId,
      signal,
      open: (connection) => streams.subscribeOnce(streamId, { signal: connection }, STREAM_IDLE_TIMEOUT_MS),
      reopen: (id, connection) => streams.subscribeOnce(id, { signal: connection }, STREAM_IDLE_TIMEOUT_MS),
      correlator,
      reconnector,
    }),
    new RunCorrelator(eventId),
    "Timeout waiting for run result",
    options,
  );
}

/** @internal Shared by `waitForRunResult` and `events.callHot`. */
export async function waitForCorrelatedRun(
  follow: (
    signal: AbortSignal,
    reconnector: Reconnector,
    correlator: RunCorrelator,
  ) => AsyncGenerator<StreamEvent, void, undefined>,
  correlator: RunCorrelator,
  timeoutMessage: string,
  options?: WaitForRunOptions,
): Promise<RunRecord> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(timeoutError(timeoutMessage)), timeoutMs);
  const signal = mergeAbortSignals([options?.signal, controller.signal]);
  const reconnector = new Reconnector({
    maxAttempts: options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
    signal,
    deadline: Date.now() + timeoutMs,
    timeoutMessage,
    exhaustedMessage: "Stream ended before run completed",
  });
  const deliver = (chunks: StreamDataEvent[]) => {
    for (const chunk of chunks) {
      const text = chunk.payload?.text;
      if (typeof text === "string") options?.onChunk?.(text);
    }
  };

  try {
    for await (const evt of follow(signal, reconnector, correlator)) {
      if (evt.type === "stream:data") deliver(correlator.data(evt));
      else deliver(correlator.takeReady());
    }
  } catch (error) {
    // At the deadline, a failure that was waiting for its retry stands.
    if (controller.signal.aborted && !options?.signal?.aborted && correlator.expire()) {
      return settle(correlator.outcome!);
    }
    throw signal.aborted ? signal.reason ?? error : error;
  } finally {
    clearTimeout(timeout);
  }
  if (!correlator.outcome) throw new Error("Stream ended before run completed");
  return settle(correlator.outcome);
}

function settle(outcome: RunOutcomeEvent): RunRecord {
  const run = outcome.run!;
  if (outcome.type === "run:fail") throw new RunTerminalError(runResultMessage(run, "Run failed"));
  if (outcome.type === "run:cancel") throw new RunTerminalError(runResultMessage(run, "Run cancelled"));
  return run;
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
  if (isRunTerminalEvent(event)) {
    const runEventId = eventIdFromRun(event.run);
    const rid = runIdFromEvent(event);
    if (eventId && runEventId === eventId) return true;
    if (runId && rid === runId) return true;
  }
  return false;
}
