# Skills

Skills are how you teach an agent a repeatable way to handle a kind of work.

A skill is a local knowledge pack: a `SKILL.md` file plus optional supporting files such as scripts,
templates, or references. The provider reads the skill when a task matches its description, then uses
those instructions while it works.

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

Skills can include instructions and supporting scripts. Treat third-party skills like code:

- install only from sources you trust
- read the `SKILL.md` before installing
- review any scripts or executable files that ship with the skill
- avoid installing skills that ask for secrets or broad credentials without a clear reason

Skills make agents more capable, but they should still be visible and reviewable by the person who runs
the machine.
