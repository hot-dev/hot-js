import type { HttpClient } from "../http.js";
import type { RunListQuery, RunRecord, RunStats } from "../types.js";

export class RunsResource {
  constructor(private readonly http: HttpClient) {}

  async list(query?: RunListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<RunRecord>("GET", "/runs", {
      query,
      signal: options?.signal,
    });
  }

  async stats(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<RunStats>("GET", "/runs/stats", {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async get(runId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<RunRecord>("GET", `/runs/${runId}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }
}
