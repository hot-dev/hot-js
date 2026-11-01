import type { HttpClient } from "../http.js";
import type {
  AccountUsage,
  ApiKeyRecord,
  CallPurgeResponse,
  CreateApiKeyRequest,
  CreateEnvRequest,
  CreateOrgRequest,
  CreateOrgResponse,
  ListQuery,
  OrgEnvRecord,
  OrgRecord,
  PurgeOrgCallsQuery,
  RotateApiKeyRequest,
  UpdateApiKeyRequest,
  UpdateOrgRequest,
} from "../types.js";
import { BuildsResource } from "./builds.js";
import { ContextResource } from "./context.js";
import { ProjectsResource } from "./projects.js";

const enc = encodeURIComponent;

/**
 * Organizations, environments and API keys (`/v1/orgs`). These routes accept
 * only an org API key; other credentials get `HotKeyScopeError` with
 * `requiredScope: "org"`. An org key calls no runtime routes: mint an
 * environment key for those.
 */
export class OrgsResource {
  constructor(private readonly http: HttpClient) {}

  /** Sub-organizations of the key's organization that the key may read. */
  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<OrgRecord>("GET", "/orgs", {
      query,
      signal: options?.signal,
    });
  }

  /**
   * Provision a sub-organization and its default environment. Replaying the
   * same `idempotency_key` returns the existing sub-organization with `created: false`.
   */
  async create(body: CreateOrgRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<CreateOrgResponse>("POST", "/orgs", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async get(orgId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<OrgRecord>("GET", `/orgs/${enc(orgId)}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  /** Change a sub-organization's lifecycle state (`active`, `suspended` or `archived`). */
  async update(orgId: string, body: UpdateOrgRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<OrgRecord>("PATCH", `/orgs/${enc(orgId)}`, {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  /** Account usage across the parent organization and every sub-organization; pass the parent organization's ID. */
  async usage(parentOrgId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<AccountUsage>(
      "GET",
      `/orgs/${enc(parentOrgId)}/usage`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  /**
   * Delete every call trace in an organization's environments (and its
   * sub-organizations' with `include_sub_orgs`). Repeat while `complete` is false.
   */
  async purgeCalls(orgId: string, query?: PurgeOrgCallsQuery, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<CallPurgeResponse>(
      "DELETE",
      `/orgs/${enc(orgId)}/calls`,
      { query, signal: options?.signal },
    );
    return envelope.data;
  }

  async listEnvs(orgId: string, options?: { signal?: AbortSignal }) {
    return this.http.requestList<OrgEnvRecord>("GET", `/orgs/${enc(orgId)}/envs`, {
      signal: options?.signal,
    });
  }

  /** Create an environment; idempotent by exact name within the organization. */
  async createEnv(orgId: string, body: CreateEnvRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<OrgEnvRecord>("POST", `/orgs/${enc(orgId)}/envs`, {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async getEnv(orgId: string, envId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<OrgEnvRecord>(
      "GET",
      `/orgs/${enc(orgId)}/envs/${enc(envId)}`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  /** Org API keys of the key's own organization. */
  async listApiKeys(orgId: string, query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<ApiKeyRecord>("GET", `/orgs/${enc(orgId)}/api-keys`, {
      query,
      signal: options?.signal,
    });
  }

  /** Mint an org API key in the key's own organization; `token` is returned once. */
  async createApiKey(orgId: string, body: CreateApiKeyRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ApiKeyRecord>(
      "POST",
      `/orgs/${enc(orgId)}/api-keys`,
      { body: JSON.stringify(body), signal: options?.signal },
    );
    return envelope.data;
  }

  async listEnvApiKeys(
    orgId: string,
    envId: string,
    query?: ListQuery,
    options?: { signal?: AbortSignal },
  ) {
    return this.http.requestList<ApiKeyRecord>(
      "GET",
      `/orgs/${enc(orgId)}/envs/${enc(envId)}/api-keys`,
      { query, signal: options?.signal },
    );
  }

  /**
   * Mint an environment API key; its grants must fit inside the org key's
   * grants for that environment. `token` is returned once.
   */
  async createEnvApiKey(
    orgId: string,
    envId: string,
    body: CreateApiKeyRequest,
    options?: { signal?: AbortSignal },
  ) {
    const envelope = await this.http.requestJson<ApiKeyRecord>(
      "POST",
      `/orgs/${enc(orgId)}/envs/${enc(envId)}/api-keys`,
      { body: JSON.stringify(body), signal: options?.signal },
    );
    return envelope.data;
  }

  /**
   * Project, context and build calls inside one environment, authorized by
   * the org key's grants for it: `hot.orgs.env(org, env).projects.list()`.
   */
  env(orgId: string, envId: string): OrgEnvScope {
    return new OrgEnvScope(this.http, orgId, envId);
  }
}

/** Environment resources reached through an org API key. */
export class OrgEnvScope {
  readonly projects: ProjectsResource;
  readonly builds: BuildsResource;
  readonly context: ContextResource;

  constructor(http: HttpClient, readonly orgId: string, readonly envId: string) {
    const prefix = `/orgs/${enc(orgId)}/envs/${enc(envId)}`;
    this.projects = new ProjectsResource(http, prefix);
    this.builds = new BuildsResource(http, prefix);
    this.context = new ContextResource(http, prefix);
  }
}

/** Org and environment API keys addressed by ID (`/v1/api-keys`). Org API key only. */
export class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  async get(keyId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ApiKeyRecord>("GET", `/api-keys/${enc(keyId)}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  /** Replace a key's grants; they must fit inside the caller's own. */
  async update(keyId: string, body: UpdateApiKeyRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ApiKeyRecord>("PATCH", `/api-keys/${enc(keyId)}`, {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  /** Revoke a key. Everything it issued stops on its next request. */
  async revoke(keyId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestVoid("DELETE", `/api-keys/${enc(keyId)}`, {
      signal: options?.signal,
    });
  }

  /**
   * Issue a new secret for the same key. The previous secret keeps working for
   * `overlap_seconds` (default one day).
   */
  async rotate(keyId: string, body?: RotateApiKeyRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ApiKeyRecord>(
      "POST",
      `/api-keys/${enc(keyId)}/rotate`,
      { body: JSON.stringify(body ?? {}), signal: options?.signal },
    );
    return envelope.data;
  }
}
