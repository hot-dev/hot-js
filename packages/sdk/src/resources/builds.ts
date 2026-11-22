import { parseJsonText, type HttpClient } from "../http.js";
import { enc } from "../path.js";
import type {
  ApiResponse,
  BuildRecord,
  BuildUploadResponse,
  BuildWithProjectRecord,
  ListQuery,
} from "../types.js";

export interface UploadBuildOptions {
  file: BodyInit;
  hash: string;
  build_id?: string;
  filename?: string;
  signal?: AbortSignal;
}

function toBlob(file: BodyInit): Blob {
  if (file instanceof Blob) return file;
  if (typeof file === "string" || file instanceof ArrayBuffer || ArrayBuffer.isView(file)) {
    return new Blob([file as BlobPart]);
  }
  throw new TypeError("builds.upload requires file to be a Blob, Uint8Array, ArrayBuffer, or string");
}

export class BuildsResource {
  /**
   * @param prefix Path prefix inside `/v1`; `hot.orgs.env(org, env)` sets it to
   * `/orgs/{org}/envs/{env}` for an org API key.
   */
  constructor(private readonly http: HttpClient, private readonly prefix = "") {}

  async list(query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<BuildWithProjectRecord>("GET", `${this.prefix}/builds`, {
      query,
      signal: options?.signal,
    });
  }

  async listForProject(project: string, query?: ListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<BuildRecord>("GET", `${this.prefix}/projects/${enc(project)}/builds`, {
      query,
      signal: options?.signal,
    });
  }

  async get(project: string, buildId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "GET",
      `${this.prefix}/projects/${enc(project)}/builds/${enc(buildId)}`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async deployed(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "GET",
      `${this.prefix}/projects/${enc(project)}/builds/deployed`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async live(project: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "GET",
      `${this.prefix}/projects/${enc(project)}/builds/live`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async upload(project: string, options: UploadBuildOptions) {
    const path = `${this.prefix}/projects/${enc(project)}/builds`;
    const form = new FormData();
    form.set("hash", options.hash);
    if (options.build_id) form.set("build_id", options.build_id);
    form.set("file", toBlob(options.file), options.filename ?? "build.hot.zip");

    const response = await this.http.requestRaw("POST", path, {
      headers: { Accept: "application/json" },
      body: form,
      signal: options.signal,
    });
    const envelope = parseJsonText<ApiResponse<BuildUploadResponse>>(await response.text(), response);
    return envelope.data;
  }

  async download(project: string, buildId: string, options?: { signal?: AbortSignal }) {
    return this.http.requestRaw("GET", `${this.prefix}/projects/${enc(project)}/builds/${enc(buildId)}/download`, {
      signal: options?.signal,
    });
  }

  async deploy(project: string, buildId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<BuildRecord>(
      "POST",
      `${this.prefix}/projects/${enc(project)}/builds/${enc(buildId)}/deploy`,
      { signal: options?.signal },
    );
    return envelope.data;
  }
}
