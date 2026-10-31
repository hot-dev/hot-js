import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import { createHotProxyRoute, type CreateHotProxyOptions } from "../src/proxy/index.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Upstream {
  hot: HotClient;
  bodies: unknown[];
}

function upstream(sse = "data: {\"type\":\"stream:complete\",\"stream_id\":\"s1\"}\n\n", token = "test-token"): Upstream {
  const bodies: unknown[] = [];
  const hot = new HotClient({
    baseUrl: "http://hot.test",
    token,
    fetch: async (url, init) => {
      expect(String(url)).toBe("http://hot.test/v1/streams/subscribe-with-event");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { hot, bodies };
}

const chat: CreateHotProxyOptions = { allowEventTypes: ["team-agent:ask", "chat:*"] };

describe("createHotProxyRoute", () => {
  it("requires an event type policy", () => {
    const { hot } = upstream();
    expect(() => createHotProxyRoute(hot, undefined as unknown as CreateHotProxyOptions))
      .toThrow(/allowEventTypes/);
  });

  it("forwards allowed event types with the configured credential", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "child-a-key",
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://hot.test/v1/streams/subscribe-with-event");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer child-a-key");
        expect(JSON.parse(String(init?.body))).toEqual({
          event_type: "sdk:echo", event_data: { org_id: "user-owned-data" },
        });
        return new Response("data: {}\n\n");
      },
    });
    const response = await createHotProxyRoute(hot, { allowEventTypes: ["sdk:echo"] })(jsonRequest({
      event_type: "sdk:echo", event_data: { org_id: "user-owned-data" },
      org_id: "child-b", env_id: "child-b-env", token: "child-b-key",
    }));
    expect(response.status).toBe(200);
  });

  it("rejects event types outside the policy without calling Hot", async () => {
    const { hot, bodies } = upstream();
    const route = createHotProxyRoute(hot, chat);
    for (const eventType of ["hot:call", "other:thing", "chatx", "hot:schedule:new"]) {
      const response = await route(jsonRequest({ event_type: eventType, event_data: { fn: "::hot::env/get-all" } }));
      expect(response.status, eventType).toBe(403);
      expect(await response.json()).toEqual({ error: "event_type is not allowed" });
    }
    expect(bodies).toEqual([]);
    expect((await route(jsonRequest({ eventType: "chat:send", eventData: {} }))).status).toBe(200);
  });

  it("never lets a wildcard or predicate allow hot: event types", async () => {
    const { hot, bodies } = upstream();
    const wildcard = createHotProxyRoute(hot, { allowEventTypes: ["*"] });
    expect((await wildcard(jsonRequest({ event_type: "hot:call", event_data: {} }))).status).toBe(403);
    expect((await wildcard(jsonRequest({ event_type: "app:anything", event_data: {} }))).status).toBe(200);
    const predicate = createHotProxyRoute(hot, { allowEventTypes: () => true });
    expect((await predicate(jsonRequest({ event_type: "hot:call", event_data: {} }))).status).toBe(403);
    const exact = createHotProxyRoute(hot, { allowEventTypes: ["hot:call"] });
    expect((await exact(jsonRequest({ event_type: "hot:call", event_data: {} }))).status).toBe(200);
    expect(bodies.map((body) => (body as { event_type: string }).event_type))
      .toEqual(["app:anything", "hot:call"]);
  });

  it("ignores a browser stream_id unless allowStreamId accepts it", async () => {
    const { hot, bodies } = upstream();
    await createHotProxyRoute(hot, chat)(jsonRequest({ event_type: "chat:send", event_data: {}, stream_id: "victim" }));
    expect(bodies[0]).toEqual({ event_type: "chat:send", event_data: {} });

    const checked = createHotProxyRoute(hot, {
      ...chat,
      allowStreamId: (streamId) => streamId === "mine",
    });
    expect((await checked(jsonRequest({ event_type: "chat:send", event_data: {}, stream_id: "victim" }))).status)
      .toBe(403);
    expect((await checked(jsonRequest({ event_type: "chat:send", event_data: {}, stream_id: "mine" }))).status)
      .toBe(200);
    expect(bodies[1]).toEqual({ event_type: "chat:send", event_data: {}, stream_id: "mine" });
  });

  it("filters a continued stream to the published event's runs", async () => {
    const sse = [
      'event: event:published\ndata: {"type":"event:published","event_id":"e2","stream_id":"s1"}',
      ': keepalive',
      'data: {"type":"run:start","run":{"run_id":"old","event_id":"e1"}}',
      'data: {"type":"stream:data","run_id":"old","data_type":"x","payload":{"text":"secret"}}',
      'data: {"type":"stream:data","run_id":"r2","data_type":"x","payload":{"text":"early"}}',
      'data: {"type":"run:stop","run":{"run_id":"old","event_id":"e1","result":"other user"}}',
      'data: {"type":"run:stop","run":{"run_id":"r2","event_id":"e2","result":"mine"}}',
      'data: {"type":"run:start","run":{"run_id":"r2","event_id":"e2"}}',
    ].map((block) => `${block}\n\n`).join("");
    const { hot } = upstream(sse);
    const route = createHotProxyRoute(hot, { ...chat, allowStreamId: true });
    const text = await (await route(jsonRequest({ event_type: "chat:send", event_data: {}, stream_id: "s1" }))).text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("other user");
    expect(text.split("\n\n").filter(Boolean)).toEqual([
      'event: event:published\ndata: {"type":"event:published","event_id":"e2","stream_id":"s1"}',
      ': keepalive',
      'data: {"type":"stream:data","run_id":"r2","data_type":"x","payload":{"text":"early"}}',
      'data: {"type":"run:stop","run":{"run_id":"r2","event_id":"e2","result":"mine"}}',
      'data: {"type":"run:start","run":{"run_id":"r2","event_id":"e2"}}',
    ]);
  });

  it("runs the authorize hook, which may deny, answer or rewrite", async () => {
    const { hot, bodies } = upstream();
    const denied = createHotProxyRoute(hot, { ...chat, authorize: () => false });
    expect((await denied(jsonRequest({ event_type: "chat:send", event_data: {} }))).status).toBe(403);
    const forgetful = createHotProxyRoute(hot, { ...chat, authorize: () => undefined });
    expect((await forgetful(jsonRequest({ event_type: "chat:send", event_data: {} }))).status).toBe(403);
    const answered = createHotProxyRoute(hot, { ...chat, authorize: () => new Response("login", { status: 401 }) });
    expect((await answered(jsonRequest({ event_type: "chat:send", event_data: {} }))).status).toBe(401);
    const rewritten = createHotProxyRoute(hot, {
      ...chat,
      authorize: async (request, event) => ({
        ...event,
        event_data: { ...(event.event_data as object), user_id: request.headers.get("x-user") },
      }),
    });
    const request = jsonRequest({ event_type: "chat:send", event_data: { text: "hi", user_id: "spoofed" } });
    request.headers.set("x-user", "u1");
    expect((await rewritten(request)).status).toBe(200);
    expect(bodies).toEqual([{ event_type: "chat:send", event_data: { text: "hi", user_id: "u1" } }]);
  });

  it("chooses the client per request", async () => {
    const tokens: string[] = [];
    const route = createHotProxyRoute(async (request) => {
      const token = `session-for-${request.headers.get("x-user")}`;
      return new HotClient({
        baseUrl: "http://hot.test",
        token,
        fetch: async (_url, init) => {
          tokens.push(new Headers(init?.headers).get("Authorization")!);
          return new Response("data: {}\n\n");
        },
      });
    }, chat);
    const request = jsonRequest({ event_type: "chat:send", event_data: {} });
    request.headers.set("x-user", "u7");
    expect((await route(request)).status).toBe(200);
    expect(tokens).toEqual(["Bearer session-for-u7"]);
  });

  it("returns a clear error when token is missing", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "",
      fetch: async () => new Response(null),
    });

    const response = await createHotProxyRoute(hot, chat)(jsonRequest({
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

    const response = await createHotProxyRoute(hot, chat)(jsonRequest({
      eventType: "team-agent:ask",
      eventData: {},
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no access" });
  });

  it("passes SSE responses through", async () => {
    const { hot } = upstream();

    const response = await createHotProxyRoute(hot, chat)(jsonRequest({
      event_type: "team-agent:ask",
      event_data: {},
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await response.text()).toContain("stream:complete");
  });
});
