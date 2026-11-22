import type { HttpClient } from "../http.js";
import { enc } from "../path.js";
import type {
  ApiListResponse,
  CreateDomainRequest,
  DomainRecord,
  DomainVerifyResponse,
  ListQuery,
} from "../types.js";
import { splitListArgs, type SignalOptions } from "./list-args.js";

export class DomainsResource {
  constructor(private readonly http: HttpClient) {}

  async create(body: CreateDomainRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<DomainRecord>("POST", "/domains", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async list(query?: ListQuery, options?: SignalOptions): Promise<ApiListResponse<DomainRecord>>;
  async list(options?: SignalOptions): Promise<ApiListResponse<DomainRecord>>;
  async list(
    queryOrOptions?: ListQuery | SignalOptions,
    options?: SignalOptions,
  ): Promise<ApiListResponse<DomainRecord>> {
    const { query, signal } = splitListArgs(queryOrOptions, options);
    return this.http.requestList<DomainRecord>("GET", "/domains", { query, signal });
  }

  async get(domainId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<DomainRecord>("GET", `/domains/${enc(domainId)}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async delete(domainId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestVoid("DELETE", `/domains/${enc(domainId)}`, {
      signal: options?.signal,
    });
  }

  async verify(domainId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<DomainVerifyResponse>(
      "POST",
      `/domains/${enc(domainId)}/verify`,
      { signal: options?.signal },
    );
    return envelope.data;
  }
}
