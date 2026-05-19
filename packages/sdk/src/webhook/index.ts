import type { HttpClient } from "../http.js";
import type { WebhookMessage, WebhookResponse } from "../types.js";
import { parseApiError } from "../errors.js";

export interface WebhookTarget {
  orgSlug: string;
  envName: string;
  service: string;
  path?: string;
  token?: string;
}

/** Build a Hot webhook URL for a service endpoint. */
export function buildWebhookUrl(baseUrl: string, target: WebhookTarget): string {
  const root = baseUrl.replace(/\/$/, "");
  const path = target.path ?? "web/messages";
  const suffix = target.token ? `/${target.token}` : "";
  return `${root}/webhook/${target.orgSlug}/${target.envName}/${target.service}/${path}${suffix}`;
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
  const response = await http.fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  const text = await response.text();
  let parsed: WebhookResponse = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as WebhookResponse;
    } catch {
      parsed = { error: text };
    }
  }

  if (!response.ok) {
    throw parseApiError(response.status, text, response.headers);
  }

  return parsed;
}
