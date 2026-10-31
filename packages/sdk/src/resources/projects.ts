import type { HttpClient } from "../http.js";
import type {
  CreateProjectRequest,
  EventHandlerRecord,
  ListQuery,
  ProjectActivateResponse,
  ProjectRecord,
  ScheduleRecord,
  UpdateProjectRequest,
} from "../types.js";

const enc = encodeURIComponent;

export class ProjectsResource {
  /**
   * @param prefix Path prefix inside `/v1`; `hot.orgs.env(org, env)` sets it to
   * `/orgs/{org}/envs/{env}` for an org API key.
   */
  constructor(private readonly http: HttpClient, private readonly prefix = "") {}

  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<ProjectRecord>("GET", `${this.prefix}/projects`, {
      query,
      signal: options?.signal,
    });
  }

  async create(body: CreateProjectRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ProjectRecord>("POST", `${this.prefix}/projects`, {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async get(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ProjectRecord>("GET", `${this.prefix}/projects/${enc(project)}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async update(project: string, body: UpdateProjectRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ProjectRecord>("PATCH", `${this.prefix}/projects/${enc(project)}`, {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async delete(project: string, options?: { signal?: AbortSignal }) {
    await this.http.requestVoid("DELETE", `${this.prefix}/projects/${enc(project)}`, {
      signal: options?.signal,
    });
  }

  async activate(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ProjectActivateResponse>(
      "POST",
      `${this.prefix}/projects/${enc(project)}/activate`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async deactivate(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<ProjectActivateResponse>(
      "POST",
      `${this.prefix}/projects/${enc(project)}/deactivate`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async eventHandlers(project: string, options?: { signal?: AbortSignal }) {
    return this.http.requestList<EventHandlerRecord>(
      "GET",
      `${this.prefix}/projects/${enc(project)}/event-handlers`,
      { signal: options?.signal },
    );
  }

  async schedules(project: string, options?: { signal?: AbortSignal }) {
    return this.http.requestList<ScheduleRecord>(
      "GET",
      `${this.prefix}/projects/${enc(project)}/schedules`,
      { signal: options?.signal },
    );
  }
}
