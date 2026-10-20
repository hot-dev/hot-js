import { HttpClient } from "./http.js";
import type { RequestOptions } from "./http.js";
import type { AccountUsage, ChildList, ChildProvisioned, CreateChildRequest,
  CreateEnvironmentRequest, EnvInfo, HotManagementClientOptions, IssueRuntimeKeyRequest,
  IssuedRuntimeKey, ListQuery, OrgLifecycle } from "./types.js";

/** Root control-plane client. Requires an hm_ management credential issued by a root admin.
 * Use a separate HotClient with a child environment key for runtime operations.
 */
export class HotManagementClient {
  private readonly http: HttpClient;

  constructor(options: HotManagementClientOptions) {
    this.http = new HttpClient(options);
  }

  /** Lists only authorized children; returns { children, total }, not a list envelope. */
  async listChildren(query?: ListQuery, options?: RequestOptions): Promise<ChildList> {
    return (await this.http.requestJson<ChildList>("GET", "/management/children", {
      query, signal: options?.signal, headers: options?.headers,
    })).data;
  }

  /** idempotency_key must remain stable when retrying child provisioning. */
  async createChild(body: CreateChildRequest, options?: RequestOptions): Promise<ChildProvisioned> {
    return (await this.http.requestJson<ChildProvisioned>("POST", "/management/children", {
      body: JSON.stringify(body), signal: options?.signal, headers: options?.headers,
    })).data;
  }

  async setChildState(childId: string, state: OrgLifecycle, options?: RequestOptions): Promise<void> {
    await this.http.requestJson("PATCH", `/management/children/${encodeURIComponent(childId)}/state`, {
      body: JSON.stringify({ state }), signal: options?.signal, headers: options?.headers,
    });
  }

  async createEnvironment(childId: string, body: CreateEnvironmentRequest,
    options?: RequestOptions): Promise<EnvInfo> {
    return (await this.http.requestJson<EnvInfo>("POST",
      `/management/children/${encodeURIComponent(childId)}/environments`, {
        body: JSON.stringify(body), signal: options?.signal, headers: options?.headers,
      })).data;
  }

  async createApiKey(childId: string, envId: string, body: IssueRuntimeKeyRequest,
    options?: RequestOptions): Promise<IssuedRuntimeKey> {
    return (await this.http.requestJson<IssuedRuntimeKey>("POST",
      `/management/children/${encodeURIComponent(childId)}/environments/${encodeURIComponent(envId)}/api-keys`, {
        body: JSON.stringify(body), signal: options?.signal, headers: options?.headers,
      })).data;
  }

  /** Account aggregate; requires usage:read and explicit all_children authority. */
  async usage(options?: RequestOptions): Promise<AccountUsage> {
    return (await this.http.requestJson<AccountUsage>("GET", "/management/usage", {
      signal: options?.signal, headers: options?.headers,
    })).data;
  }
}
