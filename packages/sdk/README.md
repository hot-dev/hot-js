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
| `@hot-dev/sdk` | `HotClient`, core types, `HotApiError` |
| `@hot-dev/sdk/streaming` | SSE parsing, `waitForRunResult` |
| `@hot-dev/sdk/agent` | Agent event payloads, slash commands, reply folding |
| `@hot-dev/sdk/webhook` | Webhook URL builder and POST helper |
| `@hot-dev/sdk/proxy` | BFF proxy handler for Next.js routes |

## Layer 1 — API client

`HotClient` mirrors Hot API v1 resources:

- `hot.events` — publish, list, get, and inspect event runs (plus `callHot(fn, args)`)
- `hot.streams` — subscribe to run streams and publish events atomically (reconnects automatically across the 5-minute SSE timeout; pass `{ reconnect: false }` to opt out)
- `hot.runs` — list, inspect, and view run stats
- `hot.files` — upload, download, list, and delete files (including multipart uploads)
- `hot.projects` — create, list, update, activate, deactivate, and delete projects
- `hot.builds` — upload, download, deploy, and look up live/deployed builds
- `hot.context` — manage encrypted project context variables
- `hot.domains` — register, verify, list, and delete custom domains
- `hot.sessions` — create and revoke scoped sessions
- `hot.serviceKeys` — create and revoke scoped service keys
- `hot.org` — view usage and limits
- `hot.env` — read environment info and subscribe to environment events

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
