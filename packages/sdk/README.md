# @hot-dev/sdk

JavaScript/TypeScript SDK for the [Hot Dev](https://hot.dev) API.

## Install

```bash
npm install @hot-dev/sdk
# or
pnpm add @hot-dev/sdk
```

## Quick start

```typescript
import { HotClient } from "@hot-dev/sdk";

const hot = new HotClient({
  baseUrl: process.env.HOT_API_URL ?? "http://localhost:4681",
  token: process.env.HOT_API_KEY!,
});

// `baseUrl` defaults to https://api.hot.dev.

for await (const event of hot.streams.subscribeWithEvent({
  event_type: "team-agent:ask",
  event_data: {
    session_id: "web:chat:demo",
    user_id: "web:user:demo",
    user_name: "Demo User",
    question: "what is blocking launch?",
  },
})) {
  if (event.type === "event:published") {
    console.log("published", event.event_id);
  }

  if (event.type === "stream:data") {
    console.log(event.data_type, event.payload);
  }

  if (event.type === "run:stop") {
    console.log(event.run?.result);
    break;
  }
}
```

## JavaScript and TypeScript

The SDK works from both JavaScript and TypeScript. TypeScript users get typed
request and response shapes, stream event narrowing, and helper types from the
subpath exports.

The package is ESM-only, so JavaScript projects should use `import` rather than
`require`. JavaScript users can enable editor type hints with JSDoc:

```javascript
// @ts-check
import { HotClient } from "@hot-dev/sdk";

/** @type {import("@hot-dev/sdk").PublishEventRequest} */
const event = {
  event_type: "team-agent:ask",
  event_data: { question: "What changed?" },
};

const hot = new HotClient({
  token: process.env.HOT_API_KEY,
});

await hot.events.publish(event);
```

## Subpath exports

| Import | Purpose |
|--------|---------|
| `@hot-dev/sdk` | `HotClient`, core types, `HotApiError`, `HotKeyScopeError`, `HotRunError`, `HotTaskError` |
| `@hot-dev/sdk/streaming` | SSE parsing, `waitForRunResult` |
| `@hot-dev/sdk/agent` | Agent event payloads, slash commands, reply folding |
| `@hot-dev/sdk/webhook` | Webhook URL builder and POST helper |
| `@hot-dev/sdk/proxy` | BFF proxy handler for Next.js routes |

## Layer 1 — API client

`HotClient` mirrors Hot API v1 resources:

- `hot.events` — publish, list, get, and inspect event runs (plus `callHot(fn, args)`)
- `hot.streams` — subscribe to run and task updates and publish events atomically (reconnects automatically across the 5-minute SSE timeout; pass `{ reconnect: false }` to opt out)
- `hot.runs` — list, inspect, subscribe to, and wait for durable runs
- `hot.tasks` — get, subscribe to, and wait for durable background tasks
- `hot.files` — upload, download, list, and delete files (including multipart uploads)
- `hot.projects` — create, list, update, activate, deactivate, and delete projects
- `hot.builds` — upload, download, deploy, and look up live/deployed builds
- `hot.context` — manage encrypted project context variables
- `hot.domains` — register, verify, list, and delete custom domains
- `hot.sessions` — create and revoke scoped sessions
- `hot.serviceKeys` — create and revoke scoped service keys
- `hot.org` — view this environment's usage and limits
- `hot.env` — read environment info, subscribe to environment events, and purge call traces
- `hot.orgs` and `hot.apiKeys` — the org API (child organizations, environments and API keys); these need an org API key, see [Org API](#org-api)

`hot.runs.purgeCalls(runId)`, `hot.streams.purgeCalls(streamId)` and
`hot.env.purgeCalls()` delete call traces (the runs remain); repeat a purge
while its result has `complete: false`.

Authenticated calls can use API keys, sessions, or service keys, but administrative runtime
endpoints such as projects, builds, files, runs, org usage, and env info require
an API key. Sessions and service keys are permission-scoped and are intended for
event publishing and stream reads where their permissions allow it.
Administrative calls also need the matching grant: listing projects needs
`project:*` with `read`, and env info and usage need `env:{env_id}` with
`read`. Event-only keys get `403` for them.

`hot.env.subscribe()` requires API key credentials and a live API pub/sub
backend; local API servers without pub/sub return a 503. `subscribeWithEvent`
reconnects across the API's 5-minute SSE limit and stops after the terminal
run correlated to the event it published. Unrelated runs on the same stream do
not end the iterator. A run with status `pending_retry` is not finished, whatever
the event type: the handler will be retried as a new run (linked by
`origin_run_id`), and the iterator follows it. When the server replays a retried
attempt as `run:fail` with status `failed` and a raised `retry_attempt`, the
helpers wait up to 5 s (or until `timeoutMs`) for the retry run before they
treat the failure as final.

When code has a run id but does not need the full stream, wait on its durable
terminal snapshot:

```typescript
const run = await hot.runs.wait(runId, { timeoutMs: 300_000 });
console.log(run.result);
```

When a run returns a background task id, wait without keeping that run alive:

```typescript
const task = await hot.tasks.wait(taskId, { timeoutMs: 300_000 });
console.log(task.result);
```

The task waiter receives the latest persisted state first and reconnects, so it
cannot miss a task that completed before subscription. A failed, cancelled, or
timed-out task throws `HotTaskError` with the final task record.

To coordinate several tasks, wait on each one:

```typescript
const tasks = await Promise.all(taskIds.map((id) => hot.tasks.wait(id, { timeoutMs: 1_800_000 })));
console.log(tasks.map((task) => task.result));
```

`hot.streams.subscribe(streamId)` is a single connection: the server ends it
after 5 minutes with `stream:complete`, whether or not the stream's tasks are
done, so do not use it to wait for work.

### Durable waits and reconnects

`runs.wait`, `tasks.wait`, `streams.subscribeWithEvent`, `events.callHot` and
`waitForRunResult` share one reconnect policy:

- They stop at once on permanent errors: any 4xx except 408 and 429 (so 400,
  401, 403, 404, 409, 410, 422).
- They reconnect after transport errors, 408, 429 and 5xx, with jittered
  exponential backoff (about 0.25–0.5 s, then doubling to at most 10 s) that
  honours `retry_after`. Backoff never sleeps past `timeoutMs`; a wait that
  would fails with a `TimeoutError` whose `cause` is the last error.
- `maxReconnectAttempts` (default 5) counts consecutive failed connections. A
  connection that delivered a new event, or ended with the server's 5-minute
  `stream:complete` rollover, resets the count and reconnects at once, so long
  runs are bounded only by `timeoutMs`.
- `timeoutMs` is absolute: it covers connecting, waiting for headers, reading
  and backoff. A connection silent for 45 s (three missed keepalives) counts as
  a failed connection.

`callHot` and `waitForRunResult` pass `onChunk` the `text` of each
`stream:data` payload in order. The server can send a run's chunks, and even
its `run:stop`, before its `run:start`; the SDK holds early chunks until it can
tell which run they belong to.

### Requests without a helper

`hot.request(method, path, init?)` calls any JSON endpoint and returns the
parsed envelope; `hot.requestRaw(method, path, init?)` returns the raw
`Response`. Paths are relative to `{baseUrl}/v1` (a leading `/v1` is accepted):

```typescript
const envelope = await hot.request<{ data: { total_runs: number } }>("GET", "/runs/stats");
console.log(envelope.data.total_runs);
```

JSON requests (helpers and `request`) time out after `timeoutMs` (a client
option, default 60 s; `0` disables it). They retry a 429 that carries
`retry_after` and, for GET, HEAD, PUT and DELETE, a 502, 503 or 504, at most
twice. Streams, uploads, downloads and `requestRaw` have no timeout and are
never retried.

The test suite includes an OpenAPI coverage check. Refresh the operation fixture
from a local API server with:

```bash
pnpm --filter @hot-dev/sdk run update:openapi-fixture
```

You can also pass a file path or URL:

```bash
pnpm --filter @hot-dev/sdk run update:openapi-fixture -- ./openapi.json
```

### Casing policy

Layer 1 request and response types match the Hot API wire format:

```typescript
await hot.events.publish({
  event_type: "team-agent:ask",
  event_data: {
    session_id: "web:chat:demo",
    user_id: "web:user:demo",
  },
});
```

SDK-only options use JavaScript casing:

```typescript
await hot.events.callHot("::app/do-work", [], { timeoutMs: 30_000 });
```

The SDK never transforms keys inside user-owned payloads such as `event_data`.

## Layer 2 — Agent helpers

Agent handlers emit reply streams as `{agent}:reply:delta|end|error`. Use `foldAgentReply` to consume them.

Slash-command routing is **app configuration** — pass your own command map:

```typescript
import { parseSlashCommand, buildAgentEventData, buildWebMessageIds } from "@hot-dev/sdk/agent";

const { event, payload } = parseSlashCommand("/ask what is blocking?", {
  ask: { event: "team-agent:ask", argKey: "question" },
}, { fallbackEvent: "team-agent:record" });

const ids = buildWebMessageIds({
  userId: "web:user:u1",
  chatId: "c1",
  sessionMode: "chat",
});

const event_data = buildAgentEventData({
  session_id: ids.sessionId,
  user_id: "web:user:u1",
  payload,
});
```

## Next.js proxy

The proxy publishes browser events with a server-side credential, so it must
decide what browsers may publish. `allowEventTypes` is required: list exact
event types or prefix patterns (`"chat:*"`). `hot:` types such as `hot:call`,
which runs any function, are rejected unless listed exactly. Use the
`authorize` hook to check the signed-in user and to put their identity into
`event_data`; it must return `true`, a replacement event, or a `Response`, and
anything else answers 403.

Give the proxy the narrowest credential that works: a per-user session or
service key whose permissions cover only the events and streams that user may
use, not a full-access API key. Mint it server-side and cache it per user:

```typescript
// app/api/chat/route.ts
import { HotClient } from "@hot-dev/sdk";
import { createHotProxyRoute } from "@hot-dev/sdk/proxy";

// Server-only key that may create sessions; never sent to browsers.
const admin = new HotClient({
  baseUrl: process.env.HOT_API_URL!,
  token: process.env.HOT_API_KEY!,
});

async function clientFor(request: Request): Promise<HotClient> {
  const user = await requireUser(request); // your auth; throws when signed out
  // Cache the session per user in production instead of minting one per request.
  const session = await admin.sessions.create({
    permissions: { "event:team-agent:*": ["create"], "stream:*": ["read"] },
    metadata: { user_id: user.id },
    expires_in: 3600,
  });
  return new HotClient({ baseUrl: process.env.HOT_API_URL!, token: session.token! });
}

export const POST = createHotProxyRoute(clientFor, {
  allowEventTypes: ["team-agent:ask"],
  authorize: async (request, event) => {
    const user = await requireUser(request);
    return { ...event, event_data: { ...(event.event_data as object), user_id: user.id } };
  },
});
```

By default the proxy ignores a browser-supplied `stream_id` and starts a new
stream for every request. Pass `allowStreamId` (a predicate that checks the
caller owns the stream) to continue a stream; events on a continued stream are
filtered to the runs of the event the request published.

## Org API

Organizations, environments and API keys are resources on the normal
`HotClient`, called with an **org API key** (created by a root admin in the
App). An org key calls only `/v1/orgs` and `/v1/api-keys`; environment API
keys, service keys and sessions call every other route. Calling a route with
the wrong kind of key throws `HotKeyScopeError` (`403 key_scope_mismatch`),
whose `requiredScope` is `"org"` or `"env"`.

```typescript
import { HotClient, HotKeyScopeError } from "@hot-dev/sdk";

const org = new HotClient({ token: process.env.HOT_ORG_KEY! });

// Idempotent: replaying the same idempotency_key returns the same child.
const child = await org.orgs.create({
  name: "Customer",
  slug: "customer-unique-slug", // 32 characters or fewer
  external_id: "crm-123",
  idempotency_key: "customer-provisioning-123",
});
const env = await org.orgs.createEnv(child.org.org_id, { name: "production" });

// Projects, context and builds inside that environment, with the org key.
const scoped = org.orgs.env(child.org.org_id, env.env_id);
await scoped.projects.create({ name: "backend" });
await scoped.context.create("backend", { key: "callback.url", value: "https://example.test/hot" });

// Runtime calls need an environment key; mint one within the org key's grants.
const key = await org.orgs.createEnvApiKey(child.org.org_id, env.env_id, {
  description: "Customer backend",
  permissions: { "event:*": ["create", "read"], "run:*": ["read"], "stream:*": ["read"] },
});
const customer = new HotClient({ token: key.token! });
await customer.events.publish({ event_type: "app:hello", event_data: {} });

try {
  await org.env.get();
} catch (error) {
  if (error instanceof HotKeyScopeError) console.log(error.requiredScope); // "env"
}
```

| Method | Route |
| --- | --- |
| `orgs.list(query?)` | `GET /v1/orgs` — children the key may read (list envelope) |
| `orgs.create(body)` | `POST /v1/orgs` — `{ org, env_id, created }` |
| `orgs.get(orgId)` / `orgs.update(orgId, { state })` | `GET` / `PATCH /v1/orgs/{org_id}` (`active`, `suspended`, `archived`) |
| `orgs.usage(rootOrgId)` | `GET /v1/orgs/{org_id}/usage` — account usage; pass the root org's ID |
| `orgs.purgeCalls(orgId, { include_sub_orgs? })` | `DELETE /v1/orgs/{org_id}/calls` |
| `orgs.listEnvs(orgId)` / `orgs.createEnv(orgId, { name })` / `orgs.getEnv(orgId, envId)` | `/v1/orgs/{org_id}/envs` (create is idempotent by name) |
| `orgs.listApiKeys(orgId)` / `orgs.createApiKey(orgId, body)` | `/v1/orgs/{org_id}/api-keys` — org keys of the key's own org |
| `orgs.listEnvApiKeys(orgId, envId)` / `orgs.createEnvApiKey(orgId, envId, body)` | `/v1/orgs/{org_id}/envs/{env_id}/api-keys` |
| `orgs.env(orgId, envId).projects` / `.context` / `.builds` | `/v1/orgs/{org_id}/envs/{env_id}/projects/...`, `/builds` |
| `apiKeys.get(id)` / `apiKeys.update(id, { permissions })` / `apiKeys.revoke(id)` / `apiKeys.rotate(id, { overlap_seconds? })` | `/v1/api-keys/{key_id}` |

Minted keys return their `token` once. Grants of a minted key must fit inside
the minting key's grants; revoking, narrowing or expiring a key restricts
everything it issued, including service keys and sessions created with the
environment keys it minted. Rotation keeps the key ID and lets the previous
secret work for `overlap_seconds` (default one day). See
[the org API reference](https://hot.dev/docs/api/management).

`hot.org.usage()` (an environment-key call) reports only that environment's
consumption, with `usage_scope: "environment"` and
`limits_scope: "billing_account"`; use `orgs.usage(rootOrgId)` for the account.

For a multi-customer BFF, authorize the signed-in user's target on your
backend, then choose that environment's client before proxying (see the
client function form of `createHotProxyRoute`). The proxy never switches scope
from browser-supplied org IDs. Keep org keys and environment keys server-side.
Webhook URL helpers use the child's own `orgSlug` and `envName`.

### Sub-org integration tests

See [the validation record](../../integration/VALIDATION.md) for the tested server revision and results.

The fixture creates an owned disposable database and loopback API server,
seeds a top org API key and a root environment key, runs the SDK tests, and
removes only its own resources. The canonical fixture lives in hot-python and
is synchronized across all five SDKs. No deployed credentials are used.
Requires Python 3 and a Hot CLI built from the revision in
`integration/hot-server.ref`.
For PostgreSQL, also install Docker and `psql` and provide the public hot checkout
(default: sibling `hot`). Migrations use a non-superuser schema owner; the API
uses a distinct non-owner `NOSUPERUSER NOBYPASSRLS` login with RLS enforcement.
The fixture's administrator seeds credentials only; SDK calls always use HTTP.

```bash
python3 integration/suborg_fixture.py --hot ../hot/target/debug/hot --backend postgres -- \
  pnpm --filter @hot-dev/sdk exec vitest run test/suborg-integration.test.ts
# For SQLite, use --backend sqlite.
```

Coverage includes provisioning and environment idempotency, org-scoped project
and context calls, identical project names in siblings, foreign-ID and stream
denial, parent runtime isolation, org/environment key separation
(`HotKeyScopeError`), usage scope, restricted API-key grants, rotation,
narrowing and revocation, org key minting, service/session issuance and
revocation, pre-existing descendant issuer revocation/narrowing, and child
suspension/resumption.

## License

Apache-2.0
