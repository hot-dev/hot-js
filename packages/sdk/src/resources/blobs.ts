import type { HttpClient } from "../http.js";

const enc = encodeURIComponent;

/** Large payloads spilled to blob storage. Environment API key only. */
export class BlobsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Raw bytes of a payload spilled to blob storage, in the caller's
   * environment. String payloads are served as UTF-8 text.
   */
  async download(blobRefId: string, options?: { signal?: AbortSignal }) {
    return this.http.requestRaw("GET", `/blobs/${enc(blobRefId)}/download`, {
      signal: options?.signal,
    });
  }
}
