// Org API and sub-org isolation against a real Hot server, including
// PostgreSQL restricted roles. Run integration/suborg_fixture.py; credentials
// always belong to a disposable database. Skipped without the fixture.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HotClient, HotKeyScopeError } from "../src/index.js";

const fixtureData = process.env.HOT_TEST_SUBORG_FIXTURE;
const baseUrl = process.env.HOT_TEST_BASE_URL;
interface Fixture {
  root_org_id: string;
  root_env_id: string;
  root_token: string;
  org_token: string;
  revoked: string[];
  narrowed: string[];
}
function fixture(): Fixture { return JSON.parse(fixtureData!) as Fixture; }
function client(token: string): HotClient { return new HotClient({ token, baseUrl }); }
const slug = () => `sdk-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
const isolationEvent = { event_type: "sdk:isolation", event_data: {} };

describe.skipIf(!fixtureData)("org API integration", () => {
  it("provisions isolated children and environment credentials with an org key", { timeout: 120_000 }, async () => {
    const conf = fixture();
    const org = client(conf.org_token);
    const children: string[] = [];
    const runtimes: HotClient[] = [];
    const envs: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        const body = { name: "SDK Customer", slug: slug(), external_id: id, idempotency_key: id };
        const child = await org.orgs.create(body);
        expect(child.created).toBe(true);
        const replay = await org.orgs.create(body);
        expect(replay.org.org_id).toBe(child.org.org_id);
        expect(replay.created).toBe(false);
        expect(child.org).toMatchObject({ parent_org_id: conf.root_org_id, external_id: id, lifecycle_state: "active" });
        children.push(child.org.org_id);
        const env = await org.orgs.createEnv(child.org.org_id, { name: "production" });
        expect((await org.orgs.createEnv(child.org.org_id, { name: "production" })).env_id).toBe(env.env_id);
        expect((await org.orgs.getEnv(child.org.org_id, env.env_id)).name).toBe("production");
        expect((await org.orgs.listEnvs(child.org.org_id)).data.map((e) => e.env_id)).toContain(child.env_id);
        envs.push(env.env_id);
        const key = await org.orgs.createEnvApiKey(child.org.org_id, env.env_id,
          { description: "sdk", permissions: { "*:*": ["*"] } });
        expect(key).toMatchObject({ scope: "env", org_id: child.org.org_id, env_id: env.env_id });
        expect(key.token).toMatch(/^hot_/);
        const runtime = client(key.token!);
        runtimes.push(runtime);
        expect((await runtime.env.get()).org_id).toBe(child.org.org_id);
        expect(await runtime.org.usage()).toMatchObject({ env_id: env.env_id,
          usage_scope: "environment", limits_scope: "billing_account", usage: { team_members: 0 } });
      }
      const listed = await org.orgs.list({ limit: 100 });
      expect(listed.data.map((o) => o.org_id)).toEqual(expect.arrayContaining(children));
      expect((await org.orgs.get(children[0]!)).org_id).toBe(children[0]);
      expect(await org.orgs.usage(conf.root_org_id)).toMatchObject({ org_id: conf.root_org_id, usage_scope: "account" });

      // Project, context and build routes inside a child environment.
      const scoped = org.orgs.env(children[0]!, envs[0]!);
      const provisioned = await scoped.projects.create({ name: "provisioned" });
      await scoped.context.create("provisioned", { key: "callback.url", value: "https://example.test/hot" });
      expect((await scoped.context.list("provisioned")).data.map((v) => v.key)).toEqual(["callback.url"]);
      expect((await scoped.builds.list()).data).toEqual([]);
      const [a, b] = runtimes as [HotClient, HotClient];
      expect((await a.projects.get("provisioned")).project_id).toBe(provisioned.project_id);

      const pa = await a.projects.create({ name: "shared-name" });
      const pb = await b.projects.create({ name: "shared-name" });
      expect(pa.project_id).not.toBe(pb.project_id);
      expect((await a.projects.get("shared-name")).project_id).toBe(pa.project_id);
      expect((await b.projects.get("shared-name")).project_id).toBe(pb.project_id);
      await expect(b.projects.get(pa.project_id)).rejects.toMatchObject({ status: 404 });
      await expect(client(conf.root_token).projects.get(pa.project_id)).rejects.toMatchObject({ status: 404 });
      const event = await a.events.publish({ event_type: "sdk:isolation", event_data: { owner: "a" } });
      expect((await a.events.get(event.event_id)).event_data).toEqual({ owner: "a" });
      await expect(b.events.get(event.event_id)).rejects.toMatchObject({ status: 404 });
      await expect(b.streams.subscribe(event.stream_id).next()).rejects.toMatchObject({ status: 404 });

      // Each key kind calls only its own routes.
      const envOnOrgRoute = await a.orgs.list().catch((error: unknown) => error);
      expect(envOnOrgRoute).toBeInstanceOf(HotKeyScopeError);
      expect(envOnOrgRoute).toMatchObject({ status: 403, requiredScope: "org" });
      const orgOnRuntimeRoute = await org.env.get().catch((error: unknown) => error);
      expect(orgOnRuntimeRoute).toBeInstanceOf(HotKeyScopeError);
      expect(orgOnRuntimeRoute).toMatchObject({ status: 403, requiredScope: "env" });

      const restricted = await org.orgs.createEnvApiKey(children[0]!, envs[0]!, { description: "event-only",
        permissions: { "event:sdk:*": ["create", "read"] } });
      await client(restricted.token!).events.publish(isolationEvent);
      await expect(client(restricted.token!).projects.list()).rejects.toMatchObject({ status: 403 });
      expect((await org.orgs.listEnvApiKeys(children[0]!, envs[0]!)).data.map((k) => k.api_key_id))
        .toContain(restricted.api_key_id);

      // Rotation with no overlap retires the old secret at once; revocation stops the key.
      const rotated = await org.apiKeys.rotate(restricted.api_key_id, { overlap_seconds: 0 });
      expect(rotated.token).toMatch(/^hot_/);
      await expect(client(restricted.token!).events.publish(isolationEvent)).rejects.toMatchObject({ status: 401 });
      await client(rotated.token!).events.publish(isolationEvent);
      const narrowed = await org.apiKeys.update(restricted.api_key_id, { permissions: { "event:sdk:*": ["read"] } });
      expect(narrowed.permissions).toEqual({ "event:sdk:*": ["read"] });
      await expect(client(rotated.token!).events.publish(isolationEvent)).rejects.toMatchObject({ status: 403 });
      expect((await org.apiKeys.get(restricted.api_key_id)).scope).toBe("env");
      await org.apiKeys.revoke(restricted.api_key_id);
      await expect(client(rotated.token!).events.get(event.event_id)).rejects.toMatchObject({ status: 401 });

      const permissions = { "event:sdk:*": ["create", "read"], "stream:*": ["read"] };
      const service = await a.serviceKeys.create({ name: "sdk-service", permissions });
      const session = await a.sessions.create({ permissions });
      const other = await b.events.publish(isolationEvent);
      for (const credential of [service, session]) {
        const runtime = client(credential.token!);
        await runtime.events.publish(isolationEvent);
        await expect(runtime.events.get(other.event_id)).rejects.toMatchObject({ status: 403 });
      }
      await a.serviceKeys.revoke(service.service_key_id);
      await a.sessions.revoke(session.session_id);
      for (const credential of [service, session]) {
        await expect(client(credential.token!).events.publish(isolationEvent))
          .rejects.toMatchObject({ status: 401 });
      }

      const suspended = await org.orgs.update(children[0]!, { state: "suspended" });
      expect(suspended.lifecycle_state).toBe("suspended");
      await expect(a.env.get()).rejects.toMatchObject({ status: expect.toBeOneOf([401, 403]) });
      await b.env.get();
      await org.orgs.update(children[0]!, { state: "active" });
      await a.env.get();
    } finally {
      for (const child of children) await org.orgs.update(child, { state: "archived" });
    }
  });

  it("mints, lists and revokes org API keys", { timeout: 60_000 }, async () => {
    const conf = fixture();
    const org = client(conf.org_token);
    const minted = await org.orgs.createApiKey(conf.root_org_id, {
      description: "sdk reader",
      permissions: { "org:*": ["read"] },
    });
    expect(minted).toMatchObject({ scope: "org", org_id: conf.root_org_id, env_id: null });
    const reader = client(minted.token!);
    await reader.orgs.list();
    await expect(reader.orgs.create({ name: "x", slug: slug(), idempotency_key: randomUUID() }))
      .rejects.toMatchObject({ status: 403 });
    expect((await org.orgs.listApiKeys(conf.root_org_id)).data.map((k) => k.api_key_id))
      .toContain(minted.api_key_id);
    await org.apiKeys.revoke(minted.api_key_id);
    await expect(reader.orgs.list()).rejects.toMatchObject({ status: 401 });
  });

  it("applies issuer revocation and narrowed grants to existing descendants", async () => {
    const conf = fixture();
    for (const token of conf.revoked) {
      await expect(client(token).events.publish(isolationEvent)).rejects.toMatchObject({ status: 401 });
    }
    for (const token of conf.narrowed) {
      const runtime = client(token);
      await runtime.events.publish(isolationEvent);
      await expect(runtime.projects.list()).rejects.toMatchObject({ status: 403 });
      await expect(runtime.events.publish({ event_type: "other:blocked", event_data: {} }))
        .rejects.toMatchObject({ status: 403 });
    }
  });
});
