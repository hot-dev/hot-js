import type { ApiErrorBody } from "./types.js";

/** Error thrown when the Hot API returns a non-2xx response. */
export class HotApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfter?: number;
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
    this.retryAfter = parsed?.error?.retry_after ?? retryAfterFromHeader(headers);
    this.body = body;
    this.error = parsed?.error;
    this.headers = headers ?? new Headers();
  }
}

export type KeyScope = "org" | "env";

/**
 * `403 key_scope_mismatch`: the credential is for the other scope. Org API
 * keys call only `/v1/orgs` and `/v1/api-keys`; environment API keys, service
 * keys and sessions call every other route.
 */
export class HotKeyScopeError extends HotApiError {
  /** The scope of credential the call needs. */
  readonly requiredScope: KeyScope;

  constructor(
    status: number,
    body: string,
    requiredScope: KeyScope,
    headers?: Headers,
    parsed?: ApiErrorBody,
  ) {
    super(status, body, headers, parsed);
    this.name = "HotKeyScopeError";
    this.requiredScope = requiredScope;
    this.message = requiredScope === "org"
      ? "This call needs an org API key; environment API keys, service keys and sessions only call runtime routes"
      : "This call needs an environment API key, service key or session; org API keys only call /v1/orgs and /v1/api-keys";
  }
}

/** The credential scope a `/v1`-relative path needs. */
export function requiredScopeForPath(path: string): KeyScope {
  return /^\/(v1\/)?(orgs|api-keys)(\/|\?|$)/.test(path) ? "org" : "env";
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

/**
 * Build the error for a non-2xx response. `path` (relative to `/v1`) selects
 * the scope named by a `key_scope_mismatch` error.
 */
export function parseApiError(
  status: number,
  body: string,
  headers?: Headers,
  path?: string,
): HotApiError {
  try {
    const parsed = JSON.parse(body) as unknown;
    const structured = structuredErrorBody(parsed);
    if (structured) {
      if (status === 403 && structured.error.code === "key_scope_mismatch") {
        return new HotKeyScopeError(
          status,
          body,
          requiredScopeForPath(path ?? ""),
          headers,
          structured,
        );
      }
      return new HotApiError(status, body, headers, structured);
    }
  } catch {
    // fall through
  }
  return new HotApiError(status, body, headers);
}

function structuredErrorBody(value: unknown): ApiErrorBody | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string" || !message) return undefined;
  return value as ApiErrorBody;
}

function retryAfterFromHeader(headers: Headers | undefined): number | undefined {
  const value = headers?.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Permanent authorization failures must not be retried by SSE reconnect loops. */
export function isAuthorizationError(error: unknown): boolean {
  return isHotApiError(error) && (error.status === 401 || error.status === 403);
}

/**
 * Whether an HTTP status is worth retrying: 408, 429 and 5xx. Every other 4xx
 * (400, 401, 403, 404, 409, 410, 422, ...) is permanent.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Whether a durable waiter should stop on this error instead of reconnecting. */
export function isPermanentError(error: unknown): boolean {
  return isHotApiError(error) && !isRetryableStatus(error.status);
}
