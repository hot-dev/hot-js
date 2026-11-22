import { HotApiError, isRetryableStatus, parseApiError } from "./errors.js";
import {
  backoffDelayMs,
  clampTimeoutMs,
  mergeAbortSignals,
  normalizeTimeoutMs,
  sleep,
  timeoutError,
} from "./retry.js";
import type {
  ApiListResponse,
  ApiResponse,
  HotClientOptions,
  ListQuery,
  Query,
  ResponseMeta,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.hot.dev";
const DEFAULT_TIMEOUT_MS = 60_000;
export const USER_AGENT = `hot-sdk-js/${VERSION}`;

// JSON requests retry on 429 when the server supplies retry_after, on POST 503
// event_publish_in_progress, and for idempotent methods on 502, 503 and 504.
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 30;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);

const CANONICAL_HEADER_NAMES: ReadonlyMap<string, string> = new Map([
  ["authorization", "Authorization"],
  ["user-agent", "User-Agent"],
  ["accept", "Accept"],
  ["content-type", "Content-Type"],
]);

export type QueryInput = Query | ListQuery;

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

type JsonRequestInit = RequestInit & {
  query?: QueryInput;
  /** Where `path` starts, for a route outside `/v1`. */
  base?: string;
  /** Whether to attach the `Authorization` header. Defaults to `true`. */
  auth?: boolean;
};

/** Parse a 2xx JSON response body, wrapping `SyntaxError` with HTTP context. */
export function parseJsonText<T>(text: string, response: Response): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const contentType = response.headers.get("content-type") ?? "unknown";
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    throw new Error(
      `Hot API returned invalid JSON (status ${response.status}, content-type ${contentType}): ${preview}`,
      { cause },
    );
  }
}

/** Add bounded positive jitter to a server-supplied `Retry-After` delay (seconds). */
function jitteredRetryAfterMs(seconds: number): number {
  if (seconds <= 0) return 0;
  const baseMs = seconds * 1000;
  return baseMs + Math.random() * Math.min(1_000, baseMs * 0.25);
}

export class HttpClient {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly fetchFn: typeof fetch;
  readonly timeoutMs: number;
  #token: string;

  constructor(options: HotClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL)
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    this.apiBaseUrl = `${this.baseUrl}/v1`;
    this.#token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Bearer token configured on this client (non-enumerable to avoid accidental logging). */
  get token(): string {
    return this.#token;
  }

  authHeaders(extra?: HeadersInit): Record<string, string> {
    const merged = this.buildHeaders(true, undefined, extra);
    const result: Record<string, string> = {};
    merged.forEach((value, key) => {
      result[CANONICAL_HEADER_NAMES.get(key) ?? key] = value;
    });
    return result;
  }

  private buildHeaders(
    auth: boolean,
    defaults?: Record<string, string>,
    extra?: HeadersInit,
  ): Headers {
    const headers = new Headers();
    if (auth) headers.set("Authorization", `Bearer ${this.#token}`);
    headers.set("User-Agent", USER_AGENT);
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        headers.set(key, value);
      }
    }
    if (extra) {
      new Headers(extra).forEach((value, key) => {
        headers.set(key, value);
      });
    }
    return headers;
  }

  buildQuery(params?: QueryInput): string {
    if (!params) return "";
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
  }

  async requestJson<T>(
    method: string,
    path: string,
    init?: JsonRequestInit,
  ): Promise<ApiResponse<T>> {
    return this.requestJsonEnvelope<ApiResponse<T>>(method, path, init);
  }

  async requestList<T>(
    method: string,
    path: string,
    init?: JsonRequestInit,
  ): Promise<ApiListResponse<T>> {
    return this.requestJsonEnvelope<ApiListResponse<T>>(method, path, init);
  }

  /** A JSON-API call whose response body (if any) is not needed, such as a DELETE. */
  async requestVoid(method: string, path: string, init?: JsonRequestInit): Promise<void> {
    await this.requestJsonEnvelope<unknown>(method, path, init);
  }

  /**
   * Send a JSON-API request with the client's timeout and retry rules, and
   * return the parsed response body (the `{ data, meta }` envelope).
   */
  async requestJsonEnvelope<T>(
    method: string,
    path: string,
    init?: JsonRequestInit,
  ): Promise<T> {
    const query = init?.query ? this.buildQuery(init.query) : "";
    const url = `${init?.base ?? this.apiBaseUrl}${path}${query}`;
    const {
      query: _query,
      base: _base,
      auth = true,
      signal: callerSignal,
      headers: extraHeaders,
      ...rest
    } = init ?? {};

    const effectiveTimeoutMs = normalizeTimeoutMs(this.timeoutMs);
    const overallDeadline = effectiveTimeoutMs !== undefined
      ? Date.now() + effectiveTimeoutMs
      : undefined;

    const defaults: Record<string, string> = { Accept: "application/json" };
    if (rest.body !== undefined && rest.body !== null) {
      defaults["Content-Type"] = "application/json";
    }
    const headers = this.buildHeaders(auth, defaults, extraHeaders);

    for (let attempt = 0; ; attempt++) {
      let deadline: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (overallDeadline !== undefined) {
        const remainingMs = overallDeadline - Date.now();
        if (remainingMs <= 0) {
          throw timeoutError(`Hot API request timed out after ${this.timeoutMs} ms`);
        }
        deadline = new AbortController();
        timer = setTimeout(
          () => deadline!.abort(timeoutError(`Hot API request timed out after ${this.timeoutMs} ms`)),
          clampTimeoutMs(remainingMs),
        );
      }

      const signal = deadline
        ? mergeAbortSignals([callerSignal, deadline.signal])
        : callerSignal;

      let response: Response;
      let text: string;
      try {
        response = await this.fetchFn(url, {
          ...rest,
          method,
          signal,
          redirect: "manual",
          headers,
        });
        text = await response.text();
      } catch (error) {
        throw signal?.aborted ? signal.reason ?? error : error;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const error = parseApiError(response.status, text, response.headers, path);
        const delay = this.retryDelay(method, error, attempt);
        if (delay !== undefined) {
          if (overallDeadline !== undefined && Date.now() + delay >= overallDeadline) {
            throw timeoutError(`Hot API request timed out after ${this.timeoutMs} ms`, error);
          }
          await sleep(delay, callerSignal);
          continue;
        }
        throw error;
      }
      if (!text) {
        return {
          data: undefined,
          meta: {} as ResponseMeta,
        } as T;
      }
      return parseJsonText<T>(text, response);
    }
  }

  private retryDelay(method: string, error: HotApiError, attempt: number): number | undefined {
    if (attempt >= MAX_RETRIES || !isRetryableStatus(error.status)) return undefined;
    const retryAfter = error.retryAfter === undefined
      ? undefined
      : Math.min(error.retryAfter, MAX_RETRY_AFTER_SECONDS);
    if (error.status === 429) {
      return retryAfter === undefined ? undefined : jitteredRetryAfterMs(retryAfter);
    }
    const upper = method.toUpperCase();
    if (upper === "POST" && error.status === 503 && error.code === "event_publish_in_progress") {
      return retryAfter !== undefined
        ? jitteredRetryAfterMs(retryAfter)
        : backoffDelayMs(attempt + 1);
    }
    if (IDEMPOTENT_METHODS.has(upper) && TRANSIENT_GATEWAY_STATUSES.has(error.status)) {
      return backoffDelayMs(attempt + 1, retryAfter);
    }
    return undefined;
  }

  /**
   * Send a request and return the raw response: no timeout and no retries, for
   * streams, uploads and downloads. Non-2xx responses throw `HotApiError`.
   */
  async requestRaw(
    method: string,
    path: string,
    init?: RequestInit & { query?: QueryInput },
  ): Promise<Response> {
    const query = init?.query ? this.buildQuery(init.query) : "";
    const url = `${this.apiBaseUrl}${path}${query}`;
    const { query: _query, headers: extraHeaders, ...rest } = init ?? {};

    const response = await this.fetchFn(url, {
      ...rest,
      method,
      redirect: "manual",
      headers: this.buildHeaders(true, undefined, extraHeaders),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw parseApiError(response.status, text, response.headers, path);
    }

    return response;
  }
}

export { HotApiError };
