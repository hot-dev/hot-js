import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import { createHotProxyRoute } from "../src/proxy/index.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createHotProxyRoute", () => {
  it("returns a clear error when token is missing", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "",
      fetch: async () => new Response(null),
    });

    const response = await createHotProxyRoute(hot)(jsonRequest({
      eventType: "team-agent:ask",
      eventData: {},
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Hot API token is not configured" });
  });

  it("converts upstream API errors to JSON", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => new Response(JSON.stringify({
        error: {
          code: "forbidden",
          message: "no access",
          request_id: "req_123",
        },
      }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    });

    const response = await createHotProxyRoute(hot)(jsonRequest({
      eventType: "team-agent:ask",
      eventData: {},
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no access" });
  });

  it("passes SSE responses through", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => new Response("data: {\"type\":\"stream:complete\"}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    });

    const response = await createHotProxyRoute(hot)(jsonRequest({
      event_type: "team-agent:ask",
      event_data: {},
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain("stream:complete");
  });
});
