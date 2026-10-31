import { HttpClient, type RequestOptions } from "./http.js";
import { BuildsResource } from "./resources/builds.js";
import { ContextResource } from "./resources/context.js";
import { DomainsResource } from "./resources/domains.js";
import { EventsResource } from "./resources/events.js";
import { EnvResource } from "./resources/env.js";
import { FilesResource } from "./resources/files.js";
import { OrgResource } from "./resources/org.js";
import { ApiKeysResource, OrgsResource } from "./resources/orgs.js";
import { ProjectsResource } from "./resources/projects.js";
import { RunsResource } from "./resources/runs.js";
import { ServiceKeysResource } from "./resources/service-keys.js";
import { SessionsResource } from "./resources/sessions.js";
import { StreamsResource } from "./resources/streams.js";
import { TasksResource } from "./resources/tasks.js";
import type { HotClientOptions, Query } from "./types.js";

export interface HotRequestInit extends RequestOptions {
  /** JSON-serialized request body. */
  body?: unknown;
  query?: Query;
}

export class HotClient {
  readonly http: HttpClient;
  readonly apiKeys: ApiKeysResource;
  readonly builds: BuildsResource;
  readonly context: ContextResource;
  readonly domains: DomainsResource;
  readonly events: EventsResource;
  readonly env: EnvResource;
  readonly files: FilesResource;
  readonly org: OrgResource;
  readonly orgs: OrgsResource;
  readonly projects: ProjectsResource;
  readonly runs: RunsResource;
  readonly serviceKeys: ServiceKeysResource;
  readonly sessions: SessionsResource;
  readonly streams: StreamsResource;
  readonly tasks: TasksResource;

  constructor(options: HotClientOptions) {
    this.http = new HttpClient(options);
    this.apiKeys = new ApiKeysResource(this.http);
    this.builds = new BuildsResource(this.http);
    this.context = new ContextResource(this.http);
    this.domains = new DomainsResource(this.http);
    this.events = new EventsResource(this.http);
    this.env = new EnvResource(this.http);
    this.files = new FilesResource(this.http);
    this.org = new OrgResource(this.http);
    this.orgs = new OrgsResource(this.http);
    this.projects = new ProjectsResource(this.http);
    this.runs = new RunsResource(this.http);
    this.serviceKeys = new ServiceKeysResource(this.http);
    this.sessions = new SessionsResource(this.http);
    this.streams = new StreamsResource(this.http);
    this.tasks = new TasksResource(this.http);
  }

  /**
   * Call a JSON endpoint that has no resource helper yet. `path` is relative
   * to `{baseUrl}/v1` (a leading `/v1` is also accepted), and `body` is sent as
   * JSON. Returns the parsed response envelope (`{ data, meta }`, plus
   * `pagination` for lists). Uses the client's timeout and retry rules; a
   * non-2xx response throws `HotApiError`.
   */
  async request<T = unknown>(method: string, path: string, init?: HotRequestInit): Promise<T> {
    return this.http.requestJsonEnvelope<T>(method, apiPath(path), {
      query: init?.query,
      signal: init?.signal,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  /**
   * Call an endpoint and get the raw `Response` (no timeout, no retries), for
   * streams, uploads and downloads. `path` is relative to `{baseUrl}/v1`. A
   * non-2xx response throws `HotApiError`.
   */
  async requestRaw(
    method: string,
    path: string,
    init?: RequestInit & { query?: Query },
  ): Promise<Response> {
    return this.http.requestRaw(method, apiPath(path), init);
  }

  /** Bearer token configured on this client. */
  get token(): string {
    return this.http.token;
  }

  /** API base URL (`{baseUrl}/v1`). */
  get apiBaseUrl(): string {
    return this.http.apiBaseUrl;
  }
}

function apiPath(path: string): string {
  const relative = path.startsWith("/v1/") ? path.slice(3) : path;
  return relative.startsWith("/") ? relative : `/${relative}`;
}
