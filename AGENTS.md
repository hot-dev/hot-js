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

## Integration Tests

`integration/run.sh` starts a scratch `hot dev` (requires the `hot` CLI and
python3 on PATH) serving the Hot fixture project in `integration/fixture`
(project `sdk-fixture`: an echo event handler, an always-failing handler and
function, and hot:call targets). It binds 127.0.0.1 on HOT_TEST_PORT (default
4724), mints a full-access API key directly in the fixture's sqlite database,
exports HOT_TEST_BASE_URL / HOT_TEST_API_KEY, and runs `vitest run test/integration.test.ts` in packages/sdk.
The integration tests skip when HOT_TEST_API_KEY is unset, so regular test
runs are unaffected. The fixture pins the API to 127.0.0.1 because binding
"localhost" can yield an IPv6-only listener that JDK-style clients (which
dial the first resolved address only) cannot reach.

## Lockstep Releases

All five SDK repos (hot-js, hot-python, hot-go, hot-rust, hot-java) release in
lockstep. Checklist for a coordinated release:

1. Bump every SDK's version: js `npm version` (syncs src/version.ts via the
   `version` script), python pyproject.toml, rust Cargo.toml, java
   gradle.properties + README snippets, go `Version` constant in client.go.
2. Regenerate each repo's openapi-operations fixture from a current `hot dev`
   and reconcile the coverage tables.
3. Run every repo's `integration/run.sh`.
4. Commit, tag `v<version>`, push in each repo.

The integration fixture (integration/fixture, mint_key.py, run.sh) is
duplicated across all five repos; the canonical copy lives in **hot-python** —
change it there first, then sync the others.
