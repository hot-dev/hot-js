import type { HttpClient } from "../http.js";
import type {
  CreateServiceKeyRequest,
  ListQuery,
  RevokeAllServiceKeysResponse,
  ServiceKeyRecord,
  UpdateServiceKeyRequest,
} from "../types.js";

const enc = encodeURIComponent;

export class ServiceKeysResource {
  constructor(private readonly http: HttpClient) {}

  async create(body: CreateServiceKeyRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ServiceKeyRecord>("POST", "/service-keys", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<ServiceKeyRecord>("GET", "/service-keys", {
      query,
      signal: options?.signal,
    });
  }

  async get(serviceKeyId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ServiceKeyRecord>(
      "GET",
      `/service-keys/${enc(serviceKeyId)}`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async update(
    serviceKeyId: string,
    body: UpdateServiceKeyRequest,
    options?: { signal?: AbortSignal },
  ) {
    const envelope = await this.http.requestJson<ServiceKeyRecord>(
      "PATCH",
      `/service-keys/${enc(serviceKeyId)}`,
      {
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    return envelope.data;
  }

  async revoke(serviceKeyId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestRaw("DELETE", `/service-keys/${enc(serviceKeyId)}`, {
      signal: options?.signal,
    });
  }

  async revokeAll(options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<RevokeAllServiceKeysResponse>("DELETE", "/service-keys", {
      signal: options?.signal,
    });
    return envelope.data;
  }
}
