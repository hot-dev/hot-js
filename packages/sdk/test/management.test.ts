import { describe, expect, it } from "vitest";
import { HotClient, HotManagementClient, HotApiError } from "../src/index.js";

describe("management contract", () => {
  it("uses management bearer auth, encodes identifiers, unwraps data, and accepts 204", async () => {
    const calls: [string, string, unknown][] = [];
    const management = new HotManagementClient({ token: "hm_test", baseUrl: "https://api.test",
      fetch: async (url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer hm_test");
        calls.push([init!.method!, String(url), init?.body ? JSON.parse(String(init.body)) : null]);
        return init?.method === "PATCH" ? new Response(null, { status: 204 })
          : Response.json({ data: { marker: "response" }, meta: {} });
      },
    });
    expect(await management.listChildren({ limit: 7, offset: 3 })).toEqual({ marker: "response" });
    const body = { name: "Customer", slug: "customer", idempotency_key: "stable" };
    await management.createChild(body);
    await expect(management.setChildState("child/one", "suspended")).resolves.toBeUndefined();
    await management.createEnvironment("child/one", { name: "prod" });
    const key = { description: "sdk", permissions: { "event:sdk:*": ["create"] } };
    await management.createApiKey("child/one", "env/two", key);
    await management.usage();
    expect(calls).toEqual([
      ["GET", "https://api.test/v1/management/children?limit=7&offset=3", null],
      ["POST", "https://api.test/v1/management/children", body],
      ["PATCH", "https://api.test/v1/management/children/child%2Fone/state", { state: "suspended" }],
      ["POST", "https://api.test/v1/management/children/child%2Fone/environments", { name: "prod" }],
      ["POST", "https://api.test/v1/management/children/child%2Fone/environments/env%2Ftwo/api-keys", key],
      ["GET", "https://api.test/v1/management/usage", null],
    ]);
  });

  for (const status of [401, 403]) {
    it(`stops reconnecting after ${status}`, async () => {
      let calls = 0;
      const client = new HotClient({ token: "test", fetch: async () => {
        if (++calls === 1) return new Response('data: {"type":"event:published","stream_id":"s","event_id":"e"}\n\n');
        return Response.json({ error: { code: "denied", message: "revoked" } }, { status });
      } });
      const stream = client.streams.subscribeWithEvent({ event_type: "sdk:echo", event_data: {} });
      await stream.next();
      await expect(stream.next()).rejects.toMatchObject({ status });
      expect(calls).toBe(2);
    });
    for (const resource of ["runs", "tasks"] as const) {
      it(`does not retry ${resource}.wait on ${status}`, async () => {
        let calls = 0;
        const client = new HotClient({ token: "test", fetch: async () => {
          calls++;
          return new Response("denied", { status });
        } });
        await expect(client[resource].wait("id")).rejects.toBeInstanceOf(HotApiError);
        expect(calls).toBe(1);
      });
    }
  }
});
