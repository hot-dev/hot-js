import { HttpClient } from "./http.js";
import { BuildsResource } from "./resources/builds.js";
import { ContextResource } from "./resources/context.js";
import { DomainsResource } from "./resources/domains.js";
import { EventsResource } from "./resources/events.js";
import { EnvResource } from "./resources/env.js";
import { FilesResource } from "./resources/files.js";
import { OrgResource } from "./resources/org.js";
import { ProjectsResource } from "./resources/projects.js";
import { RunsResource } from "./resources/runs.js";
import { ServiceKeysResource } from "./resources/service-keys.js";
import { SessionsResource } from "./resources/sessions.js";
import { StreamsResource } from "./resources/streams.js";
import { TasksResource } from "./resources/tasks.js";
import type { HotClientOptions } from "./types.js";

export class HotClient {
  readonly http: HttpClient;
  readonly builds: BuildsResource;
  readonly context: ContextResource;
  readonly domains: DomainsResource;
  readonly events: EventsResource;
  readonly env: EnvResource;
  readonly files: FilesResource;
  readonly org: OrgResource;
  readonly projects: ProjectsResource;
  readonly runs: RunsResource;
  readonly serviceKeys: ServiceKeysResource;
  readonly sessions: SessionsResource;
  readonly streams: StreamsResource;
  readonly tasks: TasksResource;

  constructor(options: HotClientOptions) {
    this.http = new HttpClient(options);
    this.builds = new BuildsResource(this.http);
    this.context = new ContextResource(this.http);
    this.domains = new DomainsResource(this.http);
    this.events = new EventsResource(this.http);
    this.env = new EnvResource(this.http);
    this.files = new FilesResource(this.http);
    this.org = new OrgResource(this.http);
    this.projects = new ProjectsResource(this.http);
    this.runs = new RunsResource(this.http);
    this.serviceKeys = new ServiceKeysResource(this.http);
    this.sessions = new SessionsResource(this.http);
    this.streams = new StreamsResource(this.http);
    this.tasks = new TasksResource(this.http);
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
