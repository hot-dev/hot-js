import type { HttpClient } from "../http.js";
import { STREAM_IDLE_TIMEOUT_MS, waitForSnapshot } from "../streaming/durable.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type { RunUpdateEvent } from "../streaming/types.js";
import { runResultMessage } from "../streaming/wait.js";
import type { CallPurgeResponse, RunListQuery, RunRecord, RunStats } from "../types.js";

const enc = encodeURIComponent;

export interface WaitForRunOptions {
  timeoutMs?: number;
  /** Consecutive failed connections tolerated. Default 5. */
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
}

export class HotRunError extends Error {
  readonly run: RunRecord;

  constructor(run: RunRecord) {
    super(runResultMessage(run, "Run failed"));
    this.name = "HotRunError";
    this.run = run;
  }
}

export class RunsResource {
  constructor(private readonly http: HttpClient) {}

  async list(query?: RunListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<RunRecord>("GET", "/runs", {
      query,
      signal: options?.signal,
    });
  }

  async stats(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<RunStats>("GET", "/runs/stats", {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async get(runId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<RunRecord>("GET", `/runs/${runId}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  subscribe(
    runId: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<RunUpdateEvent, void, undefined> {
    const events = this.subscribeOnce(runId, options?.signal);

    return (async function* () {
      for await (const event of events) {
        if (event.type === "run:update") yield event;
      }
    })();
  }

  /**
   * Delete a run's call traces. The run itself remains. A task is its own
   * run: pass its task ID. Repeat while `complete` is false.
   */
  async purgeCalls(runId: string, options?: { signal?: AbortSignal }): Promise<CallPurgeResponse> {
    const envelope = await this.http.requestJson<CallPurgeResponse>(
      "DELETE",
      `/runs/${enc(runId)}/calls`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  private subscribeOnce(runId: string, signal?: AbortSignal, idleTimeoutMs?: number) {
    return consumeSseResponse(async () => {
      return this.http.requestRaw("GET", `/runs/${enc(runId)}/subscribe`, {
        headers: { Accept: "text/event-stream" },
        signal,
      });
    }, { signal, idleTimeoutMs });
  }

  /**
   * Wait for a run's terminal snapshot. Resolves with a `succeeded` run and
   * throws `HotRunError` for `failed`, `cancelled` and `pending_retry` (the run
   * failed; its retry is a new run whose `origin_run_id` is this run's ID).
   * Reconnects with backoff on transient errors; stops on permanent ones.
   */
  async wait(runId: string, options?: WaitForRunOptions): Promise<RunRecord> {
    return waitForSnapshot<RunRecord>({
      open: (signal) => this.subscribeOnce(runId, signal, STREAM_IDLE_TIMEOUT_MS),
      snapshot: (event) => (event.type === "run:update" ? event.run : undefined),
      settle: (run) => {
        if (run.status === "succeeded") return { done: run };
        if (["failed", "cancelled", "pending_retry"].includes(run.status)) {
          return { failed: new HotRunError(run) };
        }
        return undefined;
      },
      timeoutMs: options?.timeoutMs ?? 60_000,
      maxReconnectAttempts: options?.maxReconnectAttempts,
      signal: options?.signal,
      timeoutMessage: "Timeout waiting for run",
      exhaustedMessage: "Run subscription ended before the run completed",
    });
  }
}
