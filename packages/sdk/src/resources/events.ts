import type { HttpClient } from "../http.js";
import { mergeAbortSignals, runResultMessage } from "../streaming/wait.js";
import { StreamsResource } from "./streams.js";
import type {
  EventPublishedEvent,
  RunCancelEvent,
  RunFailEvent,
  RunStartEvent,
  RunStopEvent,
  StreamDataEvent,
} from "../streaming/types.js";
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

  /** Publish a `hot:call` event and wait for the matching run result. */
  async callHot(
    fn: string,
    args: unknown[] = [],
    options?: { timeoutMs?: number; signal?: AbortSignal; onChunk?: (text: string) => void },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Timeout waiting for run result")),
      options?.timeoutMs ?? 60_000,
    );
    const signal = mergeAbortSignals([options?.signal, controller.signal]);
    let eventId: string | undefined;
    let runId: string | undefined;

    try {
      for await (const event of this.streams.subscribeWithEvent({
        event_type: "hot:call",
        event_data: { fn, args },
      }, { signal })) {
        if (event.type === "event:published") {
          eventId = (event as EventPublishedEvent).event_id;
        } else if (event.type === "run:start") {
          const run = (event as RunStartEvent).run;
          if (run && eventId && run.event_id === eventId) runId = run.run_id;
        } else if (event.type === "stream:data") {
          const data = event as StreamDataEvent;
          const text = data.payload?.text;
          if (data.run_id === runId && typeof text === "string") options?.onChunk?.(text);
        } else if (event.type === "run:stop" || event.type === "run:fail" || event.type === "run:cancel") {
          const run = (event as RunStopEvent | RunFailEvent | RunCancelEvent).run;
          if (!run || run.event_id !== eventId) continue;
          if (event.type === "run:fail") throw new Error(runResultMessage(run, "Run failed"));
          if (event.type === "run:cancel") throw new Error(runResultMessage(run, "Run cancelled"));
          return extractRunResult(run.result);
        }
      }
      throw new Error("Stream ended before run completed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractRunResult(result: unknown): unknown {
  if (result && typeof result === "object" && "$ok" in (result as Record<string, unknown>)) {
    return (result as Record<string, unknown>).$ok;
  }
  return result ?? null;
}
