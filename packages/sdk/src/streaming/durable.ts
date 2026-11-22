// Shared machinery for the durable stream helpers: one reconnect policy, run
// correlation for a published event, and stream:data buffering.
import { isHotApiError, isPermanentError } from "../errors.js";
import {
  backoffDelayMs,
  clampTimeoutMs,
  mergeAbortSignals,
  normalizeTimeoutMs,
  sleep,
  timeoutError,
} from "../retry.js";
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
const MAX_ORPHAN_EVENTS = 1_000;
const MAX_SEEN_RUN_IDS = 10_000;

function addCapped(set: Set<string>, value: string, max: number): void {
  if (set.has(value)) return;
  if (set.size >= max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

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
  /** This run's own attempt number (0 for first attempt, >= origin + 1 for retries). */
  initialAttempt: number;
  /** Highest `retry_attempt` seen for the run. */
  attempt: number;
  runType: string | undefined;
}

/**
 * Ties runs on a stream to one published event and decides when its work is
 * done. A run belongs to the event when its `event_id` matches, when it was
 * named by a tied run's `run:fail.retry_run_id`, or when it is a retry of a
 * tied run: its `origin_run_id` names a tied run of the same `run_type` (a
 * retry gets a new event ID; task runs also name their starting run as origin,
 * but have type `task`).
 *
 * The server replays a retried first attempt lossily: as `run:fail` or
 * `run:stop` with status `pending_retry`, or, once the retry is queued and
 * before the retry run exists, as `run:fail` with status `failed`. So:
 * `pending_retry` is never final; a tied run that a tied retry names as its
 * origin (or that reported `retry_run_id`) is "retried" and its later
 * `run:fail` is not final; and a `run:fail` whose `retry_attempt` is above its
 * own attempt number is held for `RETRY_GRACE_MS` and stands only if no retry
 * of it appears by then (or by the caller's deadline).
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
  private orphanCount = 0;
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
    if (this.bufferedCount > MAX_BUFFERED_CHUNKS) this.dropOldestChunk();
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

  private addOrphan(originRunId: string, event: RunLifecycleEvent): void {
    let queue = this.orphans.get(originRunId);
    if (!queue) {
      queue = [];
      this.orphans.set(originRunId, queue);
    }
    queue.push(event);
    this.orphanCount += 1;
    if (this.orphanCount > MAX_ORPHAN_EVENTS) this.dropOldestOrphan();
  }

  private takeOrphans(originRunId: string, runType: string | undefined): RunLifecycleEvent[] {
    const queue = this.orphans.get(originRunId);
    if (!queue) return [];
    this.orphans.delete(originRunId);
    this.orphanCount -= queue.length;
    return queue.filter((orphan) => orphan.run?.run_type === runType);
  }

  private ties(run: RunRecord): boolean {
    if (this.runs.has(run.run_id)) return true;
    if (this.eventId !== undefined && run.event_id === this.eventId) return true;
    const origin = run.origin_run_id ? this.runs.get(run.origin_run_id) : undefined;
    return origin !== undefined && origin.runType === run.run_type;
  }

  private runEvent(event: RunLifecycleEvent): boolean {
    const run = event.run!;
    if (!this.ties(run)) {
      if (run.origin_run_id) {
        this.addOrphan(run.origin_run_id, event);
      }
      return false;
    }

    const attempt = run.retry_attempt ?? 0;
    const origin = run.origin_run_id ? this.runs.get(run.origin_run_id) : undefined;
    let orphans: RunLifecycleEvent[] = [];
    const tied = this.runs.get(run.run_id);
    if (tied) {
      tied.attempt = Math.max(tied.attempt, attempt);
      if (event.type === "run:start" && attempt > tied.initialAttempt) {
        tied.initialAttempt = attempt;
      }
      if (tied.runType === undefined && run.run_type !== undefined) {
        tied.runType = run.run_type;
      }
    } else {
      const initialAttempt = event.type === "run:start"
        ? attempt
        : origin
          ? Math.max(origin.attempt, origin.initialAttempt + 1)
          : 0;
      this.runs.set(run.run_id, {
        initialAttempt,
        attempt: Math.max(initialAttempt, attempt),
        runType: run.run_type,
      });
      orphans = this.takeOrphans(run.run_id, run.run_type);
      // A retry of this run is already on the stream.
      if (orphans.length > 0) this.retried.add(run.run_id);
    }

    if (run.origin_run_id) {
      this.retried.add(run.origin_run_id);
      if (this.held?.runId === run.origin_run_id) this.held = undefined;
    }

    // Hot 3.0.14+ carries top-level `retry_run_id` on `run:fail` when a retry
    // has been scheduled: correlate the retry run immediately.
    if (event.type === "run:fail" && typeof event.retry_run_id === "string" && event.retry_run_id) {
      const retryRunId = event.retry_run_id;
      this.retried.add(run.run_id);
      if (this.held?.runId === run.run_id) this.held = undefined;
      const currentTied = this.runs.get(run.run_id)!;
      const nextAttempt = Math.max(attempt, currentTied.initialAttempt + 1);
      if (!this.runs.has(retryRunId)) {
        this.runs.set(retryRunId, {
          initialAttempt: nextAttempt,
          attempt: nextAttempt,
          runType: run.run_type,
        });
        const retryOrphans = this.takeOrphans(retryRunId, run.run_type);
        if (retryOrphans.length > 0) {
          this.retried.add(retryRunId);
          orphans.push(...retryOrphans);
        }
      }
    }

    // If an already-held child retry failure's origin just reported its updated
    // retry_attempt, check whether the child is actually final now.
    if (this.held && this.held.event.run?.origin_run_id === run.run_id) {
      const heldRun = this.held.event.run;
      const heldTied = this.runs.get(this.held.runId);
      const originTied = this.runs.get(run.run_id)!;
      const newBase = Math.max(
        heldTied?.initialAttempt ?? 0,
        originTied.attempt,
        originTied.initialAttempt + 1,
      );
      if ((heldRun.retry_attempt ?? 0) <= newBase) {
        this.outcome = this.held.event;
        this.held = undefined;
        return true;
      }
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
        // number is at least its initialAttempt and origin's attempt / initial+1.
        const tied = this.runs.get(run.run_id);
        const origin = run.origin_run_id ? this.runs.get(run.origin_run_id) : undefined;
        const base = Math.max(
          tied?.initialAttempt ?? 0,
          origin ? Math.max(origin.attempt, origin.initialAttempt + 1) : 0,
        );
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

  private dropOldestChunk(): void {
    const entry = this.buffered.entries().next().value as [string, StreamDataEvent[]] | undefined;
    if (!entry) return;
    const [runId, queue] = entry;
    queue.shift();
    this.bufferedCount -= 1;
    if (queue.length === 0) this.buffered.delete(runId);
  }

  private dropOldestOrphan(): void {
    const entry = this.orphans.entries().next().value as [string, RunLifecycleEvent[]] | undefined;
    if (!entry) return;
    const [originRunId, queue] = entry;
    queue.shift();
    this.orphanCount -= 1;
    if (queue.length === 0) this.orphans.delete(originRunId);
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
  const seenPendingRetry = new Set<string>();
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
          if (runId) addCapped(seenStart, runId, MAX_SEEN_RUN_IDS);
        } else if (isRunTerminalEvent(event)) {
          const runId = event.run?.run_id;
          if (event.run?.status === "pending_retry") {
            // Do NOT insert into seenTerminal so a subsequent final
            // `failed`/`cancelled` event for the same run_id is not dropped.
            if (runId && seenPendingRetry.has(runId)) continue;
            if (runId) addCapped(seenPendingRetry, runId, MAX_SEEN_RUN_IDS);
          } else {
            if (runId && seenTerminal.has(runId)) continue;
            if (runId) addCapped(seenTerminal, runId, MAX_SEEN_RUN_IDS);
          }
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
      // Abort first so any pending read unblocks immediately (including on WOKE
      // expiry), then close the iterator and swallow any rejection from pending.
      connection.abort();
      if (pending) pending.catch(() => {});
      void iter.return(undefined).catch(() => {});
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
    timer = setTimeout(() => resolve(WOKE), clampTimeoutMs(wakeAt - Date.now()));
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
  const effectiveTimeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const controller = effectiveTimeoutMs !== undefined ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(
      () => controller.abort(timeoutError(options.timeoutMessage)),
      effectiveTimeoutMs,
    )
    : undefined;
  const signal = mergeAbortSignals([options.signal, controller?.signal]);
  const reconnector = new Reconnector({
    maxAttempts: options.maxReconnectAttempts,
    signal,
    deadline: effectiveTimeoutMs !== undefined ? Date.now() + effectiveTimeoutMs : undefined,
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
