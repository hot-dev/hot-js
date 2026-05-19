import type { HotClient } from "../client.js";
import { isHotApiError } from "../errors.js";
import type { SubscribeWithEventRequest } from "../types.js";

export interface ProxyRequestBody {
  event_type?: string;
  eventType?: string;
  event_data?: unknown;
  eventData?: unknown;
  stream_id?: string;
  streamId?: string;
}

export interface CreateHotProxyOptions {
  /** Called when HOT_API_KEY (or equivalent) is missing. */
  onMissingToken?: () => Response;
}

/**
 * Create a fetch-compatible handler that proxies `{ eventType, eventData }`
 * bodies to Hot's `/v1/streams/subscribe-with-event` and pipes SSE back.
 *
 * Intended for Next.js App Router route handlers and similar BFF layers.
 */
export function createHotProxyHandler(
  hot: HotClient,
  options?: CreateHotProxyOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (!hot.token) {
      if (options?.onMissingToken) return options.onMissingToken();
      return new Response(JSON.stringify({ error: "Hot API token is not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: ProxyRequestBody;
    try {
      body = await request.json() as ProxyRequestBody;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const eventType = body.event_type ?? body.eventType;
    const eventData = body.event_data ?? body.eventData ?? {};
    const streamId = body.stream_id ?? body.streamId;

    if (!eventType || typeof eventType !== "string") {
      return new Response(JSON.stringify({ error: "event_type is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let upstream: Response;
    try {
      upstream = await hot.http.requestRaw("POST", "/streams/subscribe-with-event", {
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: eventType,
          event_data: eventData,
          ...(streamId ? { stream_id: streamId } : {}),
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (isHotApiError(error)) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: error.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to reach Hot runtime",
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!upstream.body) {
      return new Response(JSON.stringify({ error: "Upstream returned no body" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

/** Normalize a proxy request body to Hot's subscribe-with-event shape. */
export function normalizeProxyBody(body: ProxyRequestBody): SubscribeWithEventRequest {
  const eventType = body.event_type ?? body.eventType;
  if (!eventType) {
    throw new Error("event_type is required");
  }

  return {
    event_type: eventType,
    event_data: body.event_data ?? body.eventData ?? {},
    stream_id: body.stream_id ?? body.streamId,
  };
}

export { createHotProxyHandler as createHotProxyRoute };
