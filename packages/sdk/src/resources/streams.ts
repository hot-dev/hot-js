import type { HttpClient } from "../http.js";
import type {
  SubscribeWithEventParams,
  SubscribeWithEventRequest,
} from "../types.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type {
  EventPublishedEvent,
  RunCancelEvent,
  RunFailEvent,
  RunStartEvent,
  RunStopEvent,
  StreamEvent,
} from "../streaming/types.js";

/**
 * Options for the auto-reconnect behavior of `subscribeWithEvent`.
 *
 * The Hot API closes SSE subscriptions after 5 minutes of idle time regardless
 * of run state. When `reconnect` is enabled (the default), the SDK resubscribes
 * to the same `stream_id` and continues yielding events until a terminal
 * `run:stop`, `run:fail`, or `run:cancel` arrives.
 *
 * On reconnect the server replays run lifecycle events (`run:start`,
 * `run:stop`, `run:fail`, `run:cancel`) — these are deduped client-side by
 * `run_id`. `stream:data` chunks are *not* replayed and may be lost across
 * the disconnect window.
 */
export interface SubscribeReconnectOptions {
  /** Maximum reconnect attempts after unexpected errors. Default 5. */
  maxAttempts?: number;
}

export interface SubscribeWithEventOptions extends SubscribeWithEventParams {
  signal?: AbortSignal;
  /**
   * Automatically reconnect when the server's 5-minute timeout closes the
   * stream before a terminal `run:stop|fail|cancel` arrives.
   *
   * - `true` (default) — reconnect using the existing `stream_id`, dedup
   *   `run:*` events by `run_id`, stop on the first terminal event.
   * - `false` — return after the single connection ends, as in 1.0.x.
   * - Object — reconnect with custom options.
   */
  reconnect?: boolean | SubscribeReconnectOptions;
}

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
   *
   * Reconnects across the server's 5-minute idle timeout by default. Pass
   * `{ reconnect: false }` for the 1.0.x single-connection behavior.
   */
  async *subscribeWithEvent(
    body: SubscribeWithEventRequest,
    options?: SubscribeWithEventOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    if (options?.reconnect === false) {
      yield* this.subscribeWithEventOnce(body, options);
      return;
    }

    const maxAttempts =
      (typeof options?.reconnect === "object" ? options.reconnect.maxAttempts : undefined) ?? 5;
    const seenStart = new Set<string>();
    const seenTerminal = new Set<string>();
    let streamId: string | undefined;
    let eventId: string | undefined;
    let attempts = 0;

    while (true) {
      const iter = streamId
        ? this.subscribe(streamId, { project: options?.project, signal: options?.signal })
        : this.subscribeWithEventOnce(body, options);

      let terminal = false;
      try {
        for await (const event of iter) {
          if (event.type === "event:published") {
            const published = event as EventPublishedEvent;
            if (published.stream_id) streamId = published.stream_id;
            if (published.event_id) eventId = published.event_id;
          }

          if (event.type === "run:start") {
            const runId = (event as RunStartEvent).run?.run_id;
            if (runId && seenStart.has(runId)) continue;
            if (runId) seenStart.add(runId);
          }

          if (
            event.type === "run:stop" ||
            event.type === "run:fail" ||
            event.type === "run:cancel"
          ) {
            const runEvent = event as RunStopEvent | RunFailEvent | RunCancelEvent;
            const runId = runEvent.run?.run_id;
            if (runId && seenTerminal.has(runId)) continue;
            if (runId) seenTerminal.add(runId);
            terminal = Boolean(eventId && runEvent.run?.event_id === eventId);
          }

          yield event;
          if (terminal) return;
        }
      } catch (error) {
        if (!streamId || attempts >= maxAttempts) throw error;
      }

      if (terminal) return;
      if (!streamId) {
        throw new Error("stream ended before event:published was received");
      }
      if (attempts >= maxAttempts) {
        throw new Error("stream ended before the published event's run completed");
      }

      attempts += 1;
      const delay = Math.min(250 * attempts, 2000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private subscribeWithEventOnce(
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
