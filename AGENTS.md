# hot-js

JavaScript/TypeScript SDK monorepo for Hot Dev.

## Packages

- **`@hot-dev/sdk`** — Hot API client (`/v1/*`), SSE streaming, agent reply helpers, webhook URL builders.

Subpath exports:

- `@hot-dev/sdk` — `HotClient` and core types
- `@hot-dev/sdk/streaming` — SSE parsing and stream event types
- `@hot-dev/sdk/agent` — agent event payloads, slash-command parsing, reply folding
- `@hot-dev/sdk/webhook` — webhook URL helpers
- `@hot-dev/sdk/proxy` — BFF/proxy helpers for Next.js and similar frameworks

## Conventions

- **Layer 1** (`HotClient`, resource namespaces): thin REST mirror of the Hot API. No product opinions.
- **Layer 2** (`/agent`, `/streaming`): helpers for building chat/agent clients on Hot's event + run stream model.
- **App code** (demos, your product): slash-command tables, UI state, session-id policy.

Server-side only for authenticated API calls. Browser clients should proxy through your backend (see `/proxy`).

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## CI and Releases

- CI runs on pushes and pull requests to `main`: install, typecheck, lint, test, and build.
- npm releases run from tags named `v{packages/sdk/package.json version}`.
- Publishing requires the repository secret `NPM_TOKEN` and publishes `packages/sdk` with npm provenance.

Release flow:

```bash
pnpm --filter @hot-dev/sdk exec npm version <version> --no-git-tag-version
git add packages/sdk/package.json
git commit -m "release v<version>"
git tag v<version>
git push origin main v<version>
```

## Local linking

To test against [hot-demos/hot-chat](https://github.com/hot-dev/hot-demos) before npm publish:

```bash
cd packages/sdk && pnpm build
cd /path/to/hot-demos/hot-chat && pnpm link ../../hot-js/packages/sdk
```

Or use hot-chat's `npm run link:sdk`.

## pnpm / Corepack

This repo requires **pnpm**, not npm. If `pnpm install` fails with a Corepack signature error, use Node 22+ LTS or run `npm install -g corepack@latest && corepack prepare pnpm@10.11.0 --activate`.

## Related repos

- [`hot`](https://github.com/hot-dev/hot) — runtime and API server
- [`hot-demos`](https://github.com/hot-dev/hot-demos) — Hot Chat and agent demos
