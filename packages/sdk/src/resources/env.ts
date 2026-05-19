import type { HttpClient } from "../http.js";
import type { EnvInfo, EnvSubscriptionEvent } from "../types.js";
import { consumeSseResponse } from "../streaming/sse.js";

export class EnvResource {
  constructor(private readonly http: HttpClient) {}

  async get(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<EnvInfo>("GET", "/env", {
      signal: options?.signal,
    });
    return envelope.data;
  }

  subscribe(options?: { signal?: AbortSignal }): AsyncGenerator<EnvSubscriptionEvent, void, undefined> {
    return consumeSseResponse(async () => {
      return this.http.requestRaw("GET", "/env/subscribe", {
        headers: { Accept: "text/event-stream" },
        signal: options?.signal,
      });
    }, options) as unknown as AsyncGenerator<EnvSubscriptionEvent, void, undefined>;
  }
}
