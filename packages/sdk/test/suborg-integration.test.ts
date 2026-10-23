import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HotClient, HotManagementClient } from "../src/index.js";

const fixtureData = process.env.HOT_TEST_SUBORG_FIXTURE;
const baseUrl = process.env.HOT_TEST_BASE_URL;
interface Fixture { root_org_id: string; root_token: string; management_token: string;
  revoked: string[]; narrowed: string[] }
function fixture(): Fixture { return JSON.parse(fixtureData!); }
function runtime(token: string): HotClient { return new HotClient({ token, baseUrl }); }

describe.skipIf(!fixtureData)("sub-org integration", () => {
  it("provisions isolated children and environment credentials", { timeout: 90_000 }, async () => {
    const conf = fixture();
    const management = new HotManagementClient({ token: conf.management_token, baseUrl });
    const children: string[] = [];
    const clients: HotClient[] = [];
    const envs: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        const body = { name: "SDK Customer", slug: `sdk-${id}`, external_id: id, idempotency_key: id };
        const child = await management.createChild(body);
        const replay = await management.createChild(body);
        expect(replay.org.org_id).toBe(child.org.org_id);
        expect(replay.created).toBe(false);
        children.push(child.org.org_id);
        const env = await management.createEnvironment(child.org.org_id, { name: "production" });
        expect(await management.createEnvironment(child.org.org_id, { name: "production" })).toEqual(env);
        envs.push(env.env_id);
        const key = await management.createApiKey(child.org.org_id, env.env_id,
          { description: "sdk", permissions: { "*:*": ["*"] } });
        const client = runtime(key.token); clients.push(client);
        expect((await client.env.get()).org_id).toBe(child.org.org_id);
        expect(await client.org.usage()).toMatchObject({ env_id: env.env_id,
          usage_scope: "environment", limits_scope: "billing_account", usage: { team_members: 0 } });
      }
      const [a, b] = clients;
      const pa = await a.projects.create({ name: "shared-name" });
      const pb = await b.projects.create({ name: "shared-name" });
      expect(pa.project_id).not.toBe(pb.project_id);
      expect((await a.projects.get("shared-name")).project_id).toBe(pa.project_id);
      expect((await b.projects.get("shared-name")).project_id).toBe(pb.project_id);
      await expect(b.projects.get(pa.project_id)).rejects.toMatchObject({ status: 404 });
      await expect(runtime(conf.root_token).projects.get(pa.project_id)).rejects.toMatchObject({ status: 404 });
      const event = await a.events.publish({ event_type: "sdk:isolation", event_data: { owner: "a" } });
      expect((await a.events.get(event.event_id)).event_data).toEqual({ owner: "a" });
      await expect(b.events.get(event.event_id)).rejects.toMatchObject({ status: 404 });
      await expect(b.streams.subscribe(event.stream_id).next()).rejects.toMatchObject({ status: 404 });
      await expect(new HotManagementClient({ token: a.token, baseUrl }).listChildren())
        .rejects.toMatchObject({ status: 401 });
      await expect(runtime(conf.management_token).env.get()).rejects.toMatchObject({ status: 401 });
      expect((await management.listChildren({ limit: 500 })).total).toBeGreaterThanOrEqual(2);
      expect((await management.usage()).root_org_id).toBe(conf.root_org_id);
      const restricted = await management.createApiKey(children[0], envs[0], { description: "event-only",
        permissions: { "event:sdk:*": ["create", "read"] } });
      await runtime(restricted.token).events.publish({ event_type: "sdk:isolation", event_data: {} });
      await expect(runtime(restricted.token).projects.list()).rejects.toMatchObject({ status: 403 });
      const permissions = { "event:sdk:*": ["create", "read"], "stream:*": ["read"] };
      const service = await a.serviceKeys.create({ name: "sdk-service", permissions });
      const session = await a.sessions.create({ permissions });
      const other = await b.events.publish({ event_type: "sdk:isolation", event_data: {} });
      for (const credential of [service, session]) {
        const client = runtime(credential.token!);
        await client.events.publish({ event_type: "sdk:isolation", event_data: {} });
        await expect(client.events.get(other.event_id)).rejects.toMatchObject({ status: 403 });
      }
      await a.serviceKeys.revoke(service.service_key_id);
      await a.sessions.revoke(session.session_id);
      for (const credential of [service, session]) {
        await expect(runtime(credential.token!).events.publish({ event_type: "sdk:isolation", event_data: {} }))
          .rejects.toMatchObject({ status: 401 });
      }
      await management.setChildState(children[0], "suspended");
      await expect(a.env.get()).rejects.toMatchObject({ status: 401 });
      await b.env.get();
      await management.setChildState(children[0], "active");
      await a.env.get();
    } finally {
      for (const child of children) await management.setChildState(child, "archived");
    }
  });
  it("applies issuer revocation and narrowed ceilings to existing descendants", async () => {
    const conf = fixture();
    for (const token of conf.revoked) {
      await expect(runtime(token).events.publish({ event_type: "sdk:isolation", event_data: {} }))
        .rejects.toMatchObject({ status: 401 });
    }
    for (const token of conf.narrowed) {
      const client = runtime(token);
      await client.events.publish({ event_type: "sdk:isolation", event_data: {} });
      await expect(client.projects.list()).rejects.toMatchObject({ status: 403 });
      await expect(client.events.publish({ event_type: "other:blocked", event_data: {} }))
        .rejects.toMatchObject({ status: 403 });
    }
  });
});
