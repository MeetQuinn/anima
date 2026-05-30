# Anima Design

## Problem

Teams lose most of what their people and agents produce — not because the work is weak, but because of where it ends up.

- **Work and knowledge stay locked in individual sessions and individual heads.** The context an engineer built up, the decision an operator made, the *why* behind a choice — these live in one person's chat history or memory and never compound across the team.
- **Using agents has a real barrier.** Driving a code agent well takes CLI fluency, prompt skill, and tool setup. Most of a team can't or won't do that, so agents stay a power-user tool instead of a team capability.
- **An agent is only as good as the machine it runs on.** A laptop with the right tools installed and authed is a different agent than a bare one — the same prompt yields very different results. Getting consistent value out of an agent depends on its environment, and that's a hidden variable most teams never control for.

## Proposal

Anima puts a **team of AI agents alongside your human team, in Slack.**

Each agent is a teammate with a name, a role, and a durable home. Your whole team works with it the way you work with anyone else — anyone can @mention it in a channel or DM it — and it shows up, picks up the work, and reports back. The agents run on a small, local, auditable runtime and accumulate shared knowledge as they go.

This answers the three problems head-on:

- **Slack is the interface → no adoption barrier.** Anyone on the team can work with an agent without learning a CLI or a prompt syntax.
- **A small, managed local runtime → the environment is handled, not improvised.** Setup is guided, and every action an agent takes is logged.
- **A shared knowledge base → work compounds instead of dying in one session.** What the team and its agents learn accumulates somewhere durable that gets more valuable over time.

Anima is not a skill marketplace, a generic provider platform, or a replacement for Codex, Claude Code, Kimi, repo scripts, or MCP servers. Users bring those capabilities; Anima makes them a team.

## Core Model

- **Team**: the human team plus its AI agent team, operating in Slack over a shared body of knowledge.
- **Knowledge Base**: a registered knowledge root. Humans govern it, agents read and write it, and git can preserve the compounding history of decisions, notes, and artifacts.
- **Agent**: a durable Slack teammate with a name, role, Slack app connection, provider config, owner, and home.
- **Home**: the agent's working seat inside a Knowledge Base. It contains `MEMORY.md`, notes, runtime scratch, and agent-specific context; it is not itself the whole Knowledge Base.
- **Inbox item**: one durable unit of work for an agent. Current sources are Slack messages, scheduled reminders, onboarding wakes, and follow-ups appended to an active run.
- **Session**: Anima's long-lived product continuity for an agent. It is not a Slack thread and not a provider process; it ties together inbox history, activity history, provider session ids, and token/accounting state.
- **Activity**: append-only audit of what the worker, provider, and Anima tools did. It is the inspectable record for Slack side effects, runtime lifecycle, provider events, and failures.
- **Reminder**: an agent-owned scheduled wake. It may include Slack provenance, but it does not need to be anchored to a Slack message.
- **Provider runtime**: the execution adapter for Codex CLI, Claude Code, or Kimi CLI. Providers run work; Anima owns routing, queue semantics, prompts, audited tools, and visible Slack side effects.

Durable continuity lives above the provider: agent identity, `MEMORY.md`, home notes, Knowledge Base files, inbox/activity logs, and source metadata. Provider-native instruction files are optional user-managed extras.

Provider sessions are lower-level execution details. The Codex, Claude, and Kimi adapters may store provider-native session ids on Anima's primary session, but Anima should remain correct if that provider session is compacted, restarted, or replaced.

## A team, not an assistant

The unit Anima is built around is **an AI agent team working alongside your human team** — not one assistant bonded to one person. An agent isn't owned by a single user; it serves and is governed by the whole team, and it addresses the team, not just whoever spoke last. The Slack-native interface and the shared knowledge base only make sense at team scale — that's the whole point.

## Why Slack, not our own interface

Many agent products build their own chat app. That is the harder path and the wrong one. A capable messaging surface is a deep platform — threads, reactions, files, search, channels, presence — and a home-grown one is years behind Slack while costing real effort to build. It also re-erects the adoption barrier, because it asks the whole team to move to a new tool.

Standing on Slack inverts this. The agent isn't confined to a bare chat box; with a Slack connection it becomes a **native operator of a mature collaboration surface** — it can thread, react, share files, search history, and work across channels and DMs, using the same tools the team already lives in. The richness that matters isn't custom widgets; it's an agent fluent in the workspace the team already uses.

So not building our own interface is a deliberate leverage choice, not a shortcut: we spend our effort on the differentiated layer — the agent team, its memory, the shared knowledge, the orchestration — and borrow a mature platform for the rest. When we hit a limit in Slack, the answer is the local web app as a depth-and-inspection surface, not rebuilding a weaker Slack.

## Shared knowledge is the moat

As the agents work, knowledge **compiles itself** — decisions, context, the *why* — into the team's Knowledge Base, which lives in git and compounds over time. **Agents author it; humans govern it.** It is the org brain that writes itself.

This is the moat because it is the one asset that gets *more* valuable the longer a team uses Anima, and it can't be copied — it is your team's accumulated context. Files are the source of truth; any graph or overview is a projection of them.

## Humans govern

Humans stay in charge, and the primary governing act is **deciding** — set direction, accept or reject, choose among options. The main governance surface is **comment + @mention**: a human comments on a file or a piece of work and @mentions an agent, and the agent revises. Humans don't hand-author the Knowledge Base; they steer the agents who do. Human leverage stays where it is highest — on the decisions — while the agents do the production.

## Product Principle

Default to the human teammate model:

> If this were a real person on the team, what would happen?

Use that answer unless there is a concrete technical, safety, or permission reason to do otherwise:

- a person does not get a new brain per Slack thread;
- a person can use DM context with judgment;
- a person acts through workplace tools instead of raw transport output;
- a person has notes and long-term instructions;
- a person's role defines what work they do.

Extended to team scale: not just a teammate but a **team of teammates** that coordinates among itself, so humans get pulled in for the decisions that matter, not the busywork.

## Product Boundary

Slack is where the team interacts with Anima. The runtime should stay small enough that a local developer can inspect and operate it:

- Slack messages wake the agent; scheduled reminders can wake it without auto-sending a message.
- The agent reads Slack context only through audited tools, and visible replies go back through Anima tools.
- Everything an agent does is inspectable, and users control agent/session state through local state and the web app.

Anima is not an "agent Notion" or a rich-text tool — the Knowledge Base is files in git; the value is agents authoring and humans governing, not a fancy editor. And business data belongs in the agent's own tools or scripts; Anima should not become an adapter layer for every data source an agent might use.
