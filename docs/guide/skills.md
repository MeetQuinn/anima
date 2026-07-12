---
title: Use skills
description: Package stable, repeatable capability for one agent or a shared provider environment.
---

# Use skills

A skill is a `SKILL.md` file with optional scripts, templates, and reference material. It gives a
provider a repeatable procedure for a class of work.

A skill is not memory and it is not MCP:

- **Memory, notes, and knowledge bases** preserve context and facts.
- **Skills** package instructions for a repeatable capability.
- **MCP servers and other tools** provide channels to external systems.

These layers can work together, but they have different owners and trust boundaries.

## Decide whether the procedure is ready

Most new knowledge should begin in notes or a knowledge base. Turn it into a skill only after the
workflow is stable enough to reuse.

Ask two questions:

1. Is this a fact or preference this team needs to remember? Keep it in memory, notes, or the
   knowledge base.
2. Is this a procedure another agent could follow without inheriting private people, paths,
   credentials, or identity? It may be ready for a skill.

For example, a procedure for rendering and visually checking a PDF can be a skill. A particular
teammate's preferred voice or a private customer path belongs in durable context instead.

## Inspect skills in Profile

Open an agent, then open **Profile** and scroll to **Skills**. The dashboard shows the exact skills
Anima found for that agent and provider.

The ledger has two groups:

- **This agent** comes first. These skills live under the agent home and express agent-specific
  capability.
- **Shared** contains skills exposed by the host user's provider environment.

When a provider has several sources, the shared group is divided into source rows such as
**Common**, **Claude Code**, **Codex**, **Built-in**, or **Bundled**. Large built-in and bundled
groups start collapsed. The source names and paths come from the directories Anima actually scans;
they are not a promise that every provider loads the same roots.

Expand a skill row to read its full description and source path. If the skill is inside the agent
home, **Open in Files** opens its `SKILL.md` in the agent file browser.

An empty **This agent** group shows the path where an agent-local skill would live.

## Choose agent-local or shared placement

Use an agent-local skill when the capability belongs to one agent's role or depends on files in that
agent home. Keep it with the agent so its ownership is visible and portable with that home.

Use a shared provider skill when multiple agents on the same host should load the same capability.
Shared here means the host user's provider environment, not every provider and not every machine.
Claude Code, Codex, Kimi, and future providers may use different roots and plugin systems.

The dashboard is the source-checked inventory for one agent. If a skill is absent there, do not
assume a directory that another provider uses is active for this one.

## Find and install a skill

Anima installs a default `find-skills` capability so an agent can search before declaring a
specialized task unsupported. You can also search directly with the Skills CLI:

```bash
npx skills find <query>
```

Review the result and its source before installation. A global install for the current host user is:

```bash
npx skills add <owner/repo@skill> -g -y
```

The `-g` flag requests a shared user-level install. The provider still decides which directories it
loads. After installation, verify the target agent's **Skills** ledger instead of assuming the
command made the skill active everywhere.

For an agent-local skill, place the skill under the agent-specific path shown by the empty
**This agent** group, using the layout expected by that provider.

## Write a useful skill

A good `SKILL.md` makes its trigger and procedure explicit:

- name the tasks it should handle
- state prerequisites and external tools
- separate required steps from judgment calls
- name the artifacts and evidence it must produce
- include stop conditions for missing credentials, unsafe changes, or unverifiable results
- keep private team facts out of a portable skill

Keep supporting scripts narrow and inspectable. A skill should remove repeated ambiguity, not hide a
large application behind instructions.

## Know when changes apply

Providers discover skills at provider-defined boundaries. A new or edited skill usually affects a
future task or a fresh provider session, not work already in progress.

After a change:

1. Refresh or reopen the agent Profile and confirm the skill appears at the expected source path.
2. Start a new task that should match the skill description.
3. If the existing provider session does not discover it, use **Rotate session** so future work
   starts fresh. Do not use a force restart for ordinary skill discovery.

## Review third-party skills as code

Skills come from provider, plugin, and community ecosystems. Anima displays them; it does not host,
curate, or vet the ecosystem.

Before installation:

- read `SKILL.md`
- inspect scripts and executable files
- verify the publisher and repository
- reject unexplained requests for secrets or broad credentials
- check what external systems and paths the skill can reach

A skill executes inside the provider and host boundaries available to the agent. It is not a
sandbox. See [Security and data](/security-and-data) before adding a skill that handles credentials
or destructive operations.

## Next steps

- [Use a knowledge base](./knowledge-base.md)
- [Work with one agent](./working-with-your-agent.md)
- [Use the dashboard](./using-the-dashboard.md)
