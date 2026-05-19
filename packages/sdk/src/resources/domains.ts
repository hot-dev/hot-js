import type { HttpClient } from "../http.js";
import type {
  CreateDomainRequest,
  DomainRecord,
  DomainVerifyResponse,
} from "../types.js";

const enc = encodeURIComponent;

export class DomainsResource {
  constructor(private readonly http: HttpClient) {}

  async create(body: CreateDomainRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<DomainRecord>("POST", "/domains", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async list(options?: { signal?: AbortSignal }) {
    return this.http.requestList<DomainRecord>("GET", "/domains", {
      signal: options?.signal,
    });
  }

  async get(domainId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<DomainRecord>("GET", `/domains/${enc(domainId)}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async delete(domainId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestRaw("DELETE", `/domains/${enc(domainId)}`, {
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
