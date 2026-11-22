import { parseJsonText, type HttpClient } from "../http.js";
import { enc, encPath } from "../path.js";
import type {
  ApiResponse,
  FileListQuery,
  FileRecord,
  InitiateUploadRequest,
  InitiateUploadResponse,
  UploadPartResponse,
} from "../types.js";

export class FilesResource {
  constructor(private readonly http: HttpClient) {}

  async list(query?: FileListQuery, options?: { signal?: AbortSignal }) {
    return this.http.requestList<FileRecord>("GET", "/files", {
      query,
      signal: options?.signal,
    });
  }

  async get(fileId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<FileRecord>("GET", `/files/${enc(fileId)}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  async delete(fileId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestVoid("DELETE", `/files/${enc(fileId)}`, {
      signal: options?.signal,
    });
  }

  async download(fileId: string, options?: { signal?: AbortSignal }) {
    return this.http.requestRaw("GET", `/files/${enc(fileId)}/download`, {
      signal: options?.signal,
    });
  }

  async upload(path: string, body: BodyInit, options?: {
    contentType?: string;
    signal?: AbortSignal;
  }) {
    const encodedPath = encPath(path);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options?.contentType) headers["Content-Type"] = options.contentType;

    const response = await this.http.requestRaw("PUT", `/files/upload/${encodedPath}`, {
      headers,
      body,
      signal: options?.signal,
    });
    const envelope = parseJsonText<ApiResponse<FileRecord>>(await response.text(), response);
    return envelope.data;
  }

  async initiateUpload(body: InitiateUploadRequest, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<InitiateUploadResponse>("POST", "/files/uploads", {
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    return envelope.data;
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    body: BodyInit,
    options?: { signal?: AbortSignal },
  ) {
    const response = await this.http.requestRaw(
      "PUT",
      `/files/uploads/${enc(uploadId)}/${enc(String(partNumber))}`,
      {
        headers: { Accept: "application/json" },
        body,
        signal: options?.signal,
      },
    );
    const envelope = parseJsonText<ApiResponse<UploadPartResponse>>(await response.text(), response);
    return envelope.data;
  }

  async completeUpload(uploadId: string, options?: { signal?: AbortSignal }) {
    const envelope = await this.http.requestJson<FileRecord>(
      "POST",
      `/files/uploads/${enc(uploadId)}/complete`,
      { signal: options?.signal },
    );
    return envelope.data;
  }

  async abortUpload(uploadId: string, options?: { signal?: AbortSignal }) {
    await this.http.requestVoid("DELETE", `/files/uploads/${enc(uploadId)}`, {
      signal: options?.signal,
    });
  }
}
