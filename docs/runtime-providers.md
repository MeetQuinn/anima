# Provider Layer

This document explains the layer where Anima talks to an underlying provider such as Codex CLI, Claude Code, Kimi CLI, Grok Build, or OpenCode.

It intentionally does not re-explain chat routing, reminder scheduling, inbox ingestion, or the web app. For the system map, start with [Architecture overview](architecture/overview.md).

## Mental Model

Anima has one durable primary session per agent. Provider sessions are lower-level execution details under that primary session.

The runtime worker owns Anima inbox item execution:

1. claim a queued item;
2. build the current `RuntimeContext`;
3. use `AgentRuntimeBridge` to turn Anima context into provider-facing input;
4. call the configured provider adapter through `AgentRuntime.run`;
5. append same-session follow-up messages through `AgentRuntime.appendToActiveRun`;
6. mark items completed or failed;
7. close provider resources when the worker shuts down.

Provider adapters own only the protocol to the underlying CLI process. They do not receive inbox items, Slack or Feishu conversation objects, or agent state. They do not decide chat eligibility, queue priority, reaction policy, prompt construction, or whether visible output should be posted. Visible chat output still has to go through Anima tools from inside the spawned provider process.

The adapter boundary is:

```text
Anima context/state -> AgentRuntimeBridge -> provider-facing prompt/env/sinks -> provider adapter -> CLI process
```

## The Provider Contract

The contract lives in `server/providers/contract.ts`.

```ts
export interface AgentRuntime {
  readonly env?: Record<string, string>;
  readonly kind: string;
  close?(options?: AgentRuntimeCloseOptions): Promise<void>;
  health?(): AgentRuntimeHealth;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResult>;
  appendToActiveRun(
    input: AgentRuntimeFollowupInput,
  ): Promise<AgentRuntimeFollowupResult>;
  requestDrain?(input: AgentRuntimeDrainInput): Promise<void>;
}
```

`kind` identifies the provider and is also the key used for provider-session storage.

`run` is required. It starts or resumes provider work for one Anima inbox item and resolves when the provider work is done.

`appendToActiveRun` is required. It lets the worker send a newly queued same-session item into the active provider context instead of waiting for the active item to finish.

`close` is optional. It is for provider adapters that keep resources alive across items, such as a persistent child process. `AgentRuntimeCloseOptions` lets the caller choose the kill signal and a force-kill deadline.

Controller-style adapters (Codex app-server, Claude stream-json, Kimi ACP, Grok ACP, and OpenCode ACP) may keep a provider child warm after a turn so the next item can reuse the session. Once no item is active, `providerChildIdleTimeoutMs` bounds that warm child before Anima terminates it. Claude's full idle window starts only after its live background-task set is empty, so a main-turn result cannot terminate background work.

`health` is optional. It returns a snapshot of the adapter's child-process state (whether a child is expected, and how the live one looks) for the runtime health service.

`requestDrain` is optional. It asks the adapter to bring the active item to a clean stop; the graceful service restart path uses it so in-flight work finishes or saves its place instead of being dropped.

### Runtime Input

`AgentRuntimeInput` contains:

- `itemId`: the Anima inbox item id, used as an Anima-side correlation key;
- `cwd`: the agent home directory for the child process;
- `env`: the complete child environment, already built by Anima;
- `prompt`: the text to send into the provider for this item;
- `systemPrompt`: optional runtime-profile text for providers that accept a separate system prompt;
- `systemPromptFilePath`: where the bridge materializes `systemPrompt` on disk for providers that
  take a file instead of inline text (Claude's `--system-prompt-file`);
- `providerSession`: the provider-native session id, if one exists;
- `signal`: an abort signal controlled by the worker for stop, idle timeout, and shutdown;
- `onActivity`: a heartbeat callback the provider calls when stdout/stderr activity arrives;
- `effects`: a sink for recording activities and persisting provider session ids;
- `suppressFailureRecord`: when true, the adapter skips writing its own `runtime.failed` record;
  the worker sets this because it owns failure recording for the item and wants exactly one final
  record.

The important boundary: `AgentRuntimeInput` does not contain inbox items, Slack or Feishu conversation objects, or the full agent record. Its fields are the provider-facing prompt, system prompt and optional prompt-file path, working directory, environment, current provider-session record, item id, abort signal, activity callback, failure-recording flag, and effect sink.

The worker uses `onActivity` to reset the idle watchdog. If the provider produces no activity for the configured idle timeout, the worker aborts the item.

### Effects Sink

`AgentRuntimeEffects` is how provider adapters report provider events back to Anima:

- `recordRuntime`: runtime start/completion/failure;
- `recordOutput`: raw stdout/stderr chunks;
- `recordAgentText`: provider assistant text;
- `recordEvent`: provider lifecycle events such as compact or session stats;
- `recordToolStarted` / `recordToolFailed`: provider-side tool activity;
- `persistProviderSession`: provider-native session id updates.

The sink is Anima-aware; the adapter is not. `AgentRuntimeBridge` binds the sink to the current agent id, state dir, session, and runtime kind before calling the adapter.

### Runtime Result

`AgentRuntimeResult.text` is internal runtime output. It is useful for logs and inspection, but Anima does not post it to chat automatically. The spawned code agent must call `anima message send` or `anima message update` for visible chat side effects.

## How the Worker Uses Providers

`AgentRuntimeWorker` is the only caller of the provider contract in normal service execution.

For a claimed item:

1. `claimNextInboxItem` marks the first queued item as `running` and writes the worker id.
2. `runtimeContextForItemId` rebuilds the full runtime context.
3. `AgentRuntimeBridge` in `server/runtime/runtime-bridge.ts` builds provider-facing `prompt`, `env`, `providerSession`, and `effects`.
4. The worker starts a parallel follow-up loop while the active item is running.
5. The worker calls `agentRuntime.run(providerInput)`.
6. On success, the worker records completion and marks the item `completed`.
7. On error or abort, the worker records failure and marks the item `failed`.
8. `onItemSettled` runs after either path; the agent service uses it to remove processing reactions from the active item and any appended follow-up items.

Only one normal item can be `running` for an agent at a time. Follow-up items are temporarily claimed by the same worker while the active item is still running.

## Active-Run Follow-Up Protocol

Active-run follow-up append is Anima's way to preserve the "one teammate, one primary session" behavior while a provider is busy.

When a same-session message arrives during an active item:

1. ingestion creates a normal queued item for that message;
2. the active worker loop notices the queued item;
3. `claimNextFollowup` claims it for the same worker;
4. `AgentRuntimeBridge` builds a provider-facing follow-up input with `activeItemId`, follow-up `itemId`, and `prompt`;
5. the worker calls `agentRuntime.appendToActiveRun`;
6. if accepted, the follow-up item stays `running`, is marked as appended to the active item, and gets a `runtime.followup_appended` activity;
7. if rejected, the item is requeued and will execute after the active item.

Accepted follow-up append means the provider adapter has taken responsibility for injecting that message into the active provider context. The follow-up item does not get its own independent provider execution. Settlement depends on the parent outcome:

- normal completion settles the active item and its accepted prompts together;
- final provider failure requeues appended follow-ups;
- restart drain and user stop settle them under the worker's corresponding requeue or failure policy;
- Grok process-crash recovery retains accepted prompts through child replacement and delivers them to the fresh child before their durable rows complete;
- Codex session-corruption recovery requeues appended follow-ups before retrying with a fresh session.

This is why reaction cleanup runs for both the active item and accepted follow-up items: the human sees multiple chat messages being worked on, but the provider sees one active execution context.

## Prompt Boundary

The shared prompt helpers live in `server/runtime/delivery-prompt.ts` and `server/runtime/standing-prompt.ts`. Provider adapters do not call them directly; `server/runtime/runtime-bridge.ts` calls them before invoking the adapter.

The Anima runtime profile tells the provider-side agent how chat side effects work, which `anima` tools exist, and which environment variables are available. This is platform behavior, not provider-specific behavior.

The runtime profile is delivered through provider-native standing-prompt mechanisms. The per-item prompt contains only the current chat or reminder event. It may include "Recovery context" when Anima does not have a persistent provider session yet. Recovery context is a safety net, not the product session model.

## Environment Boundary

`runtimeEnv` builds the child process environment. `AgentRuntimeBridge` calls it and passes the completed env to the adapter.

The important pieces are:

- `ANIMA_AGENT_ID` and `ANIMA_HOME`, so agent-facing CLI tools can locate config and state;
- configured provider env from the agent config;
- a `PATH` that includes Anima's agent-facing CLI.

`ANIMA_INBOX_ITEM_ID` is deliberately stripped from the long-lived provider environment. Chat-visible tools resolve the audited item at call time from `runtime/active-item.json`.

Provider code should not read chat credentials directly. It should call `anima message`, `anima reminder`, or `anima subscription` so the side effect is audited against the current item.

Kimi and Grok context caps are server-level provider settings, not agent environment variables.
Before starting a new child, the adapter holds the same machine advisory lease used by provider
launches and applies the persisted cap to the provider's official user-level TOML configuration.
Kimi receives a model-scoped `max_context_size`. Grok receives a session-wide
`auto_compact_threshold_percent` calculated from the largest native context window among configured
Grok models, so the provider's auto-compaction threshold is at or below the selected token count for
every model. An explicit save adopts an existing value for the setting Anima manages by marking and
replacing only that key. After adoption, only Anima-marked keys are updated or removed. Running
provider children are unchanged.

OpenCode authentication follows the same machine-level rule. The DeepSeek API key lives in
OpenCode's own credential store after `opencode auth login --provider deepseek`. The OpenCode
adapter pins the auth/config location (`HOME`, XDG, and custom config paths) to the Anima service
environment and removes inline credential/config overrides from each child launch environment, so
an agent-specific Launch env cannot silently replace the shared OpenCode identity.

## Provider Sessions

Provider session ids are stored on Anima's primary session record by provider kind. `AgentRuntimeBridge` reads the current provider session and passes it to the adapter as `providerSession`.

They are used to resume the underlying tool's native context:

- Codex: the stored id is the Codex thread id;
- Claude: the stored id is the Claude Code session id;
- Kimi: the stored id is the Kimi ACP session id;
- Grok: the stored id is the Grok ACP session id.
- OpenCode: the stored id is the OpenCode ACP session id.

When a provider emits a new session id, the adapter calls `effects.persistProviderSession`. The sink updates Anima's primary session record.

Provider sessions are not the Anima product session. If a provider session is compacted, rotated, restarted, or replaced, Anima still has the durable primary session, inbox history, instructions, and activity log.

If a resumed provider session is identified as structurally corrupt, the worker can archive that exact provider session and retry the current inbox item once with a fresh provider session. Any follow-ups already appended to the failed run are requeued before the retry. The recovery writes an automatic `anima.session.rotate` activity. This is separate from ordinary provider-process crash retry: adapters must raise a typed corruption error for a condition they can identify precisely rather than treating every provider failure as damaged session state. Codex currently does this for resumed-session turn desynchronization and the exact missing-tool-output transcript diagnostic.

## Codex Adapter

Implementation: `server/providers/codex.ts`.

Current process model:

- Anima starts one persistent `codex app-server --listen stdio://` process for the runtime worker.
- The Codex thread id is persisted and resumed on later items.
- By default Anima does **not** set `model_auto_compact_token_limit`; Codex uses its own
  context window and auto-compact behavior. Agent config
  `provider.env.ANIMA_CODEX_AUTO_COMPACT_TOKEN_LIMIT` can opt into an Anima-managed limit with a
  positive integer (invalid values fail the run instead of silently falling back). When set,
  Anima also sends `model_auto_compact_token_limit_scope=total`.
- The process stays alive across Anima items until abort or worker shutdown.
- Anima sends the runtime standing prompt through Codex `developerInstructions`; each item input contains only the bridge-built delivery prompt.
- Thread start/resume explicitly sets `approvalPolicy: "never"`, `sandbox: "danger-full-access"`, optional `model`, optional auto-compact config above, and optional `config.model_reasoning_effort`.

Protocol:

1. send JSON-RPC `initialize`;
2. send `thread/start` or `thread/resume`;
3. persist the returned thread id as the `codex-cli` provider session;
4. send `turn/start` with the bridge-built delivery prompt;
5. collect `item/agentMessage/delta` notifications as internal text;
6. map provider tool notifications to Anima activities;
7. resolve when `turn/completed` arrives.

Active-run follow-up:

- Once `turn/start` returns a turn id, the adapter exposes that id as ready.
- `appendToActiveRun` sends `turn/steer` with `expectedTurnId`.
- If Codex accepts the request, the worker marks the new queued item completed as part of the active item.

Activity mapping:

- `item/started` can become `tool.call.started`;
- failed command/file/MCP/web-search items can become `tool.call.failed`;
- `contextCompaction` items become `runtime.event` `codex.compact.started` / `codex.compact.completed` / `codex.compact.failed`;
- `turn/completed` usage/model/status data becomes `runtime.event` `codex.session.stats`;
- assistant text deltas are accumulated and returned as internal `AgentRuntimeResult.text`.

## Claude Adapter

Implementation: `server/providers/claude.ts`.

Claude Code uses the stream-json transport over stdio. (A tmux transport existed until 2026-07;
it was removed as unused; git history has it if ever needed.) The launch pieces live in
`server/providers/claude-launch.ts`: the common CLI flags, the provider env defaults, and the
system-prompt file written from `systemPromptFilePath`.

Current process model:

- Anima starts one persistent `claude` process for the runtime worker.
- It uses stream-json input/output over stdio.
- It intentionally does not use `claude -p`.
- If Anima has a stored Claude session id, startup includes `--resume <session_id>`.
- Agent config `provider.fastMode: true` requests Claude Code fast mode for that
  child with the official per-session `--settings '{"fastMode":true}'` seam.
  It is an opt-in request, not an availability claim: Team and Enterprise owners
  must enable fast mode and usage credits, and Claude can fall back to standard
  speed. Provider result events remain the authority for the observed
  `fast_mode_state`.
- The adapter sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=272000` by default to match Codex's current `gpt-5.5` context-window budget; agent config `provider.env` can override it.
- The process stays alive across Anima items until abort or worker shutdown.

### Claude credentials

Claude accounts are managed outside Anima (native Claude Code login or your own switcher).
Anima uses the host user's native `~/.claude` credential store for runtime and usage reads.
It does not maintain an in-product account registry, add/switch UI, or per-agent credential isolation.

Command shape:

```text
claude
  [--settings '{"fastMode":true}']
  --output-format stream-json
  --verbose
  --input-format stream-json
  --permission-mode bypassPermissions
  --disallowedTools AskUserQuestion,CronCreate,CronDelete,CronList,ScheduleWakeup,RemoteTrigger,PushNotification
  [--resume <session_id>]
  [--model <model>]
  [--effort <reasoningEffort>]
  --system-prompt-file <runtime prompt file>
```

### Provider Tool Policy

Anima uses provider tools for observability only; chat side effects, reminders, subscriptions, inbox routing, and scheduling must stay Anima-owned. Claude Code currently receives a small strategic denylist through `--disallowedTools`:

| Tool                                                       | Current CLI presence      | Runtime behavior                                                                                                                        | Side effect                                                                                     | Decision      |
| ---------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| `AskUserQuestion`                                          | Claude Code built-in      | Fails in the non-interactive runtime.                                                                                                   | Attempts to ask the operator outside Anima.                                                     | Deny          |
| `CronCreate` / `CronDelete` / `CronList`                   | Claude Code built-ins     | Works as Claude-native session cron management.                                                                                         | Creates or manages recurring scheduled prompts outside Anima inbox/reminder/activity ownership. | Deny          |
| `ScheduleWakeup`                                           | Claude Code built-in      | Works as Claude-native one-off delayed wake.                                                                                            | Creates future wakeups outside Anima reminders and audit.                                       | Deny          |
| `RemoteTrigger`                                            | Claude Code built-in      | Not needed by Anima runtime.                                                                                                            | Establishes provider-native remote triggers outside Anima routing.                              | Deny          |
| `PushNotification`                                         | Claude Code built-in      | Not needed by Anima runtime.                                                                                                            | Sends provider-native notifications outside Anima-visible messaging.                            | Deny          |
| `SlashCommand`                                             | Claude Code built-in      | Observe. Some commands are internal and may be valid in stream-json.                                                                    | Can affect Claude session state, but not proven broken in Anima.                                | Allow/observe |
| File, shell, search, task, todo, notebook, and skill tools | Claude Code built-ins     | Required for normal agent work.                                                                                                         | Provider work, surfaced through Anima activity mapping.                                         | Allow         |
| Codex CLI tools                                            | Codex app-server protocol | No equivalent user-question/scheduler controls found in the current adapter surface.                                                    | Tool activity is mapped by Anima.                                                               | Allow/observe |
| Grok Build tools                                           | Grok ACP                  | Launched with `--always-approve`; ACP permission requests are approved for the session and unsupported client methods are rejected.     | Tool activity is mapped by Anima.                                                               | Allow/observe |
| Kimi CLI tools                                             | Kimi ACP                  | Anima initializes with empty client capabilities; interactive prompts are not exposed through the adapter.                              | Tool activity is mapped by Anima.                                                               | Allow/observe |
| OpenCode tools                                             | OpenCode ACP              | Launched with `--pure`; ACP permission requests prefer the provider's allow-always option, and unsupported client methods are rejected. | Tool activity is mapped by Anima.                                                               | Allow/observe |

The denylist is global for now. Per-agent tool policy should be added only when there is a concrete operator need; the default policy should keep provider-native scheduling and notifications out of the runtime.

Provider `run` protocol:

1. ensure the persistent Claude process exists;
2. mark the Anima item as active;
3. create a current provider controller;
4. write one bridge-built delivery prompt as a JSONL user message to Claude stdin:

   ```json
   {
     "type": "user",
     "message": {
       "role": "user",
       "content": [{ "type": "text", "text": "..." }]
     }
   }
   ```

5. stream Claude stdout through the JSONL activity mapper;
6. resolve the item on Claude `type: "result"`;
7. leave the Claude process open for the next Anima item.

Active-run follow-up:

- `appendToActiveRun` is accepted only when the requested active item id matches the adapter's current active item.
- Accepted follow-up input either writes another JSONL user message to the same Claude stdin or queues it behind the adapter's input gate.
- The input gate closes while Claude is compacting or while provider tool calls have not emitted matching `tool_result` items.
- Queued follow-up input is flushed only after compacting is done and outstanding provider tool calls are closed.

Compact and stats:

- `system/status` with `status: "compacting"` becomes `runtime.event` `claude.compact.started`.
- `system/compact_boundary` becomes `runtime.event` `claude.compact.completed`.
- `system/status` with `compact_result: "failed"` becomes `runtime.event` `claude.compact.failed`.
- `result` usage/model data becomes `runtime.event` `claude.session.stats`.

The web app reads the latest `claude.session.stats` activity to show model, context window, cache-read tokens, cache-create tokens, output tokens, terminal reason, and update time.

Abort behavior:

- Worker stop, idle timeout, or shutdown aborts the active item's signal.
- The Claude adapter responds by killing the persistent child process.
- The next item starts a fresh Claude process and resumes from the stored provider session id when possible.

Why stdout is not buffered:

- Persistent Claude sessions can run for a long time and produce large JSONL streams.
- `child-process.ts` supports `bufferOutput: false` so stream callbacks still run but stdout/stderr are not accumulated in memory.

## Kimi Adapter

Implementation: `server/providers/kimi.ts`.

Current process model:

- Anima starts one persistent `kimi --yolo acp` process for the runtime worker and speaks ACP
  (Agent Client Protocol) with it over stdio.
- Like the Codex and Claude adapters, it extends `ControllerAgentRuntime`, so the controller slot,
  health, drain, close, and the runtime activity envelope are shared machinery.
- The process stays alive across Anima items until abort or worker shutdown.

Session handling:

1. initialization sends empty client capabilities, so interactive prompts are not exposed through
   the non-interactive runtime;
2. with a stored provider session id, the adapter sends `session/resume`; if the resume fails, it
   records `kimi.session.resume_missing` and falls back to `session/new`;
3. a configured model is applied with `session/set_model`;
4. for K3, configured `reasoningEffort` is applied before the first prompt with
   `session/set_config_option` using `configId: "thinking"`; the managed always-thinking models do
   not expose a graded effort;
5. the ACP session id is persisted as the `kimi-cli` provider session.

Provider `run` protocol:

- each item sends one `session/prompt` with the bridge-built delivery prompt;
- ACP updates stream through the activity mapper: thinking deltas, tool-call notifications, plan
  display, hooks, and usage/context telemetry become `kimi.*` runtime events, and assistant text
  accumulates as internal `AgentRuntimeResult.text`.

Active-run follow-up:

- `appendToActiveRun` is accepted only when the requested active item matches the adapter's
  current active item;
- compatible follow-ups are accepted on the same ACP session; if a prompt is already in flight,
  Anima sends `session/cancel` first so the follow-up starts immediately (not after the prior
  prompt's natural `end_turn`). Cancelled-prompt assistant chunks are rolled back so they do not
  join the final reply. Operator stop still cancels and drops any not-yet-run follow-ups.
  Shared policy: `server/providers/acp-midturn-followup.ts`.
- `kimi.steer.consumed` records when the session actually takes a follow-up.

## Grok Build Adapter

Implementation: `server/providers/grok.ts`.

Current process model:

- Anima starts one persistent `grok --no-auto-update agent --no-leader --always-approve ... stdio`
  process and speaks ACP over stdio.
- Fresh work uses `session/new`; a stored provider session uses Grok's supported `session/load`.
  A confirmed missing session falls back to `session/new`. Anima does not emulate unsupported fork
  or resume-prompt operations.
- Each item uses `session/prompt`. Compatible follow-ups use the shared ACP mid-turn interrupt
  policy (`server/providers/acp-midturn-followup.ts`): if a prompt is already in flight, Anima
  sends `session/cancel` first so the follow-up starts immediately (not after the prior prompt's
  natural `end_turn`). Cancelled-prompt assistant chunks are rolled back. Operator stop still
  cancels and drops any not-yet-run follow-ups.
  Full stop also sends `session/cancel` before Anima tears down the child.
- If the provider API fails transiently (5xx/529 overload, network or mid-stream stalls, local TLS
  errors, or an Anthropic safeguard refusal, which the provider itself describes as a frequent
  false positive), the worker records `provider.transient.retry` and re-sends the same inbox item on
  the same provider session with backoff (5s, 30s, 2min; three attempts). The retry prompt carries
  the previous error and the standard "do not repeat completed side effects" note. Adapters may
  also perform one immediate in-turn retry first (Claude Code does); the worker-level retries sit
  above that.
- If the provider is rate limited or a session/usage quota is exhausted, the item is not failed:
  the worker records `provider.rate_limit.defer`, parks the item in the wake queue with
  `handling.notBefore` set to the provider's reported reset (bounded to 30s–6h, default 5min when
  no reset is reported), marks health `provider_rate_limited`, and the regular poll reclaims it once
  due. A single item may be deferred up to six times before it is failed.
- When an item fails for good (terminal error, retries exhausted, deferral budget spent), the worker
  records `runtime.failed` with `retryClass`, and (for DMs and direct mentions only) replies in the
  originating conversation so the requester knows to resend (`runtime.failure_notice`). Passive
  channel/thread follows never get a notice.
- If the child exits mid-turn, the worker records `provider.crash.retry` and retries the same inbox
  item. The persisted session is loaded again; the interrupted prompt is not assumed durable.
  Follow-ups already accepted for that item are retained across child replacement and reach the
  fresh child before their durable rows complete. Cancellation closes the in-memory queue before
  `session/cancel`, so no later prompt begins after a stop.

Command shape:

```text
grok
  --no-auto-update
  agent
  --no-leader
  --always-approve
  [-m <model>]
  stdio
```

Model and context authority:

- The configured and reported model is the actual ID returned by Grok's model catalog or prompt
  result. `grok-build` is a marketing alias and is not accepted as stored model identity. Live
  catalog examples include `grok-4.5` and `grok-composer-2.5-fast` (dynamic; not a static enum).
- Optional `reasoningEffort` is **model-scoped** in Grok Build (ACP
  `supportsReasoningEffort` / `reasoningEfforts` per catalog entry), and is knowable only from the
  live ACP catalog: never inferred from the model name. Launch argv never carries `--effort`.
  Config writes: when the live ACP catalog is available for the selected model, that
  per-model menu is authoritative; otherwise the write vocabulary
  (`low` / `medium` / `high` / `xhigh`) is used so offline saves still work. After
  session init (new or loaded) and before the first prompt, the runtime sends at most one same-model
  `session/set_model` with `_meta.reasoningEffort`, and only when the exact live current model
  advertises that effort. Unknown current model, missing capability for that exact model, or an
  unadvertised effort fails closed: no setter is sent and the model's own default stands.
- A configured effort on a model that does not advertise it (for example
  `grok-composer-2.5-fast`) is therefore **stored and silently not applied**, not rejected at config
  time.
- Operator effort menus come from the live `modelReasoningEfforts` snapshot. Without that data the
  menu is empty rather than guessed.
- Model availability and context-window size are read at runtime and carry a check timestamp. If
  the CLI cannot provide the catalog, operator surfaces say **not checked** instead of using a static
  provider enum.
- Grok Build account credits are read from the same private grok.com billing endpoint Raycast Agent
  Usage uses (`GetGrokCreditsConfig`), authenticated with `~/.grok/auth.json` (and optional OIDC
  refresh). The CLI itself has no usage subcommand; Anima does not invent quota numbers.

Install and credential boundaries:

- Automated probes pass `--no-auto-update`; only an explicit Providers-panel update invokes the
  recognized native install's own updater.
- Unknown or shadowed installs remain manual. Anima does not log out, copy credentials, edit PATH,
  migrate `GROK_HOME`, or install Grok Build automatically.

Evaluation boundary: earlier research made Grok Build look strongest on long terminal tasks, but it
did not establish that Grok Build beats Claude Code or Codex on Anima repository accuracy or
documentation work. Adding the adapter does not move an existing agent or recommend a provider
switch.

## OpenCode Adapter

Implementation: `server/providers/opencode.ts`.

Current process model:

- Anima starts one persistent `opencode acp --pure` process and speaks ACP over stdio.
  `--pure` disables external OpenCode plugins for a deterministic runtime boundary; OpenCode's
  built-in tools and first-party providers remain available.
- Fresh work uses `session/new`. A stored provider session uses `session/resume`; only a confirmed
  missing session falls back to `session/new`.
- The selected DeepSeek model is applied after session creation or resume and before the first
  prompt with `session/set_config_option` using `configId: "model"`.
- Optional `reasoningEffort` (`high` or `max`) is then applied before the first prompt with
  `session/set_config_option` using `configId: "effort"`.
- Each item uses `session/prompt`. Compatible follow-ups use the shared ACP mid-turn interrupt
  policy (`server/providers/acp-midturn-followup.ts`): if a prompt is already in flight, Anima
  sends `session/cancel` first so the follow-up starts immediately. Cancelled-prompt assistant
  chunks are rolled back. Operator cancellation sends `session/cancel` before Anima tears down
  the child.
- ACP thinking, assistant text, usage, tool calls, tool failures, and permission requests are mapped
  into the same Anima activity and health surfaces as the other providers.

Anima currently exposes `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` for OpenCode.
Both support `high` and `max` effort. The retired `deepseek-chat` and `deepseek-reasoner` aliases
are not accepted for new agent configuration.

OpenCode, Kimi, and Grok all use ACP, but most of their session and event contracts are
provider-specific. Shared pieces:

- `server/providers/acp-json-rpc.ts`: newline framing, JSON-RPC request correlation, and
  request/notification routing;
- `server/providers/acp-midturn-followup.ts`: mid-turn follow-up interrupt via `session/cancel`
  and cancelled-prompt text isolation.
  Session methods, permission policy, model selection, and activity mapping remain in each adapter.

## pi Adapter

Implementation: `server/providers/pi.ts`.

pi ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent))
is a multi-provider coding agent. Anima uses it as a bridge to model providers it has no
first-party adapter for (Google Gemini, DeepSeek, OpenRouter, ...).

Current process model:

- Anima starts one persistent `pi --mode rpc --no-extensions` process per runtime and speaks
  pi's JSONL RPC protocol over stdio. stdin stays open for the child's lifetime; closing it
  would abort the active run.
- The model is selected at launch with `--model <provider/id>` and the optional
  `reasoningEffort` maps to `--thinking <level>`. The model menu is live: the dashboard
  availability probe runs a short `pi --mode rpc --no-session` child, sends
  `get_available_models` + `get_state`, and offers exactly the `provider/id` values pi can reach
  with the machine-level credentials (pi's current model is the default). An empty list is
  reported as a model-check error with credential guidance rather than a guessed menu.
- The Anima runtime profile is passed with `--system-prompt <file>`, which replaces pi's own
  coding prompt entirely. pi still appends project context files (`AGENTS.md`/`CLAUDE.md`), the
  skills list, and one `Current working directory:` line. `--no-extensions` keeps extension UI
  requests, which would block a headless run, out of the loop; pi's built-in tools remain.
- Session continuity uses `--session-id <uuid>`: Anima generates the id for a fresh session and
  persists it as the provider session. On resume pi reopens the session with that id under the
  agent's working directory; when the file is gone pi recreates it with the same id and Anima
  records `pi.session.resume_missing`.
- Each item is one `prompt` command; `agent_settled` ends the turn. Compatible follow-ups are sent
  as `steer`, which pi delivers at the next tool boundary of the active turn. Operator
  cancellation sends `abort` before Anima tears down the child.
- Assistant text, thinking deltas, `tool_execution_*` events, per-message usage and cost
  (`pi.session.stats`, `pi.context.stats`), auto-retry, and compaction events are mapped into
  the same Anima activity and health surfaces as the other providers. A message that ends with
  `stopReason: "error"` fails the item; a leading HTTP status in pi's error text drives the
  failure classification.

Credential policy matches OpenCode: provider credentials are machine-level. Anima pins `HOME`
and `PI_CODING_AGENT_DIR` to the service environment and replaces every `*_API_KEY` in the
agent's Launch env with the machine value (or removes it). Operators configure pi once per host
with `pi` → `/login`, `~/.pi/agent/auth.json`, or a provider API key in the service environment.

## Agent Activities

Provider adapters write activities so the user can inspect what happened without reading raw provider logs.

Common runtime activities:

- `runtime.started`: provider process/transport began work;
- `runtime.completed`: provider work finished normally;
- `runtime.failed`: provider work threw or exited unsuccessfully;
- `runtime.aborted`: worker aborted the item because of `idle_timeout`, `shutdown`, or `user_stop`;
- `runtime.output`: raw stdout/stderr chunks when they are not parsed into richer records;
- `runtime.event`: provider lifecycle events such as compact and session stats.

Provider tool activities:

- `tool.call.started`: provider-side tool/action started;
- `tool.call.failed`: provider-side tool/action failed.

Agent text:

- `agent.text`: assistant text observed from provider stdout.

Chat tool activities are separate. When the spawned code agent calls `anima message send`, that goes through `server/tools/messages.ts` and records `tool.call.started` / `tool.call.completed` / `tool.call.failed` for the chat side effect. Provider shell/Bash wrapper rows for first-class Anima CLI tools (`anima message read/send/update/react`, `anima file send`) are suppressed so the activity stream shows the semantic chat tool row once.

## Current Boundaries and Tradeoffs

- Codex, Claude, Kimi, Grok, OpenCode, and pi all keep provider continuity through a persisted provider session id and a persistent child process for the lifetime of the worker.
- Auto-compact is provider-owned. Anima observes compact events and records them; it does not perform compaction itself.
- Active-run follow-up append is best-effort. If a provider rejects a follow-up, the item is requeued and processed after the active item.
- An accepted follow-up item is considered absorbed by the active item. It will not have a separate provider result.
- A Claude item can span more than one provider `result` boundary when queued follow-up input is flushed at the boundary; Anima waits for the final provider result before completing the active item.
- Provider sessions are execution-layer state. The durable product session is still Anima's primary session plus inbox/activity history and home instructions.

## Adding Another Provider

A new provider should:

1. implement `AgentRuntime`;
2. set `kind` and optional `env`;
3. consume the bridge-provided `prompt`, `cwd`, `env`, `providerSession`, `signal`, and `effects`;
4. map provider stdout/stderr into `effects`;
5. persist provider session ids through `effects.persistProviderSession`;
6. implement `appendToActiveRun` using the provider's real in-flight input protocol;
7. implement `close` if it keeps a process or connection alive beyond a single item.

Adapters that keep one long-lived child-process controller per runtime (the Claude stream-json, Codex, Kimi, Grok, OpenCode, and pi shape) should extend `ControllerAgentRuntime` in `server/providers/provider-runtime.ts`. It owns the controller slot, active-run tracking, `close`/`health`/`requestDrain`, child spawning, and the `runtime.started`/`runtime.completed`/`runtime.failed` activity envelope; the adapter supplies only the provider protocol.

The worker should not need provider-specific changes for a new adapter.
