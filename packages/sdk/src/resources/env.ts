import type { HttpClient } from "../http.js";
import type { CallPurgeResponse, EnvInfo, EnvSubscriptionEvent } from "../types.js";
import { readSse } from "../streaming/sse.js";

const KNOWN_ENV_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run:start",
  "run:stop",
  "run:fail",
  "run:cancel",
  "event:created",
  "event:handled",
  "stream:created",
  "task:started",
  "task:complete",
  "keepalive",
]);

/** Known environment events pass through; others are wrapped as `{ type: "unknown" }`. */
function toEnvEvent(value: unknown): EnvSubscriptionEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  if (KNOWN_ENV_EVENT_TYPES.has(type)) return value as EnvSubscriptionEvent;
  return { type: "unknown", event_type: type, data: value as Record<string, unknown> };
}

export class EnvResource {
  constructor(private readonly http: HttpClient) {}

  async get(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<EnvInfo>("GET", "/env", {
      signal: options?.signal,
    });
    return envelope.data;
  }

  subscribe(options?: { signal?: AbortSignal }): AsyncGenerator<EnvSubscriptionEvent, void, undefined> {
    return readSse(async () => {
      return this.http.requestRaw("GET", "/env/subscribe", {
        headers: { Accept: "text/event-stream" },
        signal: options?.signal,
      });
    }, toEnvEvent, options);
  }

  /**
   * Delete every call trace in the environment (`call:*` with `delete`). Runs
   * remain. Repeat while `complete` is false.
   */
  async purgeCalls(options?: { signal?: AbortSignal }): Promise<CallPurgeResponse> {
    const envelope = await this.http.requestJson<CallPurgeResponse>("DELETE", "/env/calls", {
      signal: options?.signal,
    });
    return envelope.data;
  }
}
