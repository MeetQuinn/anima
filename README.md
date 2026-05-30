# Anima

**An AI agent team that works alongside your human team in Slack, building up shared knowledge over time.**

Anima runs a team of AI agents as real Slack teammates — each with a name, a role, and a memory. Anyone on your team works with them the way they work with anyone else: @mention one in a channel, DM it, hand it work. As the agents work, what they learn compiles into a shared knowledge base that lives in git and compounds over time — the org brain that writes itself.

It runs locally and wraps the coding agents you already use — Claude Code, Codex, or Kimi. It doesn't replace them.

## Why

Most teams get far less from AI agents than they could — because of where the work ends up and who can reach it.

- **Knowledge stays locked in individual sessions and heads.** Context and decisions live in one person's chat history, and never compound across the team.
- **Agents have an adoption barrier.** Driving a coding agent takes CLI fluency and prompt skill — so they stay a power-user tool, not a team capability.
- **A capable agent needs more than a model — it needs an environment: tools, access, a place to live.** Wired up ad hoc, that's uneven and stuck on one person's laptop.
- **Hosted assistants keep your context on someone else's servers.** Your team's accumulated knowledge ends up in a vendor's cloud, not in your hands.

Anima's answer, point for point:

- **A shared Knowledge Base → work compounds.** What the team and its agents learn accumulates in one durable, inspectable, git-backed place instead of dying in throwaway sessions.
- **Slack is the interface → no barrier.** Anyone @s an agent — a PM in `#product`, ops in a DM. No CLI to learn.
- **A local, audited runtime → the environment is handled.** One technical person sets it up once; from then on every agent runs the same managed setup, and every action it takes is logged.
- **It all runs on your machine → your data stays yours.** The runtime is local and the Knowledge Base is files in your own git — your team's accumulated context never leaves for someone else's cloud.

## What Anima is — and isn't

Anima is the **teammate layer** around your coding agents: a durable Slack identity, continuous memory, a shared Knowledge Base, and an audited boundary for every action.

- **In scope:** identity · continuous memory · shared Knowledge Base · audited Slack I/O · scheduled wakeups · multi-agent teams — all running locally.
- **Deliberately not:** not a model, not a hosted SaaS, not a data-integration platform, not a replacement for Claude Code / Codex / Kimi. Anima is the boundary around the tools you already run.

|                           | Raw coding-agent session                                       | Anima                                                               |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Who can use it**        | One developer, in a terminal                                   | **The whole team, via Slack @**                                     |
| **Memory**                | Resets per session                                             | **Continuous across DMs, channels, threads**                        |
| **Team knowledge**        | Locked in one session                                          | **Shared Knowledge Base in git, compounding**                       |
| **Side effects**          | Raw output                                                     | **Audited tools + local activity trail**                            |
| **Integration**           | Manual                                                         | **Any Slack @mention wakes it**                                     |
| **Where knowledge lives** | On each person's own machine — walks out the door when they do | **One shared team Knowledge Base in git — outlives any individual** |

## How it works

- **One continuous teammate.** DMs, channels, and threads all feed one primary session — @ an agent in `#product` today, DM it next week, and it still has the context. Not a new brain per thread.
- **Shared knowledge in git.** Agents write to `MEMORY.md` and a team Knowledge Base; humans govern by commenting and @mentioning an agent to revise. Files are the source of truth.
- **Audited Slack I/O.** Agents act through explicit `anima` CLI tools with a local activity trail — never raw auto-posts. That boundary is the teammate contract.
- **Scheduled wakeups.** Agents can schedule one-shot or recurring wakes for follow-up work, without auto-posting to Slack.
- **A team, not a bot.** Multiple named agents in one team, each with its own identity, provider, memory, and home. Route channels to teammates, or let the team @ whoever they need.
- **Bring your provider.** Each agent runs on Claude Code, Codex, or Kimi — picked per agent.

## Quick start

One command gets Anima running on your own machine. You'll need **Node.js 20+** and a coding-agent
CLI (Claude Code, Codex, or Kimi) installed and logged in.

```bash
npx -y @meetquinn/animactl start   # runtime + dashboard at http://127.0.0.1:4174
```

This downloads the managed runtime into `~/.anima/runtime/current` and stores local config, state,
logs, and pid files in `~/.anima/`. Then open the dashboard, create your agent, and follow the
**Connect Slack** steps — the full walkthrough, including Slack app creation and the two tokens, is
in **[docs/quickstart.md](docs/quickstart.md)**. If owner notification is on, the agent DMs the
owner to introduce itself. On a local desktop, `start` opens the dashboard automatically.

## Development

To work on Anima itself, run it from a source checkout with an isolated repo-local home:

```bash
git clone https://github.com/MeetQuinn/anima.git
cd anima
pnpm install
pnpm build
pnpm dev:services:start   # repo-local ./.anima/ home + dashboard at http://127.0.0.1:4174
```

`pnpm dev:services:start|status|restart|stop` set `ANIMA_HOME=./.anima` so dev state stays inside
the clone, separate from any managed `~/.anima/` install. A development rebuild should never change
the code a live `~/.anima/` install runs.

Build and test commands:

```bash
pnpm build           # full server + web production build
pnpm build:server    # server, shared, and server tests only; skips Vite
pnpm typecheck       # TypeScript only
pnpm test            # fast default gate: server build + unit/api tests
pnpm test:fast:dist  # run fast tests against an existing dist
pnpm test:runtime    # heavier CLI/provider/service subprocess tests
pnpm test:all        # full build + every compiled test file
```

Server tests live under `server/tests` and use Node's built-in test runner over compiled files in `dist/server/tests`. The default `pnpm test` intentionally skips the web build and the heavier runtime subprocess suite so local feedback stays fast; use `pnpm test:runtime` when changing provider, CLI, or service process behavior.

## Docs

- [Design](docs/design.md) — what Anima is, the core model, and the product principles
- [Quickstart](docs/quickstart.md) — run it on your machine
- [Provider layer](docs/runtime-providers.md) — Claude Code / Codex / Kimi
- [Release process](docs/release.md) — PR-only main, canary dogfood, and stable npm releases
- [Deployment and upgrades](docs/deployment.md) — code roots, Anima homes, and one-click upgrades
- [Service runbook](docs/service-runbook.md)
- [Slack app manifest](templates/slack-app-manifest.yaml)
- [Agent guidance](CLAUDE.md)
