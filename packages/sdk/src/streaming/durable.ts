// Shared machinery for the durable stream helpers: one reconnect policy, run
// correlation for a published event, and stream:data buffering.
import { isHotApiError, isPermanentError } from "../errors.js";
import { backoffDelayMs, mergeAbortSignals, sleep, timeoutError } from "../retry.js";
import type { RunRecord } from "../types.js";
import type {
  RunCancelEvent,
  RunFailEvent,
  RunStartEvent,
  RunStopEvent,
  StreamDataEvent,
  StreamEvent,
} from "./types.js";
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

/** How long a failure whose retry was scheduled waits for the retry run. */
export const RETRY_GRACE_MS = 5_000;

type RunLifecycleEvent = RunStartEvent | RunStopEvent | RunFailEvent | RunCancelEvent;
export type RunOutcomeEvent = RunStopEvent | RunFailEvent | RunCancelEvent;

interface TiedRun {
  /** Highest `retry_attempt` seen for the run. */
  attempt: number;
  runType: string | undefined;
}

/**
 * Ties runs on a stream to one published event and decides when its work is
 * done. A run belongs to the event when its `event_id` matches, or when it is
 * a retry of a tied run: its `origin_run_id` names a tied run of the same
 * `run_type` (a retry gets a new event ID; task runs also name their starting
 * run as origin, but have type `task`).
 *
 * The server replays a retried first attempt lossily: as `run:fail` or
 * `run:stop` with status `pending_retry`, or, once the retry is queued and
 * before the retry run exists, as `run:fail` with status `failed`. So:
 * `pending_retry` is never final; a tied run that a tied retry names as its
 * origin is "retried" and its later `run:fail` is not final; and a `run:fail`
 * whose `retry_attempt` is above its own attempt number (its origin's
 * `retry_attempt`, or 0) is held for `RETRY_GRACE_MS` and stands only if no
 * retry of it appears by then (or by the caller's deadline).
 *
 * Buffers `stream:data` for runs not yet tied, because the server may send
 * chunks and even `run:stop` before `run:start`.
 */
export class RunCorrelator {
  eventId: string | undefined;
  /** The event that ended the wait: the final run's stop, failure or cancel. */
  outcome: RunOutcomeEvent | undefined;
  private readonly runs = new Map<string, TiedRun>();
  private readonly retried = new Set<string>();
  /** Run events whose origin run is not tied yet, by `origin_run_id`. */
  private readonly orphans = new Map<string, RunLifecycleEvent[]>();
  private held: { runId: string; until: number; event: RunFailEvent } | undefined;
  private readonly buffered = new Map<string, StreamDataEvent[]>();
  private bufferedCount = 0;

  constructor(eventId?: string) {
    this.eventId = eventId;
  }

  isCorrelated(runId: string | undefined): boolean {
    return runId !== undefined && this.runs.has(runId);
  }

  /**
   * Feed one stream event. Returns true once the wait has an `outcome`. A run
   * event may also tie runs seen earlier (retries that arrived before their
   * origin), so call `takeReady()` after it for chunks that became deliverable.
   */
  observe(event: StreamEvent): boolean {
    if (this.outcome) return true;
    if (event.type !== "run:start" && !isRunTerminalEvent(event)) return false;
    if (!event.run?.run_id) return false;
    return this.runEvent(event);
  }

  /** When a held failure stands unless a retry appears (epoch milliseconds). */
  wakeAt(): number | undefined {
    return this.held?.until;
  }

  /** The held failure, if any, becomes the outcome. Returns whether it did. */
  expire(): boolean {
    if (!this.held) return false;
    this.outcome = this.held.event;
    this.held = undefined;
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

  /** Buffered chunks of every run tied so far, in arrival order per run. */
  takeReady(): StreamDataEvent[] {
    const ready: StreamDataEvent[] = [];
    for (const runId of [...this.buffered.keys()]) {
      if (this.runs.has(runId)) ready.push(...this.take(runId));
    }
    return ready;
  }

  private take(runId: string): StreamDataEvent[] {
    const queue = this.buffered.get(runId);
    if (!queue) return [];
    this.buffered.delete(runId);
    this.bufferedCount -= queue.length;
    return queue;
  }

  private ties(run: RunRecord): boolean {
    if (this.eventId !== undefined && run.event_id === this.eventId) return true;
    const origin = run.origin_run_id ? this.runs.get(run.origin_run_id) : undefined;
    return origin !== undefined && origin.runType === run.run_type;
  }

  private runEvent(event: RunLifecycleEvent): boolean {
    const run = event.run!;
    if (!this.ties(run)) {
      if (run.origin_run_id) {
        const queue = this.orphans.get(run.origin_run_id) ?? [];
        queue.push(event);
        this.orphans.set(run.origin_run_id, queue);
      }
      return false;
    }
    const attempt = run.retry_attempt ?? 0;
    let orphans: RunLifecycleEvent[] = [];
    const tied = this.runs.get(run.run_id);
    if (tied) {
      tied.attempt = Math.max(tied.attempt, attempt);
    } else {
      this.runs.set(run.run_id, { attempt, runType: run.run_type });
      orphans = (this.orphans.get(run.run_id) ?? []).filter((orphan) => orphan.run?.run_type === run.run_type);
      this.orphans.delete(run.run_id);
      // A retry of this run is already on the stream.
      if (orphans.length > 0) this.retried.add(run.run_id);
    }
    if (run.origin_run_id) {
      this.retried.add(run.origin_run_id);
      if (this.held?.runId === run.origin_run_id) this.held = undefined;
    }
    if (this.decide(event)) return true;
    for (const orphan of orphans) {
      if (this.runEvent(orphan)) return true;
    }
    return false;
  }

  /** Whether a tied run's event ends the wait. */
  private decide(event: RunLifecycleEvent): boolean {
    const run = event.run!;
    if (run.status === "pending_retry") return false;
    switch (event.type) {
      case "run:stop":
      case "run:cancel":
        this.outcome = event;
        return true;
      case "run:fail": {
        if (this.retried.has(run.run_id)) return false;
        // retry_attempt goes up when a retry is scheduled; a run's own attempt
        // number is its origin's retry_attempt (0 for a first attempt).
        const base = run.origin_run_id ? this.runs.get(run.origin_run_id)?.attempt ?? 0 : 0;
        if ((run.retry_attempt ?? 0) > base) {
          this.held ??= { runId: run.run_id, until: Date.now() + RETRY_GRACE_MS, event };
          return false;
        }
        this.outcome = event;
        return true;
      }
      default:
        return false;
    }
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
  open: (signal: AbortSignal) => AsyncGenerator<StreamEvent, void, undefined>;
  /** Open a reconnection to an existing stream. */
  reopen: (streamId: string, signal: AbortSignal) => AsyncGenerator<StreamEvent, void, undefined>;
  /** Known stream id; otherwise learned from `event:published`. */
  streamId?: string;
  signal?: AbortSignal;
  correlator: RunCorrelator;
  reconnector: Reconnector;
  /**
   * Whether a failed first connection may be opened again. Only for failures
   * that prove nothing was published: no stream id yet and a 429 or 503.
   */
  retryOpen?: boolean;
}

const WOKE = Symbol("woke");

/**
 * Yield a stream's events across reconnects, deduplicating replayed run
 * lifecycle events by `run_id`, and return once the correlator has an
 * outcome: the final event of the published event's run, or a held failure
 * whose retry did not appear in time.
 */
export async function* followStream(
  options: FollowStreamOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  const { correlator, reconnector } = options;
  const seenStart = new Set<string>();
  const seenTerminal = new Set<string>();
  let streamId = options.streamId;

  while (true) {
    const connection = new AbortController();
    const signal = mergeAbortSignals([options.signal, connection.signal]);
    const iter = streamId ? options.reopen(streamId, signal) : options.open(signal);
    let progressed = false;
    let failure: unknown;
    let pending: Promise<IteratorResult<StreamEvent, void>> | undefined;
    try {
      while (true) {
        pending ??= iter.next();
        const next = await nextOrWake(pending, correlator.wakeAt());
        if (next === WOKE) {
          if (correlator.expire()) return;
          continue;
        }
        pending = undefined;
        if (next.done) break;
        const event = next.value;
        if (event.type === "event:published") {
          if (event.stream_id) streamId = event.stream_id;
          if (event.event_id && correlator.eventId === undefined) correlator.eventId = event.event_id;
        } else if (event.type === "run:start") {
          const runId = event.run?.run_id;
          if (runId && seenStart.has(runId)) continue;
          if (runId) seenStart.add(runId);
        } else if (isRunTerminalEvent(event)) {
          const runId = event.run?.run_id;
          if (runId && seenTerminal.has(runId)) continue;
          if (runId) seenTerminal.add(runId);
        }
        // Any new event is progress, including the server's 300 s
        // `stream:complete` rollover.
        if (event.type !== "keepalive") progressed = true;
        const done = correlator.observe(event);
        yield event;
        if (done) return;
      }
    } catch (error) {
      failure = error;
    } finally {
      // Close the connection on every exit, including a consumer leaving early.
      if (pending) pending.catch(() => {});
      else void iter.return(undefined).catch(() => {});
      connection.abort();
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

/** The next event, or `WOKE` when `wakeAt` passes first. */
async function nextOrWake<T>(pending: Promise<T>, wakeAt: number | undefined): Promise<T | typeof WOKE> {
  if (wakeAt === undefined) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = new Promise<typeof WOKE>((resolve) => {
    timer = setTimeout(() => resolve(WOKE), Math.max(0, wakeAt - Date.now()));
  });
  try {
    return await Promise.race([pending, wake]);
  } finally {
    clearTimeout(timer);
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
