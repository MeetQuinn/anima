---
title: Use the dashboard
description: Inspect agent work, manage setup, and operate the local Anima runtime.
---

# Use the dashboard

Your team usually works with agents in Slack or Feishu. The dashboard is the local operator
surface for the person running Anima: use it to inspect work, change setup, manage machine-wide
providers, and recover from problems.

Open [http://127.0.0.1:4174](http://127.0.0.1:4174) on the Anima host. This is a loopback address,
not a hosted Anima service. If you configured another port, use that port instead.

## Read the navigation

The desktop sidebar holds three levels of navigation:

- The team switcher sets the team you are currently working in.
- **Knowledge Base** and **Agents** list the folders and agents registered to that team.
- **Providers** and **Server** open machine-wide operational panels.

Collapse the sidebar when you need more room. On mobile, the same information opens as a full
navigation screen; once you open an agent, a fixed bottom bar switches between its five tabs:
**Activity**, **Channels**, **Profile**, **Files**, and **Reminders**.

Switching teams changes the current working context. It does not hide or move the other teams.
New agents and knowledge bases belong to the selected team. Renaming a team or changing its home
does not move existing agent homes.

## Read agent state

The agent list is a fast summary, not the complete diagnosis:

- A green dot means the agent is healthy and idle.
- An amber dot with a breathing halo means the agent is working.
- A red dot means the agent needs attention.
- A neutral dot can mean starting, retrying, degraded, or unknown. Hover it for the current reason.
- **Off** means the agent is disabled.
- **Not connected** means the agent is enabled but has no Slack or Feishu connection.

Open **Activity** for the authoritative status line, queue depth, health reason, and current run.

## Inspect work in Activity

Activity combines the messages that woke an agent with the work that followed. Expand a step group
to inspect tool calls, file actions, messages, and errors. The current run stays open and follows
new activity while it is running.

Use this page to answer:

- What request is the agent handling?
- Is it running, queued, retrying, or waiting?
- What did it do before replying?
- Where did a run fail?

Activity is a post-hoc Anima record. It is not a complete host audit log and it cannot prove every
effect in a provider, shell, Git remote, or external API. Check the system that owns an external
effect when the distinction matters. See [Security and data](/security-and-data#audit-boundary).

## Review conversations in Channels

**Channels** lists conversations Anima has indexed for the selected agent. Open a channel or DM to
read recent messages, muted state, and thread context without changing the active Slack or Feishu
conversation.

The chat platform remains the authority for membership, retention, delivery, and the full message
history. Use the platform itself when you need to verify those facts.

## Change setup in Profile

The top of **Profile** holds the agent identity: avatar, editable name, editable role, creation time,
last activity, and archived-session count.

The **Setup** ledger then shows the operational configuration:

- **Home**: the folder that owns the agent's memory, notes, and local files.
- **Team**: the current team assignment, including repair when a saved team no longer exists.
- **Provider**: provider, model, and reasoning settings.
- **Launch env**: provider-specific environment values.
- **Owner**: the human responsible for the agent. Ownership is not an access-control boundary.
- **Slack** and **Feishu**: connected identities, setup state, and any manifest or permission work.

Provider changes require confirmation. Moving to another provider starts a fresh provider session,
but the agent's memory, notes, files, and Anima activity remain. Changes made while an agent is busy
take effect at the next safe reload boundary.

**This session** shows the current provider session, including context occupancy when the provider
reports it, compaction information, and start time. The **Skills** region is described in
[Skills](./skills.md).

## Browse the agent home in Files

**Files** is a browser for the agent home. Expand folders, filter the tree, and open Markdown or
text files without leaving the dashboard.

- **Preview** renders Markdown for reading.
- **Code** shows the source, supports wrapping, copying, and links to specific lines with `#L<n>`.
- Relative Markdown links stay inside the file browser when the target is available.

The dashboard reads the same files the agent reads. Editing, versioning, and backup remain ordinary
filesystem concerns.

## Manage Reminders

**Reminders** separates scheduled wakes into **Active** and **Past**.

Active rows show when a reminder will fire and whether it repeats. Expand one to inspect its
instructions. Past initially shows the 12 most recent rows; use **Show all** for the full history.
Expanded past rows can link to the originating conversation when provenance is available and to
the corresponding activity.

## Use lifecycle actions deliberately

The agent action menu controls the local runtime:

- **Stop** interrupts the current work.
- **Disable** prevents new work until you enable the agent again. Its config and files remain.
- **Rotate session** lets current work finish, archives the current provider session, and starts
  future work in a fresh session.
- **Restart agent** force-stops a hung agent. Current work is dropped and is not retried; queued work,
  memory, notes, and config remain. Do not use Restart to solve provider authentication or quota
  failures.
- **Copy diagnostics** copies a support-oriented snapshot of the agent state.
- **Remove agent** stops the agent and removes its local Anima configuration. Its home files remain,
  and Anima does not delete the remote Slack or Feishu app.

Runtime updates use a separate graceful process. See [Update Anima](./updating-anima.md) instead of
using **Restart agent** as an update mechanism.

## Manage provider CLIs

**Providers** combines the state of each machine-wide provider CLI with its usage information.
Each provider row reports facts from their owning source when available:

- the executable Anima resolves, its path, installed version, and installation source
- update status, latest checked version, and whether an in-place update is safely managed
- the provider account label and plan when the provider exposes them
- usage windows and reset times
- agents using that provider and the version each running session currently has

An update changes the shared machine binary. It does not log out, rewrite provider credentials, or
change provider configuration. Existing work keeps running on its current child process; the new
version takes effect as provider sessions restart. Anima offers **Update** only for installation
channels it can verify and update in place. Other rows show a manual command instead of guessing.

Only one provider update runs at a time. Use refresh to check one provider or all providers without
installing anything.

## Inspect the Anima server

**Server** shows the local service health, uptime, Anima version, and resolved Anima home. It also
holds the runtime update control and a server restart action.

Use this panel for machine-level state. Use an agent's Activity and Profile pages for agent-level
state. For service-level commands and paths, see the [Service runbook](/service-runbook).

## Manage knowledge bases

Knowledge bases are team-owned folders registered in the sidebar. Adding one points Anima at an
existing folder or a folder you create in the picker. Removing it only unregisters it; no files are
deleted. Read [Use a knowledge base](./knowledge-base.md) for the full workflow.

## Next steps

- [Work with one agent](./working-with-your-agent.md)
- [Run an agent team](./how-your-agents-work-as-a-team.md)
- [Security and data](/security-and-data)
- [Update Anima](./updating-anima.md)
