# Codebase Internals

This document is for contributors who need to change Anima itself. It names the code paths that move a message from Slack or Feishu into a provider runtime, and the files that persist state along the way.

It does not repeat the provider adapter details from [Provider layer](../runtime-providers.md). Start there when the change is inside `server/providers/`.

## Repo Layout

| Path                | What lives there                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`           | The Node runtime, local web API, operator CLI, agent-facing CLI tools, platform transports, provider adapters, services, and persistence stores. It builds to `dist/server/`.                                 |
| `shared/`           | Zod schemas and TypeScript types shared by `server/` and `web/`, including inbox items, agent config, activities, diagnostics, and URL helpers. It builds to `dist/shared/`.                                  |
| `web/`              | The dashboard UI package. It is Vite + React + TanStack Query, with its own `web/package.json`, tests, and ESLint config. Its production build is copied to `dist/web/`.                                      |
| `packages/animactl` | The published npm package shell for `anima` and `animactl`. The root build refreshes its package output from `dist/server`, `dist/shared`, and `dist/web`.                                                    |
| `scripts/`          | Build, packaging, install, docs, and test orchestration scripts. `scripts/prepare-animactl-package.mjs` copies the built server, shared, and web output, `templates/`, and `docs/` into `packages/animactl/`. |
| `docs/`             | The VitePress docs source, public docs assets, and architecture/user guides. `docs/.vitepress/config.ts` owns the public site navigation and sidebar.                                                         |

The import direction is simple: `server/` imports `shared/`; `web/` imports `shared/` through its alias; `shared/` does not import either side. The npm package under `packages/animactl` is packaging output, not an independent source tree.

The root `package.json` scripts reflect that split. `pnpm build` runs the server TypeScript build, the web build, then `scripts/prepare-animactl-package.mjs`. `pnpm build:server` compiles server and shared output without Vite.

## Inbound Pipeline

This section walks a Slack message through code. Feishu follows the same shape through its own transport and normalizers.

### 1. Slack Socket Mode

The Slack Socket Mode subscriber is `server/inbox/slack-subscriber.ts`.

`SlackInboxSubscriber` constructs a Bolt `App` with `socketMode: true`, registers `app.message`, `app.event('app_mention')`, shortcut handlers, interactive ask handlers, and Slack workspace-directory events, then starts and stops the Bolt app from `start()` and `stop()`.

`server/transports/slack-message-transport.ts` wraps `SlackInboxSubscriber` in the transport interface from `server/transports/message-transport.ts`. `server/inbox/subscriber.ts` chooses the Slack transport when an agent has Slack tokens and adds Feishu when that transport is connected.

The runtime host wires the pieces together through `server/runtime/host.ts` and `server/runtime/agent-runner.ts`: runnable agent config becomes an inbox subscriber, wake queue, runtime worker, and provider runtime.

### 2. Slack event normalization

Slack event filtering and normalization live in `server/inbox/slack-events.ts`.

`server/inbox/slack-subscriber.ts` calls `isRoutableSlackMessage` before doing any queue work. For routable events, it derives a stable item id with `slackMessageEventId` from `server/ids.ts`.

`server/inbox/slack-ingest.ts` turns the Slack event into a `SlackInboxItem` from `shared/inbox.ts`. `buildSlackInboxItemWithLatePreview` adds sender profile data, channel profile data, readable mention text, permalink, file metadata, and Slack unfurl previews. If Slack has not attached message previews yet, the returned `latePreview` callback updates the queued item after enqueue with `WakeQueueService.replaceQueuedItem`.

### 3. Ingest decision pipeline

The shared decision skeleton is `server/inbox/ingest-pipeline.ts`.

`runIngestPipeline` executes the same ordered hooks for Slack and Feishu:

1. `hasSeen` dedupe check against the wake queue and legacy message ledger;
2. `decide`, which returns a reason and whether to start the runtime;
3. `enrich`, which builds the final inbox item;
4. tag the item with `attentionSuggestion` and parsed `wakeReason`;
5. `enqueue` through `WakeQueueService`;
6. optional post-enqueue effects such as late previews and subscription activity;
7. optional attention-suggestion activity;
8. structured ingest log output.

Slack-specific decisions live in `server/inbox/slack-subscription.service.ts`. DMs wake immediately. `app_mention` wakes immediately and follows the relevant thread when there is a channel/thread context. Thread replies wake when the agent is following that thread. Channel messages wake when a channel subscription exists and is not muted.

The subscription primitives are in `server/inbox/subscription.service.ts`. That file owns channel/thread subscription ids, follow/mute state, activity timestamps, wake counters, and attention suggestions. Slack and Feishu each have a thin decision adapter: `server/inbox/slack-subscription.service.ts` and `server/inbox/feishu-subscription.service.ts`.

### 4. Subscription records

Persisted subscriptions are `SubscriptionRecord` values from `server/storage/schema/subscription.store.ts`, managed by `server/inbox/subscription.service.ts`.

A subscription is the durable "this agent is listening here" record. It can be `kind: 'channel'` or `kind: 'thread'`, has an `agentId`, `channelId`, `lastActivityAt`, `updatedAt`, optional `mutedAt`, and a `platform` field of `'slack'` or `'feishu'`.

The current persisted id strings are compatibility surface:

- channel: `slack-subscription:${agentId}:${channelId}:channel`
- thread: `slack-subscription:${agentId}:${channelId}:thread:${threadTs}`

The prefix is still `slack-subscription` for both platforms. Feishu is distinguished by the `platform` field and, for legacy records, by `legacyPlatformForChannelId` in `server/inbox/subscription.service.ts`.

### 5. Wake queue

`server/inbox/wake-queue.service.ts` is the business service around the wake queue. `server/storage/schema/wake-queue.store.ts` is the direct persistence store.

`WakeQueueService.enqueue` inserts the item into `wake-queue.json`, records the inbox item in the message ledger through `server/messages/message.service.ts`, and calls `signalWake` from `server/inbox/wake-signal.ts`.

The wake queue file is v2:

```text
agents/<agentId>/wake-queue.json
  items: active queued/running work
  seen: settled dedupe markers
```

`server/storage/schema/wake-queue.store.ts` reads older flat queue files and migrates them in memory to v2 shape. It does not write a downgrade path back to the flat format.

The active statuses come from `shared/inbox.ts`: `queued`, `running`, `completed`, and `failed`. The v2 file keeps only active `queued` and unsettled `running` items in `items`. Settled ids move to `seen`, with retention bounded by `WAKE_SEEN_RETENTION_MS` and `WAKE_SEEN_MAX_ENTRIES`.

`WakeQueueService.takeNextRunnable` claims work for a worker. It recovers stale running work when the previous worker is no longer alive or the item is older than the stale-running threshold. `WakeQueueService.takeNextFollowup` claims same-session queued items for the currently active worker.

The wake signal is not the only scheduling mechanism. `server/runtime/runtime-worker.ts` subscribes with `onWake`, but it also has a fallback poll interval. The fallback covers stale-running crash recovery and cross-process enqueue cases.

### 6. Runtime worker

The runtime executor is `server/runtime/runtime-worker.ts`.

`AgentRuntimeWorker.start` subscribes to wake signals, starts the fallback poll timer, and calls `drainOnce`. The drain loop claims one runnable item at a time with `queue.takeNextRunnable`, rebuilds context through `server/runtime/context.ts`, and builds provider input through `server/runtime/runtime-bridge.ts`.

While the provider is running, `server/runtime/followup-appender.ts` watches for queued follow-up items. Accepted follow-ups call `AgentRuntime.appendToActiveRun`, are marked appended to the active item, and are settled as part of the active run.

The worker also owns abort and drain behavior. `server/runtime/active-run-control.ts` handles idle timeout, stop, and restart-drain requests. `server/runtime/active-item.ts` records the current audited item so agent-facing tools can resolve the item at call time.

The [memory pass](/concepts#memory) uses the same queue and worker (its modules keep the historical `memory-coherence` name). `server/memory/memory-coherence-scheduler.ts` enqueues pass items, and `server/runtime/runtime-worker.ts` records before/after digests with `server/memory/memory-coherence-outcome.ts`.

### 7. Provider runtimes

Provider adapters live in `server/providers/`.

The adapter contract is `AgentRuntime` in `server/providers/contract.ts`. It requires `run` and `appendToActiveRun`, and may expose `close`, `health`, and `requestDrain`.

`server/providers/factory.ts` chooses the adapter by provider kind:

- `server/providers/claude.ts` for `claude-code`;
- `server/providers/codex.ts` for `codex-cli`;
- `server/providers/kimi.ts` for `kimi-cli`.

Provider adapters own the protocol to the underlying CLI process. They do not decide Slack attention, queue priority, prompt construction, or visible Slack output. See [Provider layer](../runtime-providers.md) for adapter details.

Provider config is validated in `shared/agent-config.ts` and `shared/provider-catalog.ts`. The Claude transport enum intentionally contains only `stream-json`; stale removed values fail loudly during validation.

### 8. Outbox boundary

Plain provider output is internal runtime output. It is recorded for inspection, but it is not a Slack or Feishu reply.

Visible outbound actions go through the agent-facing `anima` CLI entry in `server/cli/anima.ts` and tool implementations under `server/tools/`. Message sending, message updates, file send/fetch, reactions, asks, subscriptions, and environment tools all resolve the audited runtime item and write activity.

The operator CLI entry is `server/cli/animactl.ts`; it starts the server/web processes and service supervisor commands. The shared CLI registration helpers live in `server/cli/service.ts` and `server/cli/shared.ts`.

### 9. Activity trail

Activities are append-only per-agent records.

`server/activities/activity.service.ts` is the service layer. `server/storage/schema/activity.store.ts` writes `agents/<agentId>/activity.jsonl` and rotates old segments under `agents/<agentId>/activity.archive/` through `server/storage/jsonl-log.ts`.

Runtime events, provider output/tool rows, platform tool rows, reminders, subscriptions, and attention suggestions all record through this path. The web Activity view reads the feed through server web routes under `server/web/` and renders it in `web/src/views/agents/activity/`.

## State And Storage

The selected Anima home comes from `server/anima-home.ts`: `ANIMA_HOME`, then a local `./.anima` directory if present, then `~/.anima`.

The home contains runtime config and state together:

```text
config.json
agents/<agentId>/config.json
agents/<agentId>/wake-queue.json
agents/<agentId>/messages.jsonl
agents/<agentId>/activity.jsonl
agents/<agentId>/sessions.json
agents/<agentId>/subscription.json
agents/<agentId>/reminders.json
agents/<agentId>/asks.json
cache/
logs/
run/
```

Agent config files are managed by `server/storage/schema/agent.store.ts`. The default agent home path helper is in `shared/agent-home.ts`, but the runtime state directory above is the Anima home, not the provider working directory.

The storage layer starts with `server/storage/json-file.ts`, which provides atomic JSON writes, file locks, and a small process-local cache. `server/storage/json-store.ts` adds schema parsing and validation. JSONL append/read/rotation is in `server/storage/jsonl-log.ts`.

Typed stores live in `server/storage/schema/`. Examples:

- `server/storage/schema/agent.store.ts` for `agents/<agentId>/config.json`;
- `server/storage/schema/wake-queue.store.ts` for `agents/<agentId>/wake-queue.json`;
- `server/storage/schema/message.store.ts` for message ledger persistence;
- `server/storage/schema/activity.store.ts` for activity JSONL;
- `server/storage/schema/session.store.ts` for provider session ids and latest provider stats;
- `server/storage/schema/subscription.store.ts` for listening state;
- `server/storage/schema/cache.ts` for reconstructable platform caches.

Session state is not one session per Slack thread. `server/storage/schema/session.store.ts` stores the provider-native session id under the agent's primary session record. Provider adapters update it through the effects sink in `server/runtime/runtime-bridge.ts`.

### Slack workspace directory

The Slack workspace directory replica is stored at:

```text
cache/slack/teams/<teamId>/directory-v2.json
```

The schema is in `server/storage/schema/cache.ts`, and the service is `server/slack/workspace-directory.service.ts`.

Entries have per-entry `syncedAt` timestamps. Full user and channel refreshes have `usersFullSyncAt` and `channelsFullSyncAt`; channel refreshes also record `channelsFullSyncTypes`.

The freshness rule is in `server/slack/workspace-directory.service.ts`: fresh cached entries are returned immediately; stale cached entries are also returned immediately, while a single-flight background refresh updates the cache. Channel collection hits are honored only if the cached `channelsFullSyncTypes` covers the requested Slack conversation types.

### File caches

Platform file caches are reconstructable and live under `ANIMA_HOME/cache`.

The schema comments in `server/storage/schema/cache.ts` list the current layout:

- `cache/slack/files/<teamId>/<fileId>/meta.json`;
- `cache/slack/files/<teamId>/<fileId>/<safe original filename>`;
- `cache/feishu/files/<safe resource id>/meta.json`;
- `cache/feishu/files/<safe resource id>/<safe filename>`;
- `cache/feishu/tenants/<tenant or app id>/directory.json`.

Slack file download/cache code is in `server/slack/slack-file.service.ts`. Feishu file download/cache code is in `server/feishu/feishu-file.service.ts`.

Eviction is in `server/storage/file-cache-eviction.ts`. Each platform cache has a 1 GiB cap, entries newer than 24 hours are pinned, and sweeps are throttled to avoid repeatedly scanning the same root.

## Web Dashboard

The dashboard is the `web/` package. Routes are in `web/src/router.tsx`: agent tabs include Activity, Channels, Profile, and Reminders under `web/src/views/agents/`; the knowledge-base browser is under `web/src/views/kb/`. Data fetching uses TanStack Query with keys centralized in `web/src/lib/query-keys.ts`; polling intervals are centralized there as `refetchIntervals`. Agent list/status hooks are in `web/src/hooks/useAgentDirectory.ts`. The app-level query client in `web/src/query-client.ts` sets `retry: 1` by default because the server is local. `web/vite.config.ts` uses the standard Vite React plugin and does not currently configure React Compiler, so do not assume compiler-driven memoization behavior.

## Feishu

Feishu is a parallel transport that plugs into the same ingest pipeline.

`server/transports/feishu-message-transport.ts` starts the Feishu websocket client from `server/feishu/client.ts`, normalizes receive-message and reaction events with `server/feishu/events.ts`, enriches directory data through `server/feishu/directory.service.ts`, and calls `runIngestPipeline` from `server/inbox/ingest-pipeline.ts`.

Feishu attention decisions live in `server/inbox/feishu-subscription.service.ts`. Feishu message content conversion and attachment extraction live in `server/feishu/message-content.ts`. Feishu markdown/post output helpers live in `server/feishu/markdown-to-feishu-post.ts`.

For operator-facing setup and scopes, see [Feishu runbook](../agent/feishu.md).

## Invariants That Matter

- Plain provider output is not a reply; visible chat output begins at the `server/tools/` outbox boundary.
- Every outbound action goes through audited `anima` CLI tools registered from `server/cli/anima.ts`.
- Wake-queue v2 format in `server/storage/schema/wake-queue.store.ts` has read migration from older files but no downgrade path below its introduction.
- Subscription `subscriptionId` strings from `server/inbox/subscription.service.ts` are compatibility surface; do not change their shapes without a migration.
- Provider transports are enum-validated in `shared/agent-config.ts`, so removed values fail loudly instead of silently falling back.
- Timestamps written by stores use ISO-8601 strings, generally through `nowIso` in `server/ids.ts` or `Date#toISOString`.
- Services return data or throw; HTTP response construction belongs in `server/web/` route modules and CLI formatting belongs in `server/cli/` or `server/tools/`.
- Store modules under `server/storage/schema/` own one persisted file family; cross-store business flow belongs in service modules such as `server/inbox/wake-queue.service.ts`.

## Testing Map

Server tests live in `server/tests/*.test.ts` and run with Node's built-in test runner after TypeScript compilation to `dist/server/tests/*.test.js`.

The tier runner is `scripts/run-tests.mjs`:

- `unit` covers most pure services, stores, parsing, provider helpers, and runtime-host unit behavior;
- `api` covers local web API route behavior;
- `runtime` covers provider adapters, CLI subprocess behavior, runtime worker integration, and service process behavior;
- `fast` is `unit + api`;
- `all` is `unit + api + runtime`.

The tier list is self-auditing. `scripts/run-tests.mjs` scans `server/tests/*.test.ts` and fails if a test file is missing from a tier, listed in more than one tier, or left stale after deletion.

Shared test helpers live under `server/tests/helpers/`. Common setup and polling helpers are in `server/tests/helpers/harness.ts`. Runtime worker helpers are in `server/tests/helpers/runtime-worker.ts`; Slack and Feishu helpers are in `server/tests/helpers/slack.ts`, `server/tests/helpers/slack-api.ts`, and `server/tests/helpers/feishu.ts`.

Use `waitFor` from `server/tests/helpers/harness.ts` for asynchronous effects. Fixed sleeps should be rare and commented with the reason; existing deliberate-delay comments are in `server/tests/helpers/runtime-worker.ts` and `server/tests/runtime-upgrade.test.ts`.

Web tests live next to web code, such as `web/src/hooks/useAgentDirectory.test.ts` and `web/src/lib/activity-feed.test.ts`, and run through Vitest with `pnpm --dir web test`.

CI lives in `.github/workflows/ci.yml`. The main `test` job runs on Ubuntu and executes typecheck, lint, build, package smoke, fast server tests, and web tests. The `runtime-tests` job runs on macOS because the runtime tier is macOS-shaped: production runs on a Mac host, and launchd tests pin Darwin service paths.
