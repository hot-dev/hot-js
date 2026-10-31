import type { HttpClient } from "../http.js";
import { followStream, RunCorrelator, STREAM_IDLE_TIMEOUT_MS } from "../streaming/durable.js";
import { waitForCorrelatedRun, type WaitForRunOptions } from "../streaming/wait.js";
import { StreamsResource } from "./streams.js";
import type { EventRecord, ListQuery, PublishEventRequest, RunRecord } from "../types.js";

export class EventsResource {
  private readonly streams: StreamsResource;

  constructor(private readonly http: HttpClient) {
    this.streams = new StreamsResource(http);
  }

  async publish(body: PublishEventRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<EventRecord>("POST", "/events", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<EventRecord>("GET", "/events", {
      query,
      signal: options?.signal,
    });
  }

  async get(eventId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<EventRecord>("GET", `/events/${eventId}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async getRuns(eventId: string, options?: { signal?: AbortSignal }) {
    return this.http.requestList<RunRecord>("GET", `/events/${eventId}/runs`, {
      signal: options?.signal,
    });
  }

  /**
   * Publish a `hot:call` event and wait for the matching run result.
   *
   * Reconnects across the server's 5-minute stream limit and follows a
   * `pending_retry` attempt to its retry run. `onChunk` receives the `text`
   * of each `stream:data` payload in order, including chunks that arrive
   * before `run:start`.
   */
  async callHot(
    fn: string,
    args: unknown[] = [],
    options?: WaitForRunOptions,
  ): Promise<unknown> {
    const run = await waitForCorrelatedRun(
      (signal, reconnector, correlator) => followStream({
        signal,
        open: (connection) => this.streams.subscribeWithEventOnce(
          { event_type: "hot:call", event_data: { fn, args } },
          { signal: connection },
          STREAM_IDLE_TIMEOUT_MS,
        ),
        reopen: (streamId, connection) =>
          this.streams.subscribeOnce(streamId, { signal: connection }, STREAM_IDLE_TIMEOUT_MS),
        correlator,
        reconnector,
        retryOpen: true,
      }),
      new RunCorrelator(),
      "Timeout waiting for run result",
      options,
    );
    return extractRunResult(run.result);
  }
}

function extractRunResult(result: unknown): unknown {
  if (result && typeof result === "object" && "$ok" in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>).$ok;
  }
  return result ?? null;
}
