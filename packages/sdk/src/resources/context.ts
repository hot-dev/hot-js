import type { HttpClient } from "../http.js";
import { enc } from "../path.js";
import type {
  ApiListResponse,
  ContextVariableRecord,
  CreateContextVariableRequest,
  ListQuery,
  UpdateContextVariableRequest,
} from "../types.js";
import { splitListArgs, type SignalOptions } from "./list-args.js";

export class ContextResource {
  /**
   * @param prefix Path prefix inside `/v1`; `hot.orgs.env(org, env)` sets it to
   * `/orgs/{org}/envs/{env}` for an org API key.
   */
  constructor(private readonly http: HttpClient, private readonly prefix = "") {}

  async list(
    project: string,
    query?: ListQuery,
    options?: SignalOptions,
  ): Promise<ApiListResponse<ContextVariableRecord>>;
  async list(
    project: string,
    options?: SignalOptions,
  ): Promise<ApiListResponse<ContextVariableRecord>>;
  async list(
    project: string,
    queryOrOptions?: ListQuery | SignalOptions,
    options?: SignalOptions,
  ): Promise<ApiListResponse<ContextVariableRecord>> {
    const { query, signal } = splitListArgs(queryOrOptions, options);
    return this.http.requestList<ContextVariableRecord>(
      "GET",
      `${this.prefix}/projects/${enc(project)}/context`,
      { query, signal },
    );
  }

  async create(
    project: string,
    body: CreateContextVariableRequest,
    options?: { signal?: AbortSignal },
  ) {
    const envelope = await this.http.requestJson<ContextVariableRecord>(
      "POST",
      `${this.prefix}/projects/${enc(project)}/context`,
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
      `${this.prefix}/projects/${enc(project)}/context/${enc(key)}`,
      {
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    return envelope.data;
  }

  async delete(project: string, key: string, options?: { signal?: AbortSignal }) {
    await this.http.requestVoid("DELETE", `${this.prefix}/projects/${enc(project)}/context/${enc(key)}`, {
      signal: options?.signal,
    });
  }
}
