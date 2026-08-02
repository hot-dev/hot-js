import type { HttpClient } from "../http.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type { RunUpdateEvent } from "../streaming/types.js";
import { mergeAbortSignals, runResultMessage } from "../streaming/wait.js";
import type { RunListQuery, RunRecord, RunStats } from "../types.js";

export interface WaitForRunOptions {
  timeoutMs?: number;
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
    const events = consumeSseResponse(async () => {
      return this.http.requestRaw("GET", `/runs/${runId}/subscribe`, {
        headers: { Accept: "text/event-stream" },
        signal: options?.signal,
      });
    }, { signal: options?.signal });

    return (async function* () {
      for await (const event of events) {
        if (event.type === "run:update") yield event as RunUpdateEvent;
      }
    })();
  }

  async wait(runId: string, options?: WaitForRunOptions): Promise<RunRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Timeout waiting for run")),
      options?.timeoutMs ?? 60_000,
    );
    const signal = mergeAbortSignals([options?.signal, controller.signal]);
    let reconnectAttempts = 0;

    try {
      while (true) {
        try {
          for await (const event of this.subscribe(runId, { signal })) {
            const run = event.run;
            if (run.status === "succeeded") return run;
            if (["failed", "cancelled"].includes(run.status)) {
              throw new HotRunError(run);
            }
          }
        } catch (error) {
          if (error instanceof HotRunError || signal.aborted) throw error;
          if (reconnectAttempts >= (options?.maxReconnectAttempts ?? 5)) throw error;
        }
        if (reconnectAttempts >= (options?.maxReconnectAttempts ?? 5)) {
          throw new Error("Run subscription ended before the run completed");
        }
        reconnectAttempts += 1;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
