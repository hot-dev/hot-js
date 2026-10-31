import type { HttpClient } from "../http.js";
import type {
  CallPurgeResponse,
  SubscribeWithEventParams,
  SubscribeWithEventRequest,
} from "../types.js";
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  followStream,
  Reconnector,
  RunCorrelator,
  STREAM_IDLE_TIMEOUT_MS,
} from "../streaming/durable.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type { StreamEvent } from "../streaming/types.js";

const enc = encodeURIComponent;

/**
 * Options for the auto-reconnect behavior of `subscribeWithEvent`.
 *
 * The Hot API closes every SSE subscription 5 minutes after it opens (with a
 * `stream:complete` event), whatever the run state. When `reconnect` is
 * enabled (the default), the SDK resubscribes to the same `stream_id` and
 * continues yielding events until the published event's run ends.
 *
 * On reconnect the server replays run lifecycle events (`run:start`,
 * `run:stop`, `run:fail`, `run:cancel`) — these are deduped client-side by
 * `run_id`. `stream:data` chunks are *not* replayed and may be lost across
 * the disconnect window.
 *
 * Permanent errors (4xx other than 408 and 429) stop at once. Transport
 * errors, 408, 429 and 5xx reconnect with jittered exponential backoff that
 * honours `retry_after`.
 */
export interface SubscribeReconnectOptions {
  /**
   * Consecutive failed connections tolerated before giving up. Default 5.
   * Healthy connections, including 5-minute rollovers, reset the count.
   */
  maxAttempts?: number;
}

export interface SubscribeWithEventOptions extends SubscribeWithEventParams {
  signal?: AbortSignal;
  /**
   * Automatically reconnect when the server's 5-minute limit closes the
   * stream before the published event's run ends.
   *
   * - `true` (default) — reconnect using the existing `stream_id`, dedup
   *   `run:*` events by `run_id`, stop after the terminal event of the
   *   event's run (a `run:fail` with status `pending_retry` is not terminal:
   *   the iterator follows the retry run).
   * - `false` — return after the single connection ends, as in 1.0.x.
   * - Object — reconnect with custom options.
   */
  reconnect?: boolean | SubscribeReconnectOptions;
}

export class StreamsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Subscribe to an existing stream (GET SSE). The server ends the
   * subscription after 5 minutes with `stream:complete`; this iterator then
   * ends too. To wait for work on the stream, use `runs.wait` or `tasks.wait`.
   */
  subscribe(
    streamId: string,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    return this.subscribeOnce(streamId, options);
  }

  /** Subscribe to an existing stream via POST (Streamable HTTP SSE). */
  subscribePost(
    streamId: string,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const { project, signal } = options ?? {};
    return consumeSseResponse(async () => {
      return this.http.requestRaw("POST", `/streams/${enc(streamId)}/subscribe`, {
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
   * Reconnects across the server's 5-minute limit by default. Pass
   * `{ reconnect: false }` for the 1.0.x single-connection behavior.
   */
  subscribeWithEvent(
    body: SubscribeWithEventRequest,
    options?: SubscribeWithEventOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    if (options?.reconnect === false) {
      return this.subscribeWithEventOnce(body, options);
    }
    const maxAttempts =
      (typeof options?.reconnect === "object" ? options.reconnect.maxAttempts : undefined)
      ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    return followStream({
      open: () => this.subscribeWithEventOnce(body, options, STREAM_IDLE_TIMEOUT_MS),
      reopen: (streamId) => this.subscribeOnce(streamId, options, STREAM_IDLE_TIMEOUT_MS),
      correlator: new RunCorrelator(),
      reconnector: new Reconnector({
        maxAttempts,
        signal: options?.signal,
        timeoutMessage: "Timeout waiting for the published event's run",
        exhaustedMessage: "stream ended before the published event's run completed",
      }),
      retryOpen: true,
    });
  }

  /**
   * Delete the call traces of every run in a stream, including the tasks
   * those runs started. Runs remain. Repeat while `complete` is false.
   */
  async purgeCalls(streamId: string, options?: { signal?: AbortSignal }): Promise<CallPurgeResponse> {
    const envelope = await this.http.requestJson<CallPurgeResponse>(
      "DELETE",
      `/streams/${enc(streamId)}/calls`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  /** @internal Open one stream connection; used by the durable helpers. */
  subscribeOnce(
    streamId: string,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
    idleTimeoutMs?: number,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const { project, signal } = options ?? {};
    return consumeSseResponse(async () => {
      return this.http.requestRaw("GET", `/streams/${enc(streamId)}/subscribe`, {
        query: project ? { project } : undefined,
        headers: { Accept: "text/event-stream" },
        signal,
      });
    }, { signal, idleTimeoutMs });
  }

  /** @internal Open one subscribe-with-event connection. */
  subscribeWithEventOnce(
    body: SubscribeWithEventRequest,
    options?: SubscribeWithEventParams & { signal?: AbortSignal },
    idleTimeoutMs?: number,
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
    }, { signal, idleTimeoutMs });
  }
}
