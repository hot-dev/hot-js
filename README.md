# @hot-dev/sdk

Official JavaScript/TypeScript SDK for the [Hot Dev](https://hot.dev) API.

## Install

```bash
npm install @hot-dev/sdk
```

The published SDK supports Node 20+ (CI tests Node 20, 22 and 24). Development and CI builds use Node 24.22.1, pinned in `.node-version`. Server-side only — use a backend proxy for browser apps (see `@hot-dev/sdk/proxy`, which requires an event type allow-list).
Most administrative endpoints require an API key; sessions and service keys are
permission-scoped and are mainly for event publishing and stream reads. The org
API (`hot.orgs`, `hot.apiKeys`) takes an org API key instead.

## Quick start

```typescript
import { HotClient } from "@hot-dev/sdk";

const hot = new HotClient({
  token: process.env.HOT_API_KEY!,
});

// `baseUrl` defaults to https://api.hot.dev.
// For local development with `hot dev`, pass `baseUrl: "http://localhost:4681"`.

for await (const event of hot.streams.subscribeWithEvent({
  event_type: "team-agent:ask",
  event_data: {
    session_id: "web:chat:demo",
    user_id: "web:user:demo",
    user_name: "Demo User",
    question: "what is blocking launch?",
  },
})) {
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

## Retries and timeouts

JSON requests time out after `timeoutMs` (client option, default 60 s) and are
retried at most twice: on a 429 that carries `retry_after`, and for GET, HEAD,
PUT and DELETE on a 502, 503 or 504. Other errors are thrown as-is. Streaming
and raw requests are not retried.

Durable waiters (`runs.wait`, `tasks.wait`, `streams.subscribeWithEvent`,
`events.callHot`, `waitForRunResult`) stop on permanent 4xx errors, reconnect
after transport errors, 408, 429 and 5xx with jittered backoff, and treat the
server's 5-minute stream rollovers as healthy. See
[the package README](./packages/sdk/README.md#durable-waits-and-reconnects).

## Casing policy

Core API request and response types use the Hot API wire format (`event_type`,
`stream_id`, `event_data`). SDK-only options use normal JavaScript casing
(`baseUrl`, `timeoutMs`). The SDK never transforms user-owned payloads such as
`event_data`.

## Exports

| Import | Purpose |
|--------|---------|
| `@hot-dev/sdk` | `HotClient`, core types, `HotApiError`, `HotKeyScopeError` |
| `@hot-dev/sdk/streaming` | SSE parsing, `waitForRunResult` |
| `@hot-dev/sdk/agent` | Agent event payloads, slash commands, reply folding |
| `@hot-dev/sdk/webhook` | Webhook URL builder and POST helper |
| `@hot-dev/sdk/proxy` | BFF proxy handler for Next.js routes |

Full API reference: [`packages/sdk/README.md`](./packages/sdk/README.md).

## Related

- [Hot Dev documentation](https://hot.dev/docs)
- [SDK docs](https://hot.dev/docs/api/sdks)

## Developing this repo

```bash
pnpm install
pnpm build
pnpm test
```

Uses [pnpm](https://pnpm.io/) workspaces. See [AGENTS.md](./AGENTS.md) for maintainer notes.

## License

Apache-2.0
