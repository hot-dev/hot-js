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
| `@hot-dev/sdk` | `HotClient`, core types, `HotApiError`, `HotRunError`, `HotTaskError` |
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
- `hot.org` — view usage and limits
- `hot.env` — read environment info and subscribe to environment events

Authenticated calls can use API keys, sessions, or service keys, but administrative runtime
endpoints such as projects, builds, files, runs, org usage, and env info require
an API key. Sessions and service keys are permission-scoped and are intended for
event publishing and stream reads where their permissions allow it.

`hot.env.subscribe()` requires API key credentials and a live API pub/sub
backend; local API servers without pub/sub return a 503. `subscribeWithEvent`
reconnects across the API's 5-minute SSE timeout and stops after the terminal
run correlated to the event it published. Unrelated runs on the same stream do
not end the iterator.

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
The task's parent stream also emits durable `task:update` events, which is
useful when one subscription needs to coordinate several tasks.

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

Keep `HOT_API_KEY` server-side:

```typescript
// app/api/chat/route.ts
import { HotClient } from "@hot-dev/sdk";
import { createHotProxyRoute } from "@hot-dev/sdk/proxy";

const hot = new HotClient({
  baseUrl: process.env.HOT_API_URL!,
  token: process.env.HOT_API_KEY!,
});

export const POST = createHotProxyRoute(hot);
```

## License

Apache-2.0

## Sub-organization management

Requires a Hot server release containing the sub-org management API. Use the
separate `HotManagementClient` with an `hm_` credential issued by a root admin.
Runtime API keys, service keys, and sessions cannot call management endpoints;
management credentials cannot call runtime endpoints. Create a runtime client
per environment credential. A root environment key cannot access its children,
and a child key cannot access siblings. There is no tenant or org selector on
runtime methods. Each child owns its environments and deployments.

```typescript
import { HotClient, HotManagementClient } from "@hot-dev/sdk";

const management = new HotManagementClient({ token: managementToken });
const child = await management.createChild({
  name: "Customer", slug: "customer-unique-slug",
  idempotency_key: "customer-provisioning-123",
});
const key = await management.createApiKey(child.org.org_id, child.env_id, {
  description: "Customer backend", permissions: { "*:*": ["*"] },
});
const customer = new HotClient({ token: key.token });
console.log(await customer.env.get());
```

For a multi-customer BFF, authorize the signed-in user's target on your backend,
then choose that environment's client before invoking `createHotProxyHandler`.
The proxy helper is bound to the client you pass; it does not switch scope from
browser-supplied org IDs. Keep management tokens and environment keys server-side.
Webhook URL helpers use the child's own `orgSlug` and `envName`; the URL shape
stays `/webhook/{orgSlug}/{envName}/{service}/{path}`.

| Management method | Purpose |
| --- | --- |
| `listChildren(query?)` | List authorized children (returns `children` and `total`) |
| `createChild(body)` | Provision a child and default environment |
| `setChildState(childId, state)` | Set `active`, `suspended`, or `archived` (no response body) |
| `createEnvironment(childId, body)` | Provision a child environment by name |
| `createApiKey(childId, envId, body)` | Issue a child API key within the delegation ceiling |
| `usage()` | Read account-wide usage |

Child creation requires a stable `idempotency_key`; reuse it for retries of the
same request. A different payload with that key is rejected. Environment
creation is idempotent within a child by exact name. Listing accepts `limit`
(maximum 500) and `offset`. Account usage requires `usage:read` and explicit
`all_children` authority. Management credentials cannot issue other management
credentials or grant human access. Service keys and sessions are issued with the
child environment's runtime API key and inherit its management issuer chain.
Issuer expiry, revocation, or permission narrowing restrict existing descendants;
expansion never expands their stored grants.

Administrative runtime operations require an API key **and** the appropriate
resource/action grants. For example, project listing requires `project:*` with
`read`, and environment info and usage require `env:{env_id}` with `read`.
Event-only keys receive `403` for these operations; API-key status alone does
not grant administration. Full-access `{"*:*": ["*"]}` keys retain access.
See the server's [permission contract](https://hot.dev/docs/api/management).

`org.usage` reports only the credential's **environment consumption**, with
`env_id`, `usage_scope: "environment"`, and `limits_scope: "billing_account"`.
Its limits and plan come from the billing root; percentages compare this one
environment against shared limits and do not describe remaining account quota.
`usage.team_members` is zero because seats belong to the account. Use management
`usage` for the account aggregate. Existing runtime endpoints and request bodies
keep their shapes. JSON requests retain bounded 429/Retry-After handling;
streaming reconnects and waiters stop on permanent `401`/`403` authorization errors.

### Sub-org integration tests

See [the validation record](../../integration/VALIDATION.md) for the tested server revision and results.

The fixture creates an owned disposable database and loopback API server, runs
the SDK tests, and removes only its own resources. The canonical fixture lives
in hot-python and is synchronized across all five SDKs. No deployed credentials
are used. Requires Python 3 and a Hot CLI built from the matching server branch.
For PostgreSQL, also install Docker and `psql` and provide the public hot checkout
(default: sibling `hot`). Migrations use a non-superuser schema owner; the API
uses a distinct non-owner `NOSUPERUSER NOBYPASSRLS` login with RLS enforcement.
The fixture's administrator seeds credentials only; SDK calls always use HTTP.

```bash
python3 integration/suborg_fixture.py --hot ../hot/target/debug/hot --backend postgres -- \
  node packages/sdk/node_modules/vitest/vitest.mjs run --root packages/sdk test/suborg-integration.test.ts
# For SQLite, use --backend sqlite.
```

Coverage includes provisioning and environment idempotency, identical project
names in siblings, foreign-ID and stream denial, parent runtime isolation,
management/runtime token separation, usage scope, restricted API-key grants,
service/session issuance and revocation, pre-existing descendant issuer
revocation/narrowing, and child suspension/resumption.
