import type { HttpClient } from "../http.js";
import type {
  CreateSessionRequest,
  ListQuery,
  RevokeAllResponse,
  SessionRecord,
} from "../types.js";

const enc = encodeURIComponent;

export class SessionsResource {
  constructor(private readonly http: HttpClient) {}

  async create(body: CreateSessionRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<SessionRecord>("POST", "/sessions", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<SessionRecord>("GET", "/sessions", {
      query,
      signal: options?.signal,
    });
  }

  async revoke(sessionId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestRaw("DELETE", `/sessions/${enc(sessionId)}`, {
      signal: options?.signal,
    });
  }

  async revokeAll(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<RevokeAllResponse>("DELETE", "/sessions", {
      signal: options?.signal,
    });
    return envelope.data;
  }
}
