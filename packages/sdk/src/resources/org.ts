import type { HttpClient } from "../http.js";
import type { OrgUsage } from "../types.js";

export class OrgResource {
  constructor(private readonly http: HttpClient) {}

  async usage(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<OrgUsage>("GET", "/org/usage", {
      signal: options?.signal,
    });
    return envelope.data;
  }
}
