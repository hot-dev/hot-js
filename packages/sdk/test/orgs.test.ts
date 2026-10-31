import { describe, expect, it } from "vitest";
import { HotClient, HotKeyScopeError } from "../src/index.js";

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

function recordingClient(respond?: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const hot = new HotClient({
    baseUrl: "http://hot.test",
    token: "hot_org_key",
    fetch: async (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(input).replace("http://hot.test", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return respond?.(call)
        ?? (call.method === "DELETE" && call.url.startsWith("/v1/api-keys/")
          ? new Response(null, { status: 204 })
          : Response.json({ data: { marker: call.url }, pagination: { total: 0 }, meta: {} }));
    },
  });
  return { hot, calls };
}

describe("org API", () => {
  it("routes org, environment and API key calls", async () => {
    const { hot, calls } = recordingClient();
    await hot.orgs.list({ limit: 50, offset: 10 });
    const created = await hot.orgs.create({ name: "Acme", slug: "acme", idempotency_key: "acme-1" });
    expect(created).toEqual({ marker: "/v1/orgs" });
    await hot.orgs.get("org/1");
    await hot.orgs.update("org-1", { state: "suspended" });
    await hot.orgs.usage("root-1");
    await hot.orgs.purgeCalls("org-1", { include_sub_orgs: true });
    await hot.orgs.listEnvs("org-1");
    await hot.orgs.createEnv("org-1", { name: "production" });
    await hot.orgs.getEnv("org-1", "env-1");
    await hot.orgs.listApiKeys("root-1");
    await hot.orgs.createApiKey("root-1", { description: "ci", permissions: { "org:*": ["read"] } });
    await hot.orgs.listEnvApiKeys("org-1", "env-1", { limit: 5 });
    await hot.orgs.createEnvApiKey("org-1", "env-1", {
      description: "backend",
      permissions: { "event:*": ["create"] },
      expires_at: "2027-01-01T00:00:00Z",
    });
    await hot.apiKeys.get("key-1");
    await hot.apiKeys.update("key-1", { permissions: { "event:sdk:*": ["create"] } });
    await expect(hot.apiKeys.revoke("key-1")).resolves.toBeUndefined();
    await hot.apiKeys.rotate("key-1", { overlap_seconds: 3600 });
    await hot.apiKeys.rotate("key-2");

    expect(calls).toEqual([
      { method: "GET", url: "/v1/orgs?limit=50&offset=10", body: undefined },
      { method: "POST", url: "/v1/orgs", body: { name: "Acme", slug: "acme", idempotency_key: "acme-1" } },
      { method: "GET", url: "/v1/orgs/org%2F1", body: undefined },
      { method: "PATCH", url: "/v1/orgs/org-1", body: { state: "suspended" } },
      { method: "GET", url: "/v1/orgs/root-1/usage", body: undefined },
      { method: "DELETE", url: "/v1/orgs/org-1/calls?include_sub_orgs=true", body: undefined },
      { method: "GET", url: "/v1/orgs/org-1/envs", body: undefined },
      { method: "POST", url: "/v1/orgs/org-1/envs", body: { name: "production" } },
      { method: "GET", url: "/v1/orgs/org-1/envs/env-1", body: undefined },
      { method: "GET", url: "/v1/orgs/root-1/api-keys", body: undefined },
      {
        method: "POST",
        url: "/v1/orgs/root-1/api-keys",
        body: { description: "ci", permissions: { "org:*": ["read"] } },
      },
      { method: "GET", url: "/v1/orgs/org-1/envs/env-1/api-keys?limit=5", body: undefined },
      {
        method: "POST",
        url: "/v1/orgs/org-1/envs/env-1/api-keys",
        body: { description: "backend", permissions: { "event:*": ["create"] }, expires_at: "2027-01-01T00:00:00Z" },
      },
      { method: "GET", url: "/v1/api-keys/key-1", body: undefined },
      { method: "PATCH", url: "/v1/api-keys/key-1", body: { permissions: { "event:sdk:*": ["create"] } } },
      { method: "DELETE", url: "/v1/api-keys/key-1", body: undefined },
      { method: "POST", url: "/v1/api-keys/key-1/rotate", body: { overlap_seconds: 3600 } },
      { method: "POST", url: "/v1/api-keys/key-2/rotate", body: {} },
    ]);
  });

  it("reaches projects, context and builds of one environment through the org prefix", async () => {
    const { hot, calls } = recordingClient();
    const env = hot.orgs.env("org-1", "env-1");
    expect([env.orgId, env.envId]).toEqual(["org-1", "env-1"]);
    await env.projects.list();
    await env.projects.create({ name: "app" });
    await env.projects.deactivate("app");
    await env.context.create("app", { key: "callback.url", value: "https://example.test" });
    await env.context.delete("app", "callback.url");
    await env.builds.list();
    await env.builds.deploy("app", "build-1");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /v1/orgs/org-1/envs/env-1/projects",
      "POST /v1/orgs/org-1/envs/env-1/projects",
      "POST /v1/orgs/org-1/envs/env-1/projects/app/deactivate",
      "POST /v1/orgs/org-1/envs/env-1/projects/app/context",
      "DELETE /v1/orgs/org-1/envs/env-1/projects/app/context/callback.url",
      "GET /v1/orgs/org-1/envs/env-1/builds",
      "POST /v1/orgs/org-1/envs/env-1/projects/app/builds/build-1/deploy",
    ]);
    // The environment client itself still uses unprefixed paths.
    await hot.projects.list();
    expect(calls.at(-1)?.url).toBe("/v1/projects");
  });

  it("purges call traces at every scope", async () => {
    const { hot, calls } = recordingClient();
    await hot.env.purgeCalls();
    await hot.runs.purgeCalls("run-1");
    await hot.streams.purgeCalls("stream-1");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "DELETE /v1/env/calls",
      "DELETE /v1/runs/run-1/calls",
      "DELETE /v1/streams/stream-1/calls",
    ]);
  });

  it("raises HotKeyScopeError naming the scope the call needs", async () => {
    const mismatch = (call: Recorded) => Response.json({
      error: {
        code: "key_scope_mismatch",
        message: call.url.startsWith("/v1/orgs") ? "This route needs an org API key" : "This route needs an environment API key",
      },
    }, { status: 403 });
    const { hot, calls } = recordingClient(mismatch);

    const orgCall = await hot.orgs.list().catch((error: unknown) => error);
    expect(orgCall).toBeInstanceOf(HotKeyScopeError);
    expect(orgCall).toMatchObject({ status: 403, code: "key_scope_mismatch", requiredScope: "org" });
    expect((orgCall as Error).message).toMatch(/needs an org API key/);

    const keyCall = await hot.apiKeys.rotate("k").catch((error: unknown) => error);
    expect(keyCall).toMatchObject({ requiredScope: "org" });

    const runtimeCall = await hot.env.get().catch((error: unknown) => error);
    expect(runtimeCall).toBeInstanceOf(HotKeyScopeError);
    expect(runtimeCall).toMatchObject({ requiredScope: "env" });
    expect((runtimeCall as Error).message).toMatch(/needs an environment API key/);

    // `/v1/org/usage` is a runtime route.
    expect(await hot.org.usage().catch((error: unknown) => error)).toMatchObject({ requiredScope: "env" });
    // Permanent: one request each.
    expect(calls).toHaveLength(4);
  });

  it("does not treat other 403s as scope errors", async () => {
    const { hot } = recordingClient(() => Response.json(
      { error: { code: "forbidden", message: "Org API key does not authorize this action" } },
      { status: 403 },
    ));
    const error = await hot.orgs.get("org-1").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(HotKeyScopeError);
    expect(error).toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("request escape hatch", () => {
  it("calls JSON endpoints relative to /v1 and returns the envelope", async () => {
    const { hot, calls } = recordingClient();
    const envelope = await hot.request<{ data: { marker: string } }>("POST", "/orgs/org-1/envs", {
      body: { name: "staging" },
      query: { dry_run: true },
    });
    expect(envelope.data.marker).toBe("/v1/orgs/org-1/envs?dry_run=true");
    await hot.request("GET", "/v1/env");
    await hot.request("GET", "runs/stats");
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ["POST", "/v1/orgs/org-1/envs?dry_run=true", { name: "staging" }],
      ["GET", "/v1/env", undefined],
      ["GET", "/v1/runs/stats", undefined],
    ]);
  });

  it("returns raw responses from requestRaw", async () => {
    const { hot } = recordingClient(() => new Response("raw bytes"));
    const response = await hot.requestRaw("GET", "/v1/files/f1/download");
    expect(await response.text()).toBe("raw bytes");
  });
});
