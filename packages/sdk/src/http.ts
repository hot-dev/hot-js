import { HotApiError, isRetryableStatus, parseApiError } from "./errors.js";
import { backoffDelayMs, mergeAbortSignals, sleep, timeoutError } from "./retry.js";
import type {
  ApiListResponse,
  ApiResponse,
  HotClientOptions,
  Query,
  ResponseMeta,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.hot.dev";
const DEFAULT_TIMEOUT_MS = 60_000;
const USER_AGENT = `hot-sdk-js/${VERSION}`;

// JSON requests retry on 429 when the server supplies retry_after, and
// idempotent ones also on 502, 503 and 504.
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 30;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

type JsonRequestInit = RequestInit & { query?: Query };

export class HttpClient {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly fetchFn: typeof fetch;
  readonly timeoutMs: number;

  constructor(options: HotClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiBaseUrl = `${this.baseUrl}/v1`;
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  buildQuery(params?: Query): string {
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
    const url = `${this.apiBaseUrl}${path}${query}`;
    const { query: _query, signal: callerSignal, ...rest } = init ?? {};

    for (let attempt = 0; ; attempt++) {
      const deadline = this.timeoutMs > 0 ? new AbortController() : undefined;
      const timer = deadline
        ? setTimeout(
          () => deadline.abort(timeoutError(`Hot API request timed out after ${this.timeoutMs} ms`)),
          this.timeoutMs,
        )
        : undefined;
      const signal = deadline ? mergeAbortSignals([callerSignal, deadline.signal]) : callerSignal;
      let response: Response;
      let text: string;
      try {
        response = await this.fetchFn(url, {
          ...rest,
          method,
          signal,
          headers: this.authHeaders({
            Accept: "application/json",
            ...(rest.body ? { "Content-Type": "application/json" } : {}),
            ...(rest.headers as Record<string, string> | undefined),
          }),
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
      return JSON.parse(text) as T;
    }
  }

  private retryDelay(method: string, error: HotApiError, attempt: number): number | undefined {
    if (attempt >= MAX_RETRIES || !isRetryableStatus(error.status)) return undefined;
    const retryAfter = error.retryAfter === undefined
      ? undefined
      : Math.min(error.retryAfter, MAX_RETRY_AFTER_SECONDS);
    if (error.status === 429) {
      return retryAfter === undefined ? undefined : retryAfter * 1000;
    }
    if (IDEMPOTENT_METHODS.has(method.toUpperCase()) && TRANSIENT_GATEWAY_STATUSES.has(error.status)) {
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
    init?: RequestInit & { query?: Query },
  ): Promise<Response> {
    const query = init?.query ? this.buildQuery(init.query) : "";
    const url = `${this.apiBaseUrl}${path}${query}`;
    const { query: _query, ...rest } = init ?? {};

    const response = await this.fetchFn(url, {
      ...rest,
      method,
      headers: this.authHeaders({
        ...(rest.headers as Record<string, string> | undefined),
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw parseApiError(response.status, text, response.headers, path);
    }

    return response;
  }
}

export { HotApiError };
