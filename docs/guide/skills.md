# Skills

Skills are how you teach an agent a repeatable way to handle a kind of work.

A skill is a capability pack: a `SKILL.md` file plus optional supporting files such as scripts,
templates, or references. The provider (the coding agent your agent runs on, such as Claude Code or
Codex) reads the skill when a task matches its description, then uses those instructions while it works.

## When to use notes, and when to use a skill

Most of what an agent learns should stay in memory, notes, or the shared knowledge base. That is the
default. Notes are light, local, and allowed to be messy while the agent and team are still learning how
the work actually happens.

Reach for a skill only when a capability is stable enough to package. Ask the decision this way:

- **Does this agent need to learn and remember it?** Keep it in memory, notes, or the knowledge base.
- **Is this a reusable ability you would hand to any agent?** It may be ready to become a skill.

The portability test is the privacy test too: could another team or agent install it from the open skills
ecosystem without inheriting your private paths, people, secrets, or identity? If not, it belongs in
notes, not in a skill.

Here, **portable** means installable through the Skills CLI from the open ecosystem. It does not mean a
skill works on every provider or every machine without adaptation.

For example, text-to-speech is a good skill: the skill can teach an agent how to call an `edge-tts` tool
and send back an audio file. But "Milo uses this male Mandarin voice" is a profile preference. It belongs
in memory, not in the shared skill.

In short: notes are how an agent remembers what it learns. Skills are how a stable capability becomes
something another agent can use.

Skills are different from MCP. A skill teaches an agent how to think and act for a workflow. MCP gives
an agent a tool channel to reach an external service or API. They work well together, but they solve
different problems.

## What skills are good for

Use a skill when you want an agent to become better at a repeatable workflow:

- reviewing pull requests in your team's style
- writing changelogs or release notes
- testing a frontend app
- following a design system
- working with a product or API your team uses often

The best skills are specific. "Review React PRs for regressions" is more useful than "be good at
engineering."

## Global skills and this agent's skills

Anima shows skills in two main groups:

- **Global skills** live on the machine and can be used by agents that run there.
- **This agent's skills** live in that agent's home and are only for that agent.

Provider and bundled skills may also appear in the dashboard. Those are usually system or provider
skills. Most operators care most about the global skills they installed and the local skills they gave
to a specific agent.

## Finding new skills

Anima includes a default `find-skills` skill so agents have a clear path for capability discovery. When
you ask for a specialized capability, the agent should search for an existing skill before assuming the
capability is unsupported.

Most teammates never touch skills directly. They talk to the agent in Slack; the person who runs the
agent's machine is the one who reviews and installs skills.

The search uses the open skills ecosystem through the Skills CLI:

```bash
npx skills find <query>
```

For example, if you ask for help with frontend testing, the agent can search for testing skills and show
you the relevant options. If you approve one, it can install it with:

```bash
npx skills add <owner/repo@skill> -g -y
```

The `-g` flag installs the skill globally for the current user on that machine.

## When changes take effect

Provider CLIs discover skills when they start or begin work. A newly installed or edited skill usually
applies to the next task or the next restarted provider session, not to a task already in progress.

If an agent does not seem to pick up a new skill, start a fresh task or restart the agent runtime.

## Third-party skill safety

Skills come from an open, community ecosystem, not from Anima. Anima does not host, curate, or vet them.

Skills can include instructions and supporting scripts. Treat third-party skills like code:

- install only from sources you trust
- read the `SKILL.md` before installing
- review any scripts or executable files that ship with the skill
- avoid installing skills that ask for secrets or broad credentials without a clear reason

Skills make agents more capable, but they should still be visible and reviewable by the person who runs
the machine.
