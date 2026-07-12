# Activity Tab: Events & Display Reference

How the Activity tab presents what an agent did. The activity log (`activity.jsonl`)
is an append-only curated audit: it keeps user-visible and diagnostic events, while
raw provider protocol frames are dropped before storage. This doc explains the
display layer on top of that log: **which persisted events surface, in which view,
and what each row shows**.

It describes current behavior, not a wishlist. Where a field genuinely isn't
available yet, it's called out under [Known gaps](#known-gaps).

## Sources

Fourteen modules import the activity service. Ten write to the log, four only read
it. **These two tables are the claim**, and `server/tests/activity-emitters.test.ts`
parses them out of this file and compares them against a set re-derived from the
sources. There is no third list: edit a table, or the test reds.

#### Emitters

| module                                          | writes                            |
| ----------------------------------------------- | --------------------------------- |
| `server/agents/agent.service.ts`                | agent lifecycle                   |
| `server/asks/interactive-ask.service.ts`        | `anima ask` prompts and answers   |
| `server/inbox/attention-suggestion-activity.ts` | attention suggestions             |
| `server/inbox/slack-subscriber.ts`              | subscription changes from Slack   |
| `server/inbox/subscription.service.ts`          | subscription changes from the CLI |
| `server/memory/memory-coherence-outcome.ts`     | memory pass outcomes              |
| `server/reminders/reminder.activity.ts`         | reminder schedule, fire, cancel   |
| `server/runtime/activity.ts`                    | turns, messages, provider events  |
| `server/slack-interactions/shortcut.service.ts` | Slack shortcut invocations        |
| `server/tools/tool-context.ts`                  | tool steps                        |

#### Readers

| module                                            | reads                          |
| ------------------------------------------------- | ------------------------------ |
| `server/diagnostics/agent-diagnostics.service.ts` | `readLastN` for health output  |
| `server/memory/memory-coherence-scheduler.ts`     | `readNewestUntil` to find work |
| `server/runtime/item-activities.ts`               | `readAll` to rebuild an item   |
| `server/web/agent-routes.ts`                      | `listActivityFeed` for the tab |

`server/inbox/subscription.service.ts` writes and does not read; its `.list()` call
belongs to `SubscriptionStore`. Display: `web/src/lib/activities.ts`,
`web/src/lib/activity-feed.ts`, `web/src/views/agents/activity/*`.

**Re-derive the emitter table yourself:**

```sh
# modules importing the activity service, by SPECIFIER, that also write
grep -rlE "from ['\"][^'\"]*activities/activity\.service\.js['\"]" --include='*.ts' server \
  | grep -v '/tests/' | grep -v 'activities/activity.service.ts' \
  | xargs grep -lE 'activityServiceForAgent\([^)]*\)[[:space:]]*\.[[:space:]]*record\(|: (ActivityRecorder|ActivityService)' \
  | sort
```

Three traps this encodes, each of which produced a wrong answer before it was written
down.

**Match the module specifier, never the imported name.** `server/reminders/` records
through a `ReminderActivityRecorder` and never mentions `activityServiceForAgent`, so
a symbol grep silently misses it.

**Bind a call to its receiver.** A bare `.record(` or `.list(` matches any object in
the file: `SubscriptionStore.list()` reads as an activity read, and
`saveAsk(record: InteractiveAskRecord)` reads as a write.

**The service arrives three ways** - called directly, injected as an `ActivityService`,
or injected as an `ActivityRecorder`. A check that knows only the first two reports
`server/asks/interactive-ask.service.ts` as neither reader nor writer.

Adding emitter #11 turns the test red. Add it to the table in the same commit.

## What the Activity tab is

The Activity tab is our **audited boundary made legible**: it turns the
conversational subset of persisted chat side effects, tool calls, provider
events, and runtime transitions into something a human can actually read. The
activity log is the source of truth for the curated audit; the tab is a readable
projection of it.

## Display principles

**1. Three tiers decide whether an event shows, and where.**

| Tier             | Where it shows                                   | What lives here                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conversation** | The timeline (messages + per-message step folds) | What a human reads to follow what the agent _did_: its output, the files/commands/searches it touched, the messages it sent, reminders, subscriptions, failures.                                                                                                                                            |
| **Audit**        | Persisted only (no UI surface today)             | Diagnostics worth having when inspecting but noise in the narrative: session/usage stats, rate limits, retries, model reroutes, provider warnings, low-level lifecycle. Kept in `activity.jsonl`; the feed builder can expose them (`showHidden`), but since the single-timeline rework no UI control does. |
| **Hidden**       | Never rendered                                   | Raw streaming/protocol frames, per-token deltas, `*.system.init`, `*.context.stats`, sanitized reasoning, legacy duplicate event names. Most of these are dropped before storage by design; if an old row exists, the UI never draws it.                                                                    |

The former "Show all steps" and "Failed only" controls were retired with the single-timeline
rework: Conversation steps now fold behind a per-message `▸ N steps` disclosure, and failure rows
render in place with failure styling instead of behind a filter.

**2. Each row is headline + the params that make it specific + the rest on expand.**

Every shown row is a one-line **headline** anyone can scan, the **1–2 params that
make it meaningful** inline (the query, the path, the command, not just the verb),
and, when the inline text is truncated or overflows, a **chevron to expand** the
full untruncated text. The expand reveals the full _content of that field_ (the
whole command, the whole output), not a raw payload dump. Rows whose params fit
don't get a chevron; message/file rows show their full body inline already.

**3. Categories are by function; tier is orthogonal.**

The catalog below is grouped into five functional categories so it's navigable.
A category answers "what kind of thing is this event about"; the tier answers
"should it show by default". The two are independent: a category mixes
Conversation, Audit, and Hidden rows.

## Event catalog

1. [Run lifecycle & agent output](#1-run-lifecycle--agent-output)
2. [Provider tool calls](#2-provider-tool-calls)
3. [Chat actions](#3-chat-actions)
4. [Reminders, subscriptions & session](#4-reminders-subscriptions--session)
5. [Provider internals & diagnostics](#5-provider-internals--diagnostics)

### 1. Run lifecycle & agent output

The agent's text output and the start/finish/fail/abort of a run.

| Event                                                                | When it fires                                                        | Tier                  | Shown inline                                                                                       | On expand          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- | ------------------ |
| `agent.text`                                                         | Provider emits final assistant text.                                 | Conversation          | `Output` + message text (truncated at 280 chars).                                                  | Full text.         |
| `runtime.completed`                                                  | Runtime finishes an item successfully.                               | Conversation (subtle) | `Idle` (turn-end marker).                                                                          | —                  |
| `runtime.failed`                                                     | Runtime throws or exits with an error.                               | Conversation          | `Run failed` + first line of the error.                                                            | Full error.        |
| `runtime.aborted`                                                    | Item aborted by restart drain, shutdown, user stop, or idle timeout. | Conversation          | Reason-mapped title: `Runtime restarted` / `Stopped by user` / `Idle timeout` / `Runtime stopped`. | —                  |
| `runtime.followup_failed`                                            | Appending a follow-up to an active run failed.                       | Conversation          | `Follow-up failed` + reason.                                                                       | Full reason/error. |
| `runtime.started`                                                    | Runtime starts processing an item.                                   | Audit                 | `Working` / `Message received`.                                                                    | —                  |
| `runtime.pending`                                                    | Item arrived while another was active and couldn't be appended.      | Audit                 | `Queued behind current item`.                                                                      | —                  |
| `runtime.followup_appended`                                          | Follow-up appended into an active run.                               | Audit                 | `Follow-up added to current run` + text snippet.                                                   | Full text.         |
| `runtime.output`                                                     | Raw stdout/stderr from a provider child process.                     | Audit                 | `Process output` + `[stream]` + first line.                                                        | Full text.         |
| `runtime.steered`, `runtime.steer_failed`, `runtime.provider_silent` | Legacy names predating the follow-up rename / watchdog diagnostic.   | Hidden                | —                                                                                                  | —                  |

### 2. Provider tool calls

Files, shell, search, web, and planning/subagent helpers the provider invokes.
Provider tools currently emit a `started` row (used as the visible row) plus
failures; successful completion rows aren't emitted yet (see [Known gaps](#known-gaps)).

| Event                                                                                                                                                                | When it fires                                       | Tier         | Shown inline                                                                                                                               | On expand                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| File/code tools: `Read`, `ReadFile`, `ReadMediaFile`, `Write`, `WriteFile`, `Edit`, `Grep`, `Glob`, `WebFetch`, `FetchURL`, `fileChange`, `StrReplaceFile` (started) | Provider starts a file/read/edit/list/fetch tool.   | Conversation | Verb (`Read` / `Wrote` / `Edited` / `Listed` / `Fetched`) + `target` (path / pattern). Edit rows can carry a diff on expand.               | Full target/diff if truncated. |
| Shell: `Bash` / `shell` (started)                                                                                                                                    | Provider runs a shell command.                      | Conversation | `Ran` + command (shell wrapper stripped, truncated at 120 chars). Anima CLI wrapper commands dedupe against the first-class `anima.*` row. | Full command.                  |
| Web search / research: `WebSearch`, `SearchWeb`, Codex `webSearch` (started)                                                                                         | Provider runs a web search.                         | Conversation | `Searched` + **the query** inline (reads `query`/`target`).                                                                                | Full query.                    |
| Planning / delegation: `Agent`, `Skill`, `TaskCreate`, `TaskUpdate`, `TodoWrite`, `SetTodoList` (started)                                                            | Provider starts a helper tool.                      | Conversation | Mapped verbs: `Delegated to subagent` / `Ran skill` / `Created task` / `Updated task` / `Updated todos` (+ target/title/name).             | Full target if truncated.      |
| `ToolSearch` (started)                                                                                                                                               | Provider searches its deferred tools.               | Audit        | `Searched tools`.                                                                                                                          | —                              |
| `tool.call.failed` (provider tools)                                                                                                                                  | A provider tool errors or a command exits non-zero. | Conversation | `<verb> failed` + target/command + terse error. Failed shell leads with the command.                                                       | Full error.                    |
| `(missing)` legacy Kimi tool-calls without `payload.tool`                                                                                                            | Pre-rename Kimi logs.                               | Hidden       | —                                                                                                                                          | —                              |

### 3. Chat actions

Messages, files, reactions, and reads the agent performs in Slack or Feishu, plus
the side-effect wrappers around the actual platform write. `started` rows are
dropped: the `completed`/`effect` row is the visible action, and the audited
`external.effect.*` row dedupes against the `anima.*` one.

| Event                                                                                                         | When it fires                                                   | Tier                       | Shown inline                                                                                                                                      | On expand                                  |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `external.effect.completed:slack.ask.post` / `tool=anima.ask`                                                 | Agent posts a bounded Slack question with buttons.              | Conversation               | `Asked <person>` / `Asked anyone` + question + `[option / option]`; the plain raw `anima ask ...` shell row is deduped.                           | Full question/options target if truncated. |
| `choice_response` inbox item                                                                                  | A human clicks a Slack ask option.                              | Conversation (inbound)     | Inbound row from the answerer: `Selected: <option>` + original question; surface chip points to the original channel/thread/DM.                   | Full body shown inline.                    |
| Slack or Feishu inbox item                                                                                    | A message, mention, DM, thread, or topic reply wakes the agent. | Conversation (inbound)     | Actor + rendered message body + platform-appropriate surface chip. Slack mention and formatting forms are normalized before display.              | Full body shown inline.                    |
| `anima.message.send` / `update` (completed), `external.effect.completed:slack.message.*` / `feishu.message.*` | Agent posts or edits a chat message.                            | Conversation (message row) | `Replied` / `Replied in thread` / `Edited` + surface chip + full message body. Subtle warning badge when `warnings` present.                      | Full body shown inline.                    |
| `anima.file.send` (completed), `external.effect.completed:slack.file.send` / `feishu.file.send`               | Agent sends one or more files.                                  | Conversation (message row) | File row + caption + attachment cards.                                                                                                            | Full body shown inline.                    |
| `anima.message.react` (completed), `external.effect.completed:slack.reaction` / `feishu.reaction`             | Agent adds/removes a reaction.                                  | Conversation (light)       | Reaction glyph/name + surface chip; subtle `noop` ("already present/absent").                                                                     | —                                          |
| `anima.message.read` (completed)                                                                              | Agent reads Slack or Feishu history.                            | Conversation               | `Read messages` + conversation · slice (`thread` / `around <time>` / `last N`) · message count.                                                   | Full target if truncated.                  |
| `anima.message.*` (failed), `external.effect.failed:slack.*` / `feishu.*`                                     | A chat message/file/react/read action fails.                    | Conversation               | Product title (`Message failed` / `Edit failed` / `File upload failed` / `Reaction failed` / `Read failed`) + error, matched by tool or `effect`. | Full error.                                |
| `tool.call.started:anima.*`, `external.effect.started:slack.*` / `feishu.*`                                   | The pre-write/started phase of an Anima chat action.            | Hidden (dropped)           | —                                                                                                                                                 | —                                          |

### 4. Reminders, subscriptions & session

Agent-owned schedules, channel/thread subscriptions, and provider-session rotation.

| Event                                       | When it fires                                                                                      | Tier             | Shown inline                                                      | On expand   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- | ----------- |
| `anima.reminder.schedule` (completed)       | Agent schedules a reminder.                                                                        | Conversation     | `Scheduled reminder` + title · `at <nextDueAt>`.                  | —           |
| `anima.reminder.cancel` (completed)         | Reminder cancelled.                                                                                | Conversation     | `Cancelled reminder` + title.                                     | —           |
| `anima.reminder.snooze` (completed)         | Reminder snoozed.                                                                                  | Conversation     | `Snoozed reminder` + `until <time>`.                              | —           |
| `anima.reminder.fire` (completed)           | Reminder wake fires and is enqueued.                                                               | Conversation     | Consumed into the inbound row: `Reminder` / `Reminder · fire #N`. | —           |
| `anima.reminder.list` (completed)           | Agent lists its reminders.                                                                         | Audit            | `Listed reminders`.                                               | —           |
| `anima.reminder.*` (failed)                 | A reminder action fails.                                                                           | Conversation     | `Reminder <action> failed` + error.                               | Full error. |
| `anima.subscription.add`                    | A Slack mention creates a channel/thread subscription.                                             | Conversation     | `Subscribed to` + `#channel` · kind (`channel`/`thread`).         | —           |
| `anima.subscription.remove`                 | Agent removes a subscription.                                                                      | Conversation     | `Unsubscribed from` + `#channel`.                                 | —           |
| `anima.session.rotate`                      | User rotates a provider session, or the runtime archives one during automatic corruption recovery. | Conversation     | `Session rotated` + `Archived N provider sessions` · note.        | —           |
| `tool.call.started:anima.reminder.schedule` | The started phase of a schedule.                                                                   | Hidden (dropped) | —                                                                 | —           |

### 5. Provider internals & diagnostics

Compaction, usage/rate-limit stats, retries, and raw streaming frames. Mostly
Audit or Hidden: these explain _how_ the provider ran, not what the agent did.

| Event                                                                                                                                                   | When it fires                                                                            | Tier                  | Shown inline                                                 | On expand     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------ | ------------- |
| `*.compact.completed`                                                                                                                                   | Provider finishes context compaction.                                                    | Conversation (subtle) | `Context compacted` (a memory/continuity beat).              | —             |
| `*.compact.failed`                                                                                                                                      | Context compaction fails.                                                                | Conversation          | `Compact failed` + error.                                    | Full error.   |
| `*.compact.started`                                                                                                                                     | Provider begins compaction.                                                              | Conversation (subtle) | `Compacting context`.                                        | —             |
| `*.session.stats`                                                                                                                                       | Provider reports turn/session usage.                                                     | Audit                 | `Session stats` + model · context · cached · output.         | —             |
| `claude.rate_limit`                                                                                                                                     | Claude reports rate-limit status.                                                        | Audit                 | `Rate limit updated` + status / type / reset when available. | —             |
| `codex.rate_limits.updated`                                                                                                                             | Codex reports updated rate-limit windows.                                                | Audit                 | `Rate limit updated` + limit label + reset.                  | —             |
| `codex.model.rerouted`                                                                                                                                  | Codex switches model mid-run.                                                            | Audit                 | `Model rerouted` + `from → to` + reason.                     | —             |
| `codex.warning` (and warning variants)                                                                                                                  | Codex emits a warning/config/deprecation notice.                                         | Audit                 | `Provider warning` + message/summary.                        | Full details. |
| `codex.protocol.invalid_json`                                                                                                                           | Codex writes a non-JSON line where JSON-RPC was expected.                                | Audit                 | Surfaces generically when flagged warning/failed.            | Full error.   |
| `claude.provider.retry`                                                                                                                                 | Side-effect-free transient error; Anima retries the turn.                                | Audit                 | `Provider retry` + reason.                                   | Full error.   |
| `claude.provider.resume_retry`                                                                                                                          | Transient error after partial progress; Anima resumes instead of repeating side effects. | Audit                 | `Provider resume retry` + reason.                            | Full error.   |
| `provider.crash.retry`                                                                                                                                  | Provider child crashes; Anima retries the same inbox item with a recovery notice.        | Audit                 | `Provider retry` + attempt/max + error.                      | Full error.   |
| `claude.session.resume_missing`                                                                                                                         | Stored provider session can't resume; a fresh one starts.                                | Audit                 | `Provider session expired` / `Started a fresh session`.      | —             |
| `grok.session.load_missing`, `kimi.session.resume_missing`                                                                                              | Stored ACP session can't resume; the adapter starts a fresh one.                         | Hidden                | —                                                            | —             |
| `grok.model.catalog`, `grok.turn.started`, `grok.turn.completed`, `kimi.turn.started`, `kimi.turn.completed`                                            | Grok and Kimi record model authority or per-prompt ACP lifecycle telemetry.              | Hidden                | —                                                            | —             |
| `runtime.restart_resumed`                                                                                                                               | A restart-drained inbox item resumes after service restart.                              | Hidden                | —                                                            | —             |
| `kimi.approval.response`                                                                                                                                | Kimi approval prompt is answered.                                                        | Audit                 | `Approval answered` + response.                              | —             |
| `*.context.stats`                                                                                                                                       | Continuous mid-run context-window telemetry.                                             | Hidden                | —                                                            | —             |
| `provider.reasoning`                                                                                                                                    | Sanitized reasoning snippet (not persisted).                                             | Hidden                | —                                                            | —             |
| `*.system.init`                                                                                                                                         | Provider session initialization.                                                         | Hidden                | —                                                            | —             |
| `codex.model.verification`, `claude.system.status`                                                                                                      | Low-signal provider status.                                                              | Hidden                | —                                                            | —             |
| Streaming frames: `*.stream.*`, `*outputDelta`, `*.thinking.delta`, `*.content.part`, `*.tool.call.part`, `*.tool_result`, hooks, plan, diff, turn/step | Raw provider protocol and per-token telemetry.                                           | Hidden                | —                                                            | —             |
| `runtime.event:assistant`, `runtime.event:system.api_retry`                                                                                             | Legacy diagnostics, superseded.                                                          | Hidden                | —                                                            | —             |

## Known gaps

A few rows can't yet show everything because the field isn't emitted. These are
emission-side (backend), not rendering:

1. **Provider tool success carries no result.** Provider adapters emit
   `tool.call.started` + failures, but no `tool.call.completed` for _success_, so
   there's no result summary to attach to a tool row (search → N results, read →
   bytes/lines, fetch → status). Surfacing those needs a completed row (or a
   result attached to the started row).
2. **Some historical/unknown provider tools still lack a `target`.** Known
   file/shell/search tools now derive `target`/`command` where the provider gives
   enough input, but old rows and provider-specific tools outside the catalog can
   still fall back to a bare verb until their input shape is mapped.

> The Codex `webSearch` query (previously missing from the log) is now emitted,
> so the search query shows inline (the original "Research shows only Research"
> defect). Logged here as resolved for context.
