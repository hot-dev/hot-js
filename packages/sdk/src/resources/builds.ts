import type { HttpClient } from "../http.js";
import type {
  ApiResponse,
  BuildRecord,
  BuildUploadResponse,
  BuildWithProjectRecord,
  ListQuery,
} from "../types.js";

const enc = encodeURIComponent;

export interface UploadBuildOptions {
  file: BodyInit;
  hash: string;
  build_id?: string;
  filename?: string;
  signal?: AbortSignal;
}

export class BuildsResource {
  constructor(private readonly http: HttpClient) {}

  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<BuildWithProjectRecord>("GET", "/builds", {
      query,
      signal: options?.signal,
    });
  }

  async listForProject(project: string, query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<BuildRecord>("GET", `/projects/${enc(project)}/builds`, {
      query,
      signal: options?.signal,
    });
  }

  async get(project: string, buildId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "GET",
      `/projects/${enc(project)}/builds/${enc(buildId)}`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async deployed(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "GET",
      `/projects/${enc(project)}/builds/deployed`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async live(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "GET",
      `/projects/${enc(project)}/builds/live`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async upload(project: string, options: UploadBuildOptions) {
    const form = new FormData();
    form.set("hash", options.hash);
    if (options.build_id) form.set("build_id", options.build_id);
    form.set("file", options.file as Blob, options.filename ?? "build.hot.zip");

    const response = await this.http.requestRaw("POST", `/projects/${enc(project)}/builds`, {
      headers: { Accept: "application/json" },
      body: form,
      signal: options.signal,
    });
    const envelope = await response.json() as ApiResponse<BuildUploadResponse>;
    return envelope.data;
  }

  async download(project: string, buildId: string, options?: { signal?: AbortSignal }) {
    return this.http.requestRaw("GET", `/projects/${enc(project)}/builds/${enc(buildId)}/download`, {
      signal: options?.signal,
    });
  }

  async deploy(project: string, buildId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "POST",
      `/projects/${enc(project)}/builds/${enc(buildId)}/deploy`,
      { signal: options?.signal },
    );
    return envelope.data;
  }
}
