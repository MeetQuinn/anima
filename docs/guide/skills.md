# Skills

Skills are how you teach an agent a repeatable way to handle a kind of work.

A skill is a capability pack: a `SKILL.md` file plus optional supporting files such as scripts,
templates, or references. When a task matches the skill's description, the provider (the coding
agent your agent runs on, such as Claude Code or Codex) reads the skill and follows it while it
works.

Skills are different from MCP. A skill teaches an agent how to think and act for a workflow; MCP
gives it a tool channel to an external service or API. They work well together. They solve
different problems.

## When to use notes, and when to use a skill

Most of what an agent learns should stay in its memory, its notes, or the shared knowledge base.
That is the default. Notes are light, local, and allowed to be messy while the agent and the team
are still figuring out how the work actually happens.

Reach for a skill only when a capability has stabilized. The question to ask:

- **Is this something this agent needs to learn and remember?** Memory, notes, or the knowledge
  base.
- **Is this an ability you would hand to any agent?** That may be ready to become a skill.

The portability test doubles as the privacy test: could another team or agent install this from the
open skills ecosystem without inheriting your private paths, people, secrets, or identity? If not,
it is a note, not a skill.

Portable here means installable through the Skills CLI from the open ecosystem. It does not promise
a skill works on every provider or every machine without adaptation.

Text-to-speech makes the line concrete. Teaching an agent to call an `edge-tts` tool and send back
an audio file is a good skill. "Milo uses this male Mandarin voice" is a profile preference, and it
belongs in memory, not in the shared skill.

In short: notes are how an agent remembers what it learns. Skills are how a stable capability
becomes something another agent can use.

## What skills are good for

Use a skill when you want an agent to get better at a repeatable workflow:

- reviewing pull requests in your team's style
- writing changelogs or release notes
- testing a frontend app
- following a design system
- working with a product or API your team uses often

The best skills are specific. "Review React PRs for regressions" beats "be good at engineering."

## Global skills and this agent's skills

The dashboard shows skills in two main groups:

- **Global skills** live on the machine and are available to the agents that run there.
- **This agent's skills** live in one agent's home and belong to that agent alone.

Provider and bundled skills may also appear in the dashboard; those are usually system or provider
skills. The two groups above are the ones you manage: the global skills you installed and the local
skills you gave a specific agent.

## Finding new skills

Most teammates never touch skills directly. They talk to the agent in Slack, and the person who
runs the agent's machine is the one who reviews and installs skills.

Anima includes a default `find-skills` skill so discovery has a clear path: ask an agent for a
specialized capability, and it should search for an existing skill before deciding the capability
is unsupported. The search runs through the Skills CLI against the open ecosystem:

```bash
npx skills find <query>
```

Ask for help with frontend testing, say, and the agent can search for testing skills and show you
the relevant options. If you approve one, it can install it with:

```bash
npx skills add <owner/repo@skill> -g -y
```

The `-g` flag installs the skill globally for the current user on that machine.

## When changes take effect

Provider CLIs discover skills when they start or begin work, so a newly installed or edited skill
usually applies to the next task or the next restarted provider session, not to a task already in
progress. If an agent does not seem to pick up a new skill, start a fresh task or restart the agent
runtime.

## Third-party skill safety

Skills come from an open, community ecosystem, not from Anima. Anima does not host, curate, or vet
them.

A skill can carry instructions and executable scripts, so treat one the way you treat code:

- install only from sources you trust
- read the `SKILL.md` before installing
- review any scripts or executable files that ship with the skill
- avoid installing skills that ask for secrets or broad credentials without a clear reason

Skills make agents more capable. They should still be visible and reviewable by the person who runs
the machine.
