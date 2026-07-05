# Contributing

This guide is for people changing Anima itself. User-facing setup and usage live in `README.md` and `docs/`.

## Dev Setup

Start from a source checkout:

```bash
git clone https://github.com/MeetQuinn/anima.git
cd anima
pnpm install
pnpm build
```

Run the local development services with a repo-local Anima home:

```bash
pnpm dev:services:start
pnpm dev:services:status
pnpm dev:services:restart
pnpm dev:services:stop
```

The `dev:services:*` commands run `scripts/ensure-dev-anima-home.mjs` and set `ANIMA_HOME=./.anima-dev`. That keeps development config, state, logs, and pid files inside the clone instead of touching a managed `~/.anima/` install.

The dev dashboard uses the repo-local config and defaults to:

```text
http://127.0.0.1:14174
```

A development rebuild should not change the code a live managed install runs. Use the dev service commands for the repo-local environment and the normal `animactl services` commands only when you mean to operate another selected `ANIMA_HOME`.

Core build and test commands:

```bash
pnpm build           # full server + web production build
pnpm build:server    # server + shared TypeScript build; skips Vite
pnpm typecheck       # server TypeScript only
pnpm type-check      # server + web TypeScript
pnpm lint            # web ESLint
pnpm test            # fast default gate: server build + unit/api tests
pnpm test:fast:dist  # fast server tests against an existing dist
pnpm test:runtime    # heavier CLI/provider/service subprocess tests
pnpm test:all        # full build + every compiled server test file
```

The docs site is VitePress:

```bash
pnpm docs:dev
pnpm docs:build
```

`pnpm docs:dev` previews at `http://127.0.0.1:14175/`.

## Project Layout

`server/` contains the runtime, API, CLIs, transports, provider adapters, services, and stores.

`shared/` contains schemas and types used by both server and web.

`web/` contains the Vite + React dashboard package.

`packages/animactl` is the published package shell populated from built output.

For the code-level map, see `docs/architecture/internals.md`.

## Making Changes

Branch from `main`.

Keep PRs to one concern. If a change crosses layers, state why in the PR.

A useful PR description states the boundary touched, the invariants that matter, and the verification commands run.

Minimum local verification for most PRs is:

```bash
pnpm type-check
pnpm lint
pnpm test
```

Run `pnpm test:runtime` when touching provider adapters, agent-facing CLI behavior, `animactl` service process behavior, runtime worker behavior, subprocess launch, restart/drain behavior, or launchd/system service code.

Server tests use Node's test runner over compiled files in `dist/server/tests`. Run `pnpm build:server` before single-file dist test commands.

The test tiers are listed in `scripts/run-tests.mjs`. That runner audits tier membership, so a new `server/tests/*.test.ts` file must be added to exactly one tier or the runner fails.

## Style Expectations

TypeScript is strict, NodeNext ESM. Source imports use `.js` suffixes even when the file on disk is `.ts`.

Do not add runtime dependencies without discussion. This project prefers small direct code over another library when the behavior is narrow.

Prefer flat, direct code over indirection. Wrapper layers that only forward arguments are usually rejected.

Validate at boundaries: user input, platform/API responses, file reads, and environment variables. Internal callers should not be wrapped in defensive checks without a concrete failure mode to handle.

Keep stores and services separate. `server/storage/schema/*.store.ts` owns direct persistence for one file family. Business orchestration belongs in service modules.

Tests should not use fixed sleeps for asynchronous effects. Use `waitFor` from `server/tests/helpers/harness.ts`; if a deliberate delay is necessary, add a short comment explaining the timing being simulated.

## Docs

Docs are VitePress under `docs/`. The public sidebar and nav are in `docs/.vitepress/config.ts`.

User guides live under `docs/guide/`.

Agent-facing command docs live under `docs/agent/`.

Architecture docs live under `docs/architecture/`, with provider-specific details in `docs/runtime-providers.md`.

Run `pnpm docs:build` before sending docs changes that add pages or links.

## License

Contributions are licensed under Apache-2.0.
