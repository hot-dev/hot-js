import { HotApiError, parseApiError } from "./errors.js";
import type {
  ApiListResponse,
  ApiResponse,
  HotClientOptions,
  ResponseMeta,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.hot.dev";
const USER_AGENT = `hot-sdk-js/${VERSION}`;

// JSON requests retry on 429 when the server supplies retry_after.
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 30;

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

type JsonRequestInit = RequestInit & { query?: Record<string, string | number | undefined> };

export class HttpClient {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly fetchFn: typeof fetch;

  constructor(options: HotClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiBaseUrl = `${this.baseUrl}/v1`;
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  buildQuery(params?: Record<string, string | number | undefined>): string {
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

  private async requestJsonEnvelope<T>(
    method: string,
    path: string,
    init?: JsonRequestInit,
  ): Promise<T> {
    const query = init?.query ? this.buildQuery(init.query) : "";
    const url = `${this.apiBaseUrl}${path}${query}`;
    const { query: _query, ...rest } = init ?? {};

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(url, {
        ...rest,
        method,
        headers: this.authHeaders({
          Accept: "application/json",
          ...(rest.body ? { "Content-Type": "application/json" } : {}),
          ...(rest.headers as Record<string, string> | undefined),
        }),
      });

      const text = await response.text();
      if (!response.ok) {
        const error = parseApiError(response.status, text, response.headers);
        if (response.status === 429 && attempt < MAX_RETRIES && error.retryAfter) {
          await sleep(Math.min(error.retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000, rest.signal);
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

  async requestRaw(
    method: string,
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
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
      throw parseApiError(response.status, text, response.headers);
    }

    return response;
  }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export { HotApiError };
