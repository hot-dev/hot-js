import type { HttpClient } from "../http.js";
import type {
  ContextVariableRecord,
  CreateContextVariableRequest,
  UpdateContextVariableRequest,
} from "../types.js";

const enc = encodeURIComponent;

export class ContextResource {
  constructor(private readonly http: HttpClient) {}

  async list(project: string, options?: { signal?: AbortSignal }) {
    return this.http.requestList<ContextVariableRecord>(
      "GET",
      `/projects/${enc(project)}/context`,
      { signal: options?.signal },
    );
  }

  async create(
    project: string,
    body: CreateContextVariableRequest,
    options?: { signal?: AbortSignal },
  ) {
    const envelope = await this.http.requestJson<ContextVariableRecord>(
      "POST",
      `/projects/${enc(project)}/context`,
      {
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    return envelope.data;
  }

  async update(
    project: string,
    key: string,
    body: UpdateContextVariableRequest,
    options?: { signal?: AbortSignal },
  ) {
    const envelope = await this.http.requestJson<ContextVariableRecord>(
      "PUT",
      `/projects/${enc(project)}/context/${enc(key)}`,
      {
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    return envelope.data;
  }

  async delete(project: string, key: string, options?: { signal?: AbortSignal }) {
    await this.http.requestRaw("DELETE", `/projects/${enc(project)}/context/${enc(key)}`, {
      signal: options?.signal,
    });
  }
}
