# Architecture overview

> **What this is.** The one-page map of how Anima is built: the components, how a message flows
> through them, and where each concern lives in the code. It frames the rest of Part 2. Reader: the
> coding agent in the repo and human contributors. For the product-level introduction, see
> [What is Anima](../guide/what-is-anima.md); for the single-agent behavior, see [How an agent
> works](../guide/how-an-agent-works.md).

---

## The shape

Anima runs entirely on your machine. It sits between your Slack workspace and a provider (the coding
tool that actually runs each agent), keeps agent homes and registered KB files on local disk (the
shared knowledge base is git-backed by process, not by the server), and records messages, runtime
events, and its Anima-mediated side effects to an activity/event stream that a local dashboard reads.

```
  you, in Slack
     │  a message (DM, @mention, or a channel/thread the agent follows)
     ▼
  ANIMA  (the runtime on your machine)
     │  owns the Slack connection, message routing, and the audit log
     │  checks eligibility, then queues the message for the agent and wakes it
     ▼
  the AGENT runs one turn
     │  its provider (the coding tool you connect) is the engine
     │  reads the message with its existing session context
     │  reads its MEMORY.md / KB files when it needs them, does the work, calls tools
     │  sends any reply back through the anima tools
     ▼
  ANIMA
     │  posts the reply to the same place in Slack
     │  records messages, runtime events, and Anima-mediated side effects
     ▼
  you, in Slack          (the dashboard shows the whole turn)
```

## The round trip: a message in, a reply out

1. **Slack to Anima.** A Slack Socket Mode event arrives on that agent's Slack app connection.
2. **Eligibility first.** Before anything else, Anima applies eligibility: a DM or @mention always
   reaches the agent; a followed channel or thread reaches it unless muted.
3. **Enqueue.** If eligible, Anima normalizes the event into a Slack inbox item (a delivery envelope:
   who, where, when) and enqueues it.
4. **One turn.** `AgentRuntimeWorker` claims the item and runs one provider turn against the agent's
   **primary session**. The agent reads the delivery envelope with its existing session context, and
   reads its `MEMORY.md` or KB files when it needs them.
5. **Reply and record.** Agent-visible Slack outputs go through the `anima` tools; Anima posts them to
   the originating channel/DM and records them, with runtime events, to the activity stream the
   dashboard reads.

## Core invariants

- **One primary session per agent.** A single continuous session spans all of an agent's DMs,
  channels, and threads. It is not one session per thread. (`agent:<agentId>:primary` is a concept,
  not a stored key.)
- **Anima owns the Slack boundary.** The Slack protocol, message routing, and the audit log live in
  Anima, not in the agents. Agents reach Slack through Anima's first-class tools; the raw Slack token
  exists only as an escape hatch for Slack operations that do not yet have a first-class tool.
- **Agents author the KB, humans govern it.** The shared knowledge base is git-backed files on disk;
  the files are the source of truth, and any graph/overview is a projection of them.
- **Anima-mediated side effects are audited.** Every visible Slack side effect that goes through the
  `anima` tools (message, file, reaction, ask) is recorded, along with runtime events, to the activity
  stream. That record is what makes "govern = review plus decision" possible. The raw-token escape hatch
  is not an equivalent audited path, so capabilities promised to users should grow first-class, audited
  tools over time.

## Where to change what

A map from concern to its home in the code, for finding the entry point fast.

| Concern                                      | Home                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web dashboard UI                             | `web/src/`                                                                                                                                                                              |
| Frontend API clients                         | `web/src/api/`                                                                                                                                                                          |
| Local HTTP API routes                        | `server/web/` (shared DTOs in `shared/`)                                                                                                                                                |
| Agent identity, config, Slack connect, owner | `server/agents/`, `shared/agent-config.ts`; manifest `shared/slack-manifest.ts` + `server/slack/app-manifest.ts`                                                                        |
| Agent execution (running a turn)             | `server/runtime/` (`runtime-worker.ts`, `runtime-bridge.ts`, `delivery-prompt.ts`, `runtime-session.service.ts`, `followup-appender.ts`, `active-run-control.ts`, `provider-runner.ts`) |
| Managed runtime / supervisor / upgrade       | `server/runtime-management/`, `server/services/`, `server/cli/services-cli.ts`, `server/cli/animactl.ts`, `server/cli/animactl-npm.ts`, `packages/animactl/bin/`                        |
| Inbox, routing, attention, mute              | `server/inbox/` (`slack-subscriber.ts`, `slack-subscription.service.ts`, `wake-queue.service.ts`, `reminder-subscriber.ts`); item shape `shared/inbox.ts`                               |
| Slack-visible tools / audited outputs        | `server/tools/` (`messages.ts`, `reactions.ts`, `file-send.ts`, `ask.ts`); activity append `server/activities/`; message ledger `server/messages/`                                      |
| Providers                                    | `server/providers/` (`contract.ts`, `factory.ts`, `claude.ts`, `codex.ts`, `kimi.ts`, `*-events.ts`); usage data `server/provider-usage/`                                               |
| Knowledge base                               | `server/kb/`; routes `server/web/kb-routes.ts`; store `server/storage/schema/kb.store.ts`; contract `shared/kb.ts`; UI `web/src/views/kb/` + `web/src/api/kb.ts`                        |
| Persisted state                              | typed stores `server/storage/schema/`; JSON/JSONL mechanics `server/storage/json-file.ts`, `json-store.ts`, `jsonl-log.ts`                                                              |

## Three lines not to conflate

These three are easy to blur and should stay separate:

- **Agent execution runtime** (`server/runtime/`) runs an agent's turns.
- **Managed runtime / service supervisor** (`server/runtime-management/`, `server/services/`,
  `server/cli/`) starts, stops, and upgrades the whole thing.
- **Web routes** (`server/web/`) are a local control surface. They are _not_ the owner of the runtime.

## The rest of Part 2

The remaining Part 2 pages are planned, and will land as they are written:

- **Runtime:** the local process, the primary session, the inbox and wake loop.
- **Routing, attention & audit:** how a message moves and how the audit log is produced.
- **Knowledge base:** the git-backed KB and its visibility boundary.
- **Providers:** the provider abstraction and how to add one.
- **Activity & messages:** the event schema and how it is emitted.
- **Data model:** how sessions, reminders, subscriptions, and logs persist.
