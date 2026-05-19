import type { HttpClient } from "../http.js";
import { waitForRunResult } from "../streaming/wait.js";
import type { EventRecord, ListQuery, PublishEventRequest, RunRecord } from "../types.js";

export class EventsResource {
  constructor(private readonly http: HttpClient) {}

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

  /** Publish a `hot:call` event and wait for the matching run result. */
  async callHot(
    fn: string,
    args: unknown[] = [],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const published = await this.publish({
      event_type: "hot:call",
      event_data: { fn, args },
    }, options);

    const run = await waitForRunResult(this.http, published.stream_id, published.event_id, options);
    return extractRunResult(run.result);
  }
}

function extractRunResult(result: unknown): unknown {
  if (result && typeof result === "object" && "$ok" in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>).$ok;
  }
  return result ?? null;
}
