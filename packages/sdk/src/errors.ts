import type { ApiErrorBody } from "./types.js";

/** Error thrown when the Hot API returns a non-2xx response. */
export class HotApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly body: string;
  readonly error?: ApiErrorBody["error"];
  readonly headers: Headers;

  constructor(status: number, body: string, headers?: Headers, parsed?: ApiErrorBody) {
    const message = parsed?.error?.message ?? (body || `Hot API error (${status})`);
    super(message);
    this.name = "HotApiError";
    this.status = status;
    this.code = parsed?.error?.code ?? "unknown";
    this.requestId = parsed?.error?.request_id;
    this.body = body;
    this.error = parsed?.error;
    this.headers = headers ?? new Headers();
  }
}

export function isHotApiError(error: unknown): error is HotApiError {
  return error instanceof HotApiError
    || (
      typeof error === "object"
      && error !== null
      && (error as { name?: unknown }).name === "HotApiError"
      && typeof (error as { status?: unknown }).status === "number"
    );
}

export function parseApiError(
  status: number,
  body: string,
  headers?: Headers,
): HotApiError {
  try {
    const parsed = JSON.parse(body) as ApiErrorBody;
    if (parsed?.error?.message) {
      return new HotApiError(status, body, headers, parsed);
    }
  } catch {
    // fall through
  }
  return new HotApiError(status, body, headers);
}
