import { USER_AGENT, type HttpClient } from "../http.js";
import { enc, encPath, stripTrailingSlashes } from "../path.js";
import { parseApiError } from "../errors.js";
import { mergeAbortSignals, normalizeTimeoutMs, timeoutError } from "../retry.js";
import type { WebhookMessage, WebhookResponse } from "../types.js";

export interface WebhookTarget {
  /** Organization slug. Omit with `envName` (or set `customDomain: true`) for custom-domain webhooks. */
  orgSlug?: string;
  /** Environment name. Omit with `orgSlug` (or set `customDomain: true`) for custom-domain webhooks. */
  envName?: string;
  service: string;
  path?: string;
  token?: string;
  /**
   * Set to `true` when `baseUrl` is a custom domain bound directly to an
   * environment (`{baseUrl}/webhook/{service}/{path}`). Also inferred when
   * both `orgSlug` and `envName` are omitted.
   */
  customDomain?: boolean;
}

/** Build a Hot webhook URL for a service endpoint. */
export function buildWebhookUrl(baseUrl: string, target: WebhookTarget): string {
  const root = stripTrailingSlashes(baseUrl);
  const path = encPath(target.path ?? "web/messages");
  const suffix = target.token ? `/${enc(target.token)}` : "";
  const service = enc(target.service);

  if (target.customDomain === true || (target.orgSlug === undefined && target.envName === undefined)) {
    return `${root}/webhook/${service}/${path}${suffix}`;
  }

  if (target.orgSlug === undefined || target.envName === undefined) {
    throw new RangeError(
      "WebhookTarget requires both orgSlug and envName, or omit both (or set customDomain: true) for a custom domain",
    );
  }

  return `${root}/webhook/${enc(target.orgSlug)}/${enc(target.envName)}/${service}/${path}${suffix}`;
}

export interface PostWebhookOptions {
  signal?: AbortSignal;
}

/** POST a normalized message to a Hot webhook (no bearer auth — token may be in URL). */
export async function postWebhook(
  http: HttpClient,
  target: WebhookTarget,
  body: WebhookMessage,
  options?: PostWebhookOptions,
): Promise<WebhookResponse> {
  const url = buildWebhookUrl(http.baseUrl, target);
  const effectiveTimeoutMs = normalizeTimeoutMs(http.timeoutMs);
  const deadline = effectiveTimeoutMs !== undefined ? new AbortController() : undefined;
  const timer = deadline
    ? setTimeout(
      () => deadline.abort(timeoutError(`Hot webhook request timed out after ${http.timeoutMs} ms`)),
      effectiveTimeoutMs,
    )
    : undefined;
  const signal = deadline
    ? mergeAbortSignals([options?.signal, deadline.signal])
    : options?.signal;

  let response: Response;
  let text: string;
  try {
    response = await http.fetchFn(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    throw signal?.aborted ? signal.reason ?? error : error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw parseApiError(response.status, text, response.headers);
  }

  let parsed: WebhookResponse = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as WebhookResponse;
    } catch {
      parsed = { error: text };
    }
  }

  return parsed;
}
