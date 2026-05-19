import type { HttpClient } from "../http.js";
import type {
  SubscribeWithEventParams,
  SubscribeWithEventRequest,
} from "../types.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type { StreamEvent } from "../streaming/types.js";

export class StreamsResource {
  constructor(private readonly http: HttpClient) {}

  /** Subscribe to an existing stream (GET SSE). */
  subscribe(
    streamId: string,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const { project, signal } = options ?? {};
    return consumeSseResponse(async () => {
      return this.http.requestRaw("GET", `/streams/${streamId}/subscribe`, {
        query: project ? { project } : undefined,
        headers: { Accept: "text/event-stream" },
        signal,
      });
    }, { signal });
  }

  /** Subscribe to an existing stream via POST (Streamable HTTP SSE). */
  subscribePost(
    streamId: string,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const { project, signal } = options ?? {};
    return consumeSseResponse(async () => {
      return this.http.requestRaw("POST", `/streams/${streamId}/subscribe`, {
        query: project ? { project } : undefined,
        headers: { Accept: "text/event-stream" },
        signal,
      });
    }, { signal });
  }

  /**
   * Atomically subscribe then publish an event (POST SSE).
   * Recommended for agent/chat clients — eliminates publish-then-subscribe races.
   */
  subscribeWithEvent(
    body: SubscribeWithEventRequest,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const { project, signal } = options ?? {};
    return consumeSseResponse(async () => {
      return this.http.requestRaw("POST", "/streams/subscribe-with-event", {
        query: project ? { project } : undefined,
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    }, { signal });
  }
}
