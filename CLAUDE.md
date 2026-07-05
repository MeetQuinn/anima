# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Anima is a local runtime that turns a code-agent runtime (Codex CLI, Claude Code, or Kimi) into a durable teammate in Slack or Feishu. One agent identity maps to one **primary provider session** that spans every DM, channel, chat, and thread - not one session per thread. See `docs/architecture/overview.md` for the architecture and `README.md` for the user-facing pitch.

## Commands

```bash
pnpm build           # rm -rf dist, tsc, build UI; produces dist/server and dist/web
pnpm build:server    # rebuild dist/server, dist/shared, and dist/tests only; skips Vite
pnpm typecheck       # tsc --noEmit, no UI
pnpm test            # default fast gate: server build + unit/api tests
pnpm test:fast:dist  # run the fast gate against an already-built dist
pnpm test:runtime    # heavier CLI/provider/service subprocess integration tests
pnpm test:all        # full build + every compiled test file
```

Run a single test (after `pnpm build:server`):

```bash
node --test dist/tests/runtime.test.js
node --test --test-name-pattern='primary session' dist/tests/runtime.test.js
```

Services. `animactl services` is an environment-neutral supervisor. Target an environment by setting `ANIMA_HOME`; the web app port comes from that environment's `config.json` `dashboardPort` (default 4174).

```bash
pnpm services:status
pnpm services:restart           # builds, then stops + starts agent + web app
pnpm services:stop
pnpm services:start
```

CLIs (`dist/server/cli/animactl.js` for environment control, `dist/server/cli/anima.js` is on the agent runtime's PATH):

```bash
node dist/server/cli/animactl.js server                 # chat transports + reminder scheduler + worker loop (foreground)
node dist/server/cli/animactl.js web                    # local Anima web app (foreground)
node dist/server/cli/animactl.js services <op>          # supervisor: daemon server + web for one env (start|stop|restart|status)
```

Global flag on `animactl`: `--agent <id>` goes **before** the subcommand. The Anima home is resolved via `ANIMA_HOME` env var, then `./.anima` if present, then `~/.anima`. The Anima home holds config and state together (`config.json`, `agents/<id>/config.json`, `agents/<id>/inbox.json`, sessions, activities, reminders, subscriptions).

## Architecture

The repo is one TypeScript Node ESM project (`"type": "module"`, NodeNext, strict, `noUncheckedIndexedAccess`). Source under `server/`, tests under `tests/`, both compiled to `dist/`. The Vite/React web app is a separate package under `web/`.

### Event flow

```
Slack Socket Mode ──┐
Feishu events/WS ───┼──► transports/inbox ──► Runtime worker ──► Codex / Claude / Kimi CLI
Reminder scheduler ─┘                                                    │
                                                                         ▼
                                                          anima CLI tools (messages,
                                                          files, reactions, asks,
                                                          reminders) -> audited
                                                          activities + platform output
```

The chat transports, reminder scheduler, and agent worker all run in one `agent` process per environment. The web app is a separate process so it stays available for inspection even if the agent is down.

### Key modules

- **`server/agents/`** — Agent config and lifecycle service. `agent.service.ts` owns create/patch/delete/list/status-facing config behavior; `agent-slack.service.ts` and `agent-feishu.service.ts` own platform connection/display info and owner onboarding.
- **`server/transports/`** — Inbound platform transport lifecycle. `MessageTransportRunner` starts/stops Slack and Feishu transports. Keep this about connection/event ingestion; do not grow it into an outbound message API.
- **`server/inbox/`** — Inbox business layer and wake routing. Slack and Feishu event normalization, subscription eligibility, reminder wake ingestion, and wake queue lifecycle orchestration live here.
- **`server/storage/schema/wake-queue.store.ts`** — Wake queue persistence store. It owns queued/running/settled inbox item state plus direct single-store operations (`find`, `list`, `insertIfAbsent`, `replaceItem`, `claimQueued`, `complete`, `fail`, `requeue`, `requestStop`). It does not own cross-store business flow.
- **`server/storage/schema/activity.store.ts`** — Per-agent append-only activity store. Runtime events, provider tool rows, platform tool rows, reminders, and subscription ops write through this path.
- **`server/messages/`** — Per-agent message ledger and projections. It projects inbox items and activity rows into `messages.jsonl`, backs `anima inbox/outbox/search`, and is agent-visible history, not workspace-wide platform search.
- **`server/slack/`** — Slack API/data helpers only. SDK client creation, pure Slack formatting helpers, and workspace directory/cache logic live here. Agent attention and inbox semantics belong in `inbox/`.
- **`server/feishu/`** — Feishu API/data helpers: SDK client creation, event normalization, directory lookup, message content conversion, file/resource handling, and scope/auth helpers. Keep Feishu protocol mechanics here; agent attention and wake decisions still belong in `inbox/`.
- **`server/slack-interactions/`** — Slack shortcut and interactive modal handling. This is an inbound interaction surface that currently coordinates with `inbox/`, reminders, and runtime control; be careful not to deepen cycles between it and `inbox/`.
- **`server/tools/`** — Agent-facing `anima ...` command implementations: message/read/react/file/ask/subscription/env tool behavior and CLI registration. New business semantics should move into services instead of growing command files.
- **`server/asks/`** — Interactive ask persistence and answer handling. Today the interactive UI path is Slack-specific; keep durable ask state separate from platform rendering.
- **`server/kb/`** — Knowledge-base registry, browsing, raw file serving, path safety, and docs exposure for the dashboard.
- **`server/env/`** — Per-agent provider environment storage, encryption/decryption, key validation, and masking.
- **`server/provider-usage/`** — Provider usage/account probing. It should stay decoupled from provider runtime adapters.
- **`server/runtime/`** — Runtime item execution. `runtime-worker.ts` drains the wake queue, handles active-run follow-ups, stop/idle/crash behavior, prompt construction, provider effects, session stats, and activity emission.
- **`server/providers/`** — Provider adapter layer. Claude Code, Claude Code Channels, Codex CLI, and Kimi CLI adapters own only their provider protocols; `child-process.ts` is the shared spawn layer.
- **`server/reminders/`** — Reminder records, repeat-rule parsing (`every:15m`, `daily@09:00`, `weekly:mon,fri@09:00`), reminder lifecycle/activity, and the `anima reminder` CLI. Due reminders become inbox items through `inbox/`.
- **`server/storage/`** — Persistence primitives and typed stores: JSON files, JSONL logs, file locks, safe filenames, and `storage/schema/*` store modules. Folder layout is under `$ANIMA_HOME/agents/<agentId>/`.
- **`server/settings/`** — Runtime-wide settings, including dashboard password-auth state.
- **`server/services/`** — Environment-neutral daemon supervisor. `supervisor.ts` (start/stop/status with pid files, log files, `ps` orphan fallback, env scrub). Called by `cli/services-cli.ts` to back `animactl services <op>`.
- **`server/runtime-management/`** — Managed runtime install/update/status logic, npm release-track checks, and stable/canary upgrade orchestration. This is operator/runtime package management, not provider execution.
- **`server/diagnostics/`** — Support/diagnostic aggregation for agent health, runtime state, package info, and recent logs. Keep this allowlisted and secret-free.
- **`server/activities/`** — Activity service and formatting helpers shared by runtime, tools, diagnostics, and UI feed projection.
- **`server/web/`** — Web API backend and static app host. Route modules parse HTTP input, call services, redact secrets, and return view data. UI package under `web/` builds to `dist/web/`.
- **`server/runtime/host.ts`** — The agent service host. It wires runnable agents, chat transports, reminder subscribers, wake queues, runtime workers, and provider adapters into one foreground `agent` process.
- **`server/cli/anima.ts`** — Agent-facing CLI entry. Registers `anima message`, `anima ask`, `anima reminder`, `anima subscription`, `anima file`, and `anima reaction`.
- **`server/cli/animactl.ts`** — Operator CLI entry (`server`, `web`, `services`).

### Vocabulary

- **Agent** — durable teammate identity, defined in config and connected to one or more chat platforms.
- **Session** — long-lived primary working context (`agent:<agentId>:primary`). **Not** one-per-thread.
- **Chat surface** — the DM, channel, thread, Feishu chat, or Feishu topic a message came from.
- **Inbox item** — inbound Slack/Feishu message, reminder wake, ask choice, or user/system item queued for an agent.
- **Activity** — timestamped worker/tool entry for an agent.
- **Message ledger** — `messages.jsonl`, the local per-agent projection of messages the agent saw or sent. It is not a full workspace history.

### Layering

These modules form a layered flow; each owns one thing. New logic goes in the layer that already owns the relevant state. A PR that needs to touch two layers is a signal to stop and re-check the boundary.

Dependency direction (downstream depends on upstream; never the reverse):

```
cli/, web/                                       ← entry points
  ↓
web routes / CLI commands                          ← parse input and return view/CLI output
  ↓
domain services                                   ← business logic and cross-store orchestration
  ↓
storage/schema/* stores                           ← direct persistence for one table/file family
  ↓
storage primitives                                ← JSON/JSONL/files/locks
```

- **API/web/CLI layers** parse input, call a service, redact/shape output, and stop there. They should not read or write storage directly.
- **Service layers** own business semantics and multi-store operations. If a workflow touches config + inbox + activity, it belongs in a service, not a store or route.
- **Store layers** own one persisted table/file family. Methods should be direct persistence operations such as `find`, `list`, `insertIfAbsent`, `replaceItem`, `claimQueued`, `complete`, `delete`. Stores should not know HTTP, Slack routing, provider execution, or cross-store orchestration.
- **Storage primitives** (`JsonStore`, `JsonFile`, `JsonlLog`, locks) are generic mechanics. Domain code should use typed stores instead of ad hoc filesystem reads/writes.
- **`slack/`** owns speaking Slack — Web API calls, files, reactions, profiles, formatting. Nothing about agent attention or business logic.
- **`feishu/`** owns speaking Feishu - SDK calls, files, reactions, directory lookup, message parsing, formatting, and scope/auth helpers. Nothing about agent attention or business logic.
- **`transports/`** owns platform listener lifecycle. It should start/stop inbound transports and pass normalized work toward `inbox/`.
- **`inbox/`** owns what the agent listens to and what work is queued — chat event normalization, eligibility rules, and wake queue lifecycle orchestration.
- **`runtime/`** owns provider execution — the worker that drains the inbox service, prompt construction, provider event parsing, and same-session follow-up append.
- **`runtime/host.ts`** is the composition root that wires running agents.

Cross-cutting notes:

- **`defaultActivityStore`** (in `storage/schema/activity.store.ts`) is called by every write-side concern that produces audit entries — agent tools, runtime events, reminder ops. This is intentional; the audit log is a single channel.
- **Inbox item types** live in `shared/inbox.ts`; wake queue persistence lives in `storage/schema/wake-queue.store.ts`; inbox business behavior lives in `inbox/` services.
- **Agent-facing platform docs** live in `docs/agent/guide.md` and `docs/agent/reference.md`. They are shared, code-versioned docs the standing prompt points at; do not materialize per-agent copies in agent homes.
- Keep the store/service naming boundary explicit. `*.store.ts` is persistence; `*.service.ts` is business orchestration.

### Home memory

Anima bootstraps `MEMORY.md` and `notes/` in the agent home. Provider-native instruction files such as `AGENTS.md` or `CLAUDE.md` are optional user-managed extras; Anima does not create, link, or read them.

### Chat eligibility (current default)

DMs, direct chats, and @mentions always wake. Channel membership and thread involvement create a subscription; while subscribed, new messages wake without a re-mention. Subscriptions are permanent until explicitly muted: no time limit, no expiry window (`subscriptionStatus()` in `server/storage/schema/subscription.store.ts` checks only `mutedAt`; the `expiresAt`/`remainingMessages` fields are legacy, kept for migration). Feishu group messages wake according to the Feishu subscription/attention decision. Messages in places the agent is not subscribed to are ignored. Wake decisions live in `server/inbox/`; platform protocol details live in `server/slack/`, `server/feishu/`, and `server/transports/`.

## Architecture & code quality

Keep design and code simple and direct. Bias toward fewer concepts, fewer files, fewer layers.

- **No defensive coding inside the system.** Trust internal callers and framework guarantees. Validate only at boundaries: user input, Slack/Web API responses, file reads, env vars.
- **No speculative backwards-compatibility shims.** Delete dead internal code outright — no `_unused`, no `// removed`, no re-exports kept "just in case", no parallel old/new code paths. For config, state, CLI, or package behavior that has shipped in a stable release, use an explicit migration or clear failure mode instead of silently keeping old and new paths forever.
- **Minimal surface — start narrow, expand on demand.** When you spot a type field, config option, enum variant, function parameter, or code branch with zero writers OR zero readers, delete it; don't keep it "in case someone needs it later". When designing new code, start with the narrowest possible type/API and add fields only when a concrete consumer needs them. Speculative scaffolding rots; adding a field when there's a real reader is cheap.
- **Three duplications before an abstraction.** Two similar blocks is fine; extract on the third, and only within the same module. Don't design for hypothetical future callers.
- **Comments are for WHY, not WHAT.** Skip comments that restate the code. Write one only when the reason is non-obvious: a hidden constraint, a workaround, a surprising invariant.
- **Error handling only where action is possible.** Retry, degrade, or surface a useful message — otherwise let the exception bubble. Don't wrap-and-rethrow with no added information.
- **Service layer does not touch HTTP.** Response construction (`ServerResponse`, `writeHead`, `reply.send`) belongs in routes/CLI entrypoints. Services return data or throw; callers decide how to write to the wire.
- **Conditional properties: assign, don't spread.** `if (x) result.x = x` is clearer than `...(x && { x })`, and avoids type-inference headaches.
- **Test helpers stay out of business code.** If a factory/constructor has one business caller but many test callers, inline it into the business path and keep a test-only version under `tests/helpers/`.
- **No planning, analysis, or summary markdown files** unless explicitly asked. Work from conversation context.
- **No half-finished implementations.** If a feature isn't wired all the way through, don't leave a stub that pretends it is.

## Plan-first

Before non-trivial changes, propose the plan in chat (what you'll touch, why, the seams involved) and wait for explicit approval. Then edit. Read-only exploration (grep, read, run tests) doesn't need approval — looking is not acting.

**Exception — spec-driven runs.** When the prompt itself is a written spec (boundary files, invariants, acceptance commands), the spec IS the approved plan: implement it directly, run its acceptance commands, and commit as instructed — do not pause to ask for approval. Stay inside the spec's boundary; if the spec turns out to be wrong or its boundary doesn't hold, stop and report instead of improvising around it. The "Architecture & code quality" section above applies in full: prefer the straightforward implementation, no defensive branches against internal callers, no speculative generality the spec didn't ask for.

## Repo conventions

- **Imports use `.js` suffixes** in TypeScript source (NodeNext ESM): `import { foo } from './bar.js'` even though the source is `bar.ts`.
- Tests live in `tests/*.test.ts` and run from `dist/tests/*.test.js` via the Node test runner (`node --test`). No Jest or Vitest in `server/`.
- The default `pnpm test` is intentionally the fast gate (`unit + api`) and skips the Vite build; use `pnpm test:runtime` for CLI/provider/service subprocess coverage, and `pnpm test:all` for the full local/CI-style sweep.
- The web package (`web/`) has its own `package.json` and Vite/React/ESLint config; do not mix it with the Node CLI.
- The `dist/` directory is committed-ignored output; `pnpm build` always rebuilds from scratch.

## Operating constraints (from project memory)

- Service control: never `kill` / `pkill` the agent or web app directly. Always go through `animactl services <op>`. The supervisor detects `ANIMA_INBOX_ITEM_ID` + `ANIMA_RUNTIME_HOME` and **refuses to stop or restart the agent's own environment** — that would kill the item making the request. Restarting a **different** environment from inside a runtime is allowed when `ANIMA_HOME` points at that other environment while `ANIMA_RUNTIME_HOME` still points at the caller's own environment. The web app also exposes `POST /api/services/restart` (button in sidebar) for browser-driven restarts, which a human can use to restart the agent's own environment after the item ends.
- Runtime config and state live under the selected `ANIMA_HOME` directory. Logs go to `$ANIMA_HOME/logs/{agent,web}.log`. Pid files go to `$ANIMA_HOME/run/{agent,web}.pid`.
