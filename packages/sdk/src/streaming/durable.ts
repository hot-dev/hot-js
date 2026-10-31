// Shared machinery for the durable stream helpers: one reconnect policy, run
// correlation for a published event, and stream:data buffering.
import { isHotApiError, isPermanentError } from "../errors.js";
import { backoffDelayMs, mergeAbortSignals, sleep, timeoutError } from "../retry.js";
import type { RunRecord } from "../types.js";
import type { StreamDataEvent, StreamEvent } from "./types.js";
import { isRunTerminalEvent } from "./types.js";

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
/** Three missed 15 s keepalives: the connection is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
const MAX_BUFFERED_CHUNKS = 1_000;

export interface ReconnectorOptions {
  /** Consecutive failed connections allowed before giving up. */
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Absolute deadline (epoch milliseconds), when the caller has a timeout. */
  deadline?: number;
  /** Message of the timeout error when backoff would pass the deadline. */
  timeoutMessage: string;
  /** Message when the attempts run out after connections that ended cleanly. */
  exhaustedMessage: string;
}

/**
 * The reconnect budget of one durable waiter. Permanent errors (4xx other than
 * 408 and 429) stop it at once. A connection that made progress (delivered a
 * new event, or ended with the server's `stream:complete` rollover) resets the
 * count and reconnects at once; others count as consecutive failures and back
 * off with jitter, honouring `retry_after`, never past the deadline.
 */
export class Reconnector {
  private failures = 0;

  constructor(private readonly options: ReconnectorOptions) {}

  /** Resolve when it is time to reconnect after a connection ended; throw to stop. */
  async next(progressed: boolean, error?: unknown): Promise<void> {
    const { signal, deadline } = this.options;
    if (signal?.aborted) throw signal.reason ?? error ?? new Error("Aborted");
    if (error !== undefined && isPermanentError(error)) throw error;
    if (progressed) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures > (this.options.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS)) {
      throw error ?? new Error(this.options.exhaustedMessage);
    }
    const retryAfter = isHotApiError(error) ? error.retryAfter : undefined;
    const delay = backoffDelayMs(this.failures, retryAfter);
    if (deadline !== undefined && Date.now() + delay >= deadline) {
      throw timeoutError(this.options.timeoutMessage, error);
    }
    await sleep(delay, signal);
  }
}

/**
 * Tracks which runs belong to one published event: runs whose `event_id` is
 * the event's, and the retry runs of those runs (a retry gets a new event and
 * links back only through `origin_run_id`). Buffers `stream:data` for runs not
 * yet correlated, because the server may send chunks and even `run:stop`
 * before `run:start`.
 */
export class RunCorrelator {
  eventId: string | undefined;
  private readonly runs = new Map<string, RunRecord>();
  private readonly retrying = new Set<string>();
  private readonly buffered = new Map<string, StreamDataEvent[]>();
  private bufferedCount = 0;

  constructor(eventId?: string) {
    this.eventId = eventId;
  }

  /** Whether `run` belongs to the event; records it when it does. */
  correlate(run: RunRecord | undefined): boolean {
    if (!run?.run_id) return false;
    if (this.runs.has(run.run_id)) return true;
    const origin = run.origin_run_id ? this.runs.get(run.origin_run_id) : undefined;
    const ours = (this.eventId !== undefined && run.event_id === this.eventId)
      || (origin !== undefined && (
        this.retrying.has(origin.run_id)
        || ((run.retry_attempt ?? 0) > 0 && run.run_type === origin.run_type)
      ));
    if (ours) this.runs.set(run.run_id, run);
    return ours;
  }

  isCorrelated(runId: string | undefined): boolean {
    return runId !== undefined && this.runs.has(runId);
  }

  /**
   * Whether a terminal event for a correlated run ends the wait. A `run:fail`
   * whose run is `pending_retry` does not: its retry run continues the work.
   */
  endsWait(event: StreamEvent): boolean {
    if (!isRunTerminalEvent(event) || !this.correlate(event.run)) return false;
    if (event.type === "run:fail" && event.run?.status === "pending_retry") {
      this.retrying.add(event.run.run_id);
      return false;
    }
    return true;
  }

  /** Chunks that may be delivered now for this `stream:data` event (in order). */
  data(event: StreamDataEvent): StreamDataEvent[] {
    const runId = event.run_id;
    if (!runId) return [];
    if (this.runs.has(runId)) return [...this.take(runId), event];
    let queue = this.buffered.get(runId);
    if (!queue) {
      queue = [];
      this.buffered.set(runId, queue);
    }
    queue.push(event);
    this.bufferedCount += 1;
    if (this.bufferedCount > MAX_BUFFERED_CHUNKS) this.dropOldest();
    return [];
  }

  /** Chunks buffered for `runId`, once it is correlated. */
  take(runId: string | undefined): StreamDataEvent[] {
    if (!runId || !this.runs.has(runId)) return [];
    const queue = this.buffered.get(runId);
    if (!queue) return [];
    this.buffered.delete(runId);
    this.bufferedCount -= queue.length;
    return queue;
  }

  private dropOldest(): void {
    const [runId, queue] = this.buffered.entries().next().value as [string, StreamDataEvent[]];
    queue.shift();
    this.bufferedCount -= 1;
    if (queue.length === 0) this.buffered.delete(runId);
  }
}

export interface FollowStreamOptions {
  /** Open the first connection (for example the subscribe-with-event POST). */
  open: () => AsyncGenerator<StreamEvent, void, undefined>;
  /** Open a reconnection to an existing stream. */
  reopen: (streamId: string) => AsyncGenerator<StreamEvent, void, undefined>;
  /** Known stream id; otherwise learned from `event:published`. */
  streamId?: string;
  correlator: RunCorrelator;
  reconnector: Reconnector;
  /**
   * Whether a failed first connection may be opened again. Only for failures
   * that prove nothing was published: no stream id yet and a 429 or 503.
   */
  retryOpen?: boolean;
}

/**
 * Yield a stream's events across reconnects, deduplicating replayed run
 * lifecycle events by `run_id`, and return after the terminal event of the
 * correlated run.
 */
export async function* followStream(
  options: FollowStreamOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  const { correlator, reconnector } = options;
  const seenStart = new Set<string>();
  const seenTerminal = new Set<string>();
  let streamId = options.streamId;

  while (true) {
    const iter = streamId ? options.reopen(streamId) : options.open();
    let progressed = false;
    let failure: unknown;
    try {
      for await (const event of iter) {
        if (event.type === "event:published") {
          if (event.stream_id) streamId = event.stream_id;
          if (event.event_id && correlator.eventId === undefined) correlator.eventId = event.event_id;
        } else if (event.type === "run:start") {
          const runId = event.run?.run_id;
          if (runId && seenStart.has(runId)) continue;
          if (runId) seenStart.add(runId);
          correlator.correlate(event.run);
        } else if (isRunTerminalEvent(event)) {
          const runId = event.run?.run_id;
          if (runId && seenTerminal.has(runId)) continue;
          if (runId) seenTerminal.add(runId);
        }
        // Any new event is progress, including the server's 300 s
        // `stream:complete` rollover.
        if (event.type !== "keepalive") progressed = true;
        const done = correlator.endsWait(event);
        yield event;
        if (done) return;
      }
    } catch (error) {
      failure = error;
    }

    if (!streamId) {
      const resendable = options.retryOpen
        && isHotApiError(failure)
        && (failure.status === 429 || failure.status === 503);
      if (!resendable) throw failure ?? new Error("stream ended before event:published was received");
    }
    await reconnector.next(progressed, failure);
  }
}

export interface WaitForSnapshotOptions<T> {
  /** Open one subscription that yields durable snapshots of the record. */
  open: (signal: AbortSignal) => AsyncGenerator<StreamEvent, void, undefined>;
  /** The snapshot an event carries, if any. */
  snapshot: (event: StreamEvent) => T | undefined;
  /** The outcome when the snapshot is final: `{ done }` or `{ failed }`; else undefined. */
  settle: (snapshot: T) => { done: T } | { failed: Error } | undefined;
  timeoutMs: number;
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  exhaustedMessage: string;
}

/**
 * Wait on a durable record subscription (`runs.wait`, `tasks.wait`). Each
 * connection starts with the latest snapshot, so a connection makes progress
 * only when it delivers a snapshot that differs from the last one seen.
 */
export async function waitForSnapshot<T>(options: WaitForSnapshotOptions<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(timeoutError(options.timeoutMessage)),
    options.timeoutMs,
  );
  const signal = mergeAbortSignals([options.signal, controller.signal]);
  const reconnector = new Reconnector({
    maxAttempts: options.maxReconnectAttempts,
    signal,
    deadline: Date.now() + options.timeoutMs,
    timeoutMessage: options.timeoutMessage,
    exhaustedMessage: options.exhaustedMessage,
  });

  let outcome: { done: T } | { failed: Error };
  try {
    outcome = await settleSnapshots(options, signal, reconnector);
  } catch (error) {
    throw signal.aborted ? signal.reason ?? error : error;
  } finally {
    clearTimeout(timeout);
  }
  if ("done" in outcome) return outcome.done;
  throw outcome.failed;
}

async function settleSnapshots<T>(
  options: WaitForSnapshotOptions<T>,
  signal: AbortSignal,
  reconnector: Reconnector,
): Promise<{ done: T } | { failed: Error }> {
  let last: string | undefined;
  while (true) {
    let progressed = false;
    let failure: unknown;
    try {
      for await (const event of options.open(signal)) {
        if (event.type === "stream:complete") progressed = true;
        const snapshot = options.snapshot(event);
        if (snapshot === undefined) continue;
        const key = JSON.stringify(snapshot);
        if (key !== last) {
          last = key;
          progressed = true;
        }
        const outcome = options.settle(snapshot);
        if (outcome) return outcome;
      }
    } catch (error) {
      failure = error;
    }
    await reconnector.next(progressed, failure);
  }
}
