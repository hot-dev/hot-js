import type { HotClient } from "../client.js";
import { isHotApiError } from "../errors.js";
import { RunCorrelator } from "../streaming/durable.js";
import { isRunTerminalEvent, toStreamEvent } from "../streaming/types.js";
import type { SubscribeWithEventRequest } from "../types.js";

export interface ProxyRequestBody {
  event_type?: string;
  eventType?: string;
  event_data?: unknown;
  eventData?: unknown;
  stream_id?: string;
  streamId?: string;
}

/** A browser request after normalization, as `authorize` sees it. */
export interface ProxyEvent {
  event_type: string;
  event_data: unknown;
  /** Present only when `allowStreamId` accepted the browser's stream ID. */
  stream_id?: string;
}

/**
 * Which event types browsers may publish through the proxy. An array lists
 * exact types or prefix patterns ending in `*` (`"chat:*"`). A predicate
 * decides for each type. Either way, a `hot:`-prefixed type such as
 * `hot:call` (which runs any function) is allowed only when an array lists
 * it exactly.
 */
export type ProxyEventTypePolicy =
  | readonly string[]
  | ((eventType: string, request: Request) => boolean);

/**
 * Authorize one proxied request. Return `true` to send it as is, a
 * `ProxyEvent` to send that instead (for example with the signed-in user's
 * ID put into `event_data`), or a `Response` to answer the browser yourself.
 * Anything else (including `false` or `undefined`) answers 403.
 */
export type ProxyAuthorize = (
  request: Request,
  event: ProxyEvent,
) => boolean | ProxyEvent | Response | undefined | Promise<boolean | ProxyEvent | Response | undefined>;

export interface CreateHotProxyOptions {
  /** Required. Event types browsers may publish; see `ProxyEventTypePolicy`. */
  allowEventTypes: ProxyEventTypePolicy;
  /** Check the caller (session, CSRF, rate limit) and optionally rewrite the event. */
  authorize?: ProxyAuthorize;
  /**
   * Accept a browser-supplied `stream_id` to continue an existing stream.
   * Default `false`: the ID is ignored and every request starts a new stream.
   * Enable it only when `authorize` (or the predicate) checks that the caller
   * owns the stream. Events on a continued stream are filtered to the runs of
   * the event this request published.
   */
  allowStreamId?: boolean | ((streamId: string, request: Request) => boolean | Promise<boolean>);
  /** Called when HOT_API_KEY (or equivalent) is missing. */
  onMissingToken?: () => Response;
}

/** The client a request is proxied with, or a function choosing it per request. */
export type HotProxyClient = HotClient | ((request: Request) => HotClient | Promise<HotClient>);

/**
 * Create a fetch-compatible handler that proxies `{ eventType, eventData }`
 * bodies to Hot's `/v1/streams/subscribe-with-event` and pipes SSE back.
 *
 * Intended for Next.js App Router route handlers and similar BFF layers. The
 * handler publishes with the server-side credential of the client you pass,
 * so it only publishes the event types `allowEventTypes` allows. Prefer a
 * per-user credential: a session or service key scoped to the events and
 * streams that user may use, returned by a client function.
 */
export function createHotProxyHandler(
  hot: HotProxyClient,
  options: CreateHotProxyOptions,
): (request: Request) => Promise<Response> {
  if (!options || !options.allowEventTypes) {
    throw new TypeError(
      "createHotProxyHandler requires options.allowEventTypes: list the event types browsers may publish",
    );
  }
  const allowed = eventTypeMatcher(options.allowEventTypes);

  return async (request: Request): Promise<Response> => {
    let body: ProxyRequestBody;
    try {
      body = await request.json() as ProxyRequestBody;
    } catch {
      return jsonError(400, "Invalid JSON body");
    }
    if (typeof body !== "object" || body === null) return jsonError(400, "Invalid JSON body");

    const eventType = body.event_type ?? body.eventType;
    if (!eventType || typeof eventType !== "string") {
      return jsonError(400, "event_type is required");
    }
    if (!allowed(eventType, request)) {
      return jsonError(403, "event_type is not allowed");
    }

    let event: ProxyEvent = {
      event_type: eventType,
      event_data: body.event_data ?? body.eventData ?? {},
    };
    const streamId = body.stream_id ?? body.streamId;
    if (streamId !== undefined) {
      if (typeof streamId !== "string" || !await streamIdAllowed(options.allowStreamId, streamId, request)) {
        if (options.allowStreamId) return jsonError(403, "stream_id is not allowed");
      } else {
        event.stream_id = streamId;
      }
    }

    if (options.authorize) {
      const decision = await options.authorize(request, event);
      if (decision instanceof Response) return decision;
      if (decision === true) {
        // send as is
      } else if (isProxyEvent(decision)) {
        if (!allowed(decision.event_type, request)) return jsonError(403, "event_type is not allowed");
        event = decision;
      } else {
        return jsonError(403, "Forbidden");
      }
    }

    const client = typeof hot === "function" ? await hot(request) : hot;
    if (!client.token) {
      if (options.onMissingToken) return options.onMissingToken();
      return jsonError(500, "Hot API token is not configured");
    }

    let upstream: Response;
    try {
      upstream = await client.http.requestRaw("POST", "/streams/subscribe-with-event", {
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: event.event_type,
          event_data: event.event_data,
          ...(event.stream_id ? { stream_id: event.stream_id } : {}),
        }),
        signal: request.signal,
      });
    } catch (error) {
      if (isHotApiError(error)) {
        return jsonError(error.status, error.message);
      }
      return jsonError(502, error instanceof Error ? error.message : "Failed to reach Hot runtime");
    }

    if (!upstream.body) {
      return jsonError(502, "Upstream returned no body");
    }

    // A new stream holds only what this request started; a continued stream
    // may carry other requests' runs, so it is filtered to this event's runs.
    const responseBody = event.stream_id
      ? upstream.body.pipeThrough(publishedEventFilter())
      : upstream.body;

    return new Response(responseBody, {
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

const RESERVED_PREFIX = "hot:";
const MAX_HELD_BLOCKS = 1_000;

function eventTypeMatcher(policy: ProxyEventTypePolicy): (eventType: string, request: Request) => boolean {
  if (typeof policy === "function") {
    return (eventType, request) => !eventType.startsWith(RESERVED_PREFIX) && policy(eventType, request) === true;
  }
  if (!Array.isArray(policy)) {
    throw new TypeError("allowEventTypes must be an array of event types or a predicate");
  }
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of policy) {
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else exact.add(entry);
  }
  return (eventType) => exact.has(eventType)
    || (!eventType.startsWith(RESERVED_PREFIX) && prefixes.some((prefix) => eventType.startsWith(prefix)));
}

async function streamIdAllowed(
  policy: CreateHotProxyOptions["allowStreamId"],
  streamId: string,
  request: Request,
): Promise<boolean> {
  if (typeof policy === "function") return await policy(streamId, request) === true;
  return policy === true;
}

function isProxyEvent(value: unknown): value is ProxyEvent {
  return typeof value === "object"
    && value !== null
    && typeof (value as { event_type?: unknown }).event_type === "string";
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Pass through only the SSE blocks that belong to the event this request
 * published: `event:published`, the lifecycle events of its runs (and their
 * retries), their `stream:data` (held until the run is identified, because it
 * can precede `run:start`), their tasks' `task:update`, `stream:complete` and
 * keepalive comments.
 */
function publishedEventFilter(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const correlator = new RunCorrelator();
  // stream:data blocks of runs not yet identified, bounded like the SDK's own buffer.
  const held = new Map<string, string[]>();
  let heldCount = 0;
  let buffer = "";

  const decide = (block: string): string[] => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("");
    if (!data) return [block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
    const event = toStreamEvent(parsed);
    if (!event) return [];
    switch (event.type) {
      case "event:published":
        if (correlator.eventId === undefined) correlator.eventId = event.event_id;
        return [block];
      case "stream:complete":
      case "keepalive":
        return [block];
      case "stream:data": {
        const runId = event.run_id;
        if (!runId) return [];
        if (correlator.isCorrelated(runId)) return [block];
        const queue = held.get(runId) ?? [];
        queue.push(block);
        held.set(runId, queue);
        if (++heldCount > MAX_HELD_BLOCKS) {
          const [oldest, blocks] = held.entries().next().value as [string, string[]];
          blocks.shift();
          heldCount -= 1;
          if (blocks.length === 0) held.delete(oldest);
        }
        return [];
      }
      case "task:update": {
        const origin = event.task.origin_run_id ?? event.task.run_id ?? undefined;
        return correlator.isCorrelated(origin ?? undefined) ? [block] : [];
      }
      default: {
        if (event.type !== "run:start" && !isRunTerminalEvent(event)) return [];
        if (!correlator.correlate(event.run)) return [];
        const runId = event.run!.run_id;
        correlator.endsWait(event);
        const chunks = held.get(runId) ?? [];
        held.delete(runId);
        heldCount -= chunks.length;
        return [...chunks, block];
      }
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const out of decide(block)) controller.enqueue(encoder.encode(`${out}\n\n`));
        idx = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const out of decide(buffer)) controller.enqueue(encoder.encode(`${out}\n\n`));
      }
    },
  });
}
