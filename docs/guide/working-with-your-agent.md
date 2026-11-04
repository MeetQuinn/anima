---
title: Work with one agent
description: Hand over work, follow progress, make decisions, and keep useful context durable when working with an Anima agent.
---

# Work with one agent

An Anima agent is a durable teammate in Slack or Feishu. You give it work in the conversation where the work belongs, it uses the provider and tools available on its machine, and it reports back through an explicit chat action.

You do not need a prompt language. The useful skill is the same one you use with a capable colleague: state the outcome, explain why it matters, name the important boundaries, and stay available for decisions.

## Choose the right conversation

Use the surface that matches the work:

- **DM the agent** for a direct request or private context. A DM reaches it for certain.
- **Mention the agent in a channel** when the work belongs to that group. The agent must be a member of the channel.
- **Continue in the same thread** for follow-up context, review, and corrections. Once an agent is involved in a thread, later human or bot/app replies normally continue to reach it without another mention while that follow is unmuted. Agent-authored handoffs still need to mention their next owner because the follow may not exist or may be muted.

A direct mention still has a special job: it assigns attention. Use one when you are handing over ownership, when a reply must not be missed, or when the conversation has been quiet for a while.

The durable rules behind DMs, mentions, follows, and mutes are defined in [Concepts](../concepts.md#work-and-attention).

## Do-not-contact list

Agents on this host connected to this workspace will not DM or @mention these people. Channel messages are unaffected.

Here, “unaffected” means channel messages without a mention of a listed person; mentions in channel threads are refused too. Group DMs are refused if any member is listed. The rule covers `anima message send`, `anima message update`, `anima ask` (including its generated mention), and `anima file send` (including its caption). Literal mention tokens inside code do not count as mentions.

Each Linear workspace has its own list too. In Linear, agents will not @mention a listed person, by `@displayName` or profile URL, or assign, delegate or subscribe them. The rule covers `anima linear reply` (session replies and comments), `anima linear start`, and every write sent through `anima linear api`. An API write is refused when its document or variables contain the person's user ID, profile URL or `@displayName`, which covers `assigneeId`, `delegateId`, `subscriberIds` and mention nodes in `bodyData`. Reads are unaffected. So are comments and replies without a mention, including answers in a session or thread the listed person opened, and Anima's own acknowledgements and final notices. Mention text in a reply's code spans or fenced code blocks does not count; in an API write it does.

Open **Settings > Outreach limits** in the dashboard. The page groups the lists by
platform and states what each one blocks. Each connected Slack workspace, and each
Linear workspace an agent on this host is connected to, has its own list. Choose
**+** (Add a person) on that workspace's list, search by name or `@username`, and
confirm with **Add member**. Check the member ID before confirming, especially for
duplicate names. Removal also asks for confirmation because it lifts the restriction.

Anima reads the directory on the server. For Slack, it selects a configured
connection in that workspace and verifies its token's workspace first. For Linear,
it uses a connected agent's Linear token and verifies its organization first; the
search lists people only, not apps or agents, and never shows email addresses.
Tokens stay on the server. This lookup does not send messages or wake an agent. If
the directory is unavailable, saved IDs remain visible and restricted; use **Retry
lookup** after repairing the connection. A disconnected workspace's saved list
remains available for removal.

Changes take effect on the next Anima tool operation without a restart. The list
applies to every agent in this Anima instance connected to that workspace, not just
the agent currently selected in the sidebar. It does not block incoming messages.

Alternatively, edit the root `config.json` in your `ANIMA_HOME` (normally `~/.anima/config.json`), preserving its other settings:

```json
{
  "doNotContact": {
    "T0123ABC": ["U0AAAA", "U0BBBB"]
  }
}
```

Use the Slack workspace ID (`T…`), not an Anima team ID. You can find it in the sending agent's configured Slack connection (`slack.teamId`). In Slack, open the person's profile, choose **More**, then **Copy member ID** to get their `U…` ID. Every agent in that workspace on this host uses the same entry. Deleting an agent does not remove the entry.

For Linear, use `linearDoNotContact` with the Linear organization ID and user IDs (both UUIDs):

```json
{
  "linearDoNotContact": {
    "1b2c3d4e-0000-4000-8000-00000000000a": [
      "5f6a7b8c-0000-4000-8000-00000000000b"
    ]
  }
}
```

The dashboard is the simplest way to find Linear IDs. An agent can also read them through `anima linear api` with `query { organization { id } users { nodes { id name displayName } } }`.

Save valid JSON to a temporary file beside `config.json`, preserve the original file permissions, and atomically replace the original (for example, with `mv` after checking the temporary file). The next tool send reads the updated policy; no agent restart is needed. Removing an ID permits contact again. An absent key or empty workspace list applies no contact restriction. Invalid or unreadable configuration refuses Slack sends and Linear writes; repair the configuration before retrying.

A refusal exits with status 1, explains who requested no contact and what the agent should do, and appears in Activity as **Send refused: do-not-contact list** (`anima.do_not_contact`, not retryable). A recipient or group membership lookup failure also holds the send when the workspace list is non-empty, but reports it separately: `anima.contact_unverified` (retryable) names the channel ID and Slack error, says it is not a do-not-contact match, and appears in Activity as **Send held: recipient could not be verified**. A mistyped or truncated channel ID is the usual cause. An invalid policy file reports `anima.contact_policy_config`.

Linear refusals use the same codes and Activity rows. A write that contains a listed user ID is refused without a lookup. For mention text, Anima looks up the listed people's `@displayName` and profile URL with the agent's own Linear token; if that lookup fails, `anima.contact_unverified` holds only writes that could contain a mention (an `@` or a profile link) and says it is not a do-not-contact match. An organization with no list makes no extra Linear call.

This is an Anima tool-layer constraint, not a security sandbox. List management
is an operator dashboard feature, not an agent tool. Its endpoints use the
dashboard's existing authentication setting; adding this UI does not introduce
operator-only process isolation. Same-user shell access can still read or alter
the file, and a directly used Slack or Linear token (for example from `anima linear token`) can bypass Anima's tools. The file is
local to this host; operators must configure every host separately. Feishu is not
covered.

## Hand over an outcome

A good request gives the agent enough information to exercise judgment:

1. **Outcome.** What should be true when the work is done?
2. **Reason.** Why does the result matter, and who is it for?
3. **Boundaries.** What must not change, which systems are in scope, and which decisions belong to you?
4. **Evidence.** What should the agent run, inspect, render, or return so the result can be checked?

For example:

> @milo The mobile file list is hard to scan. Rework the list page without changing desktop behavior. Show me 390px before and after renders, and keep the file data contract unchanged.

That is more useful than a long list of implementation steps. The agent owns the route from the request to the evidence. You own the product decision and any boundary only a person can authorize.

## Read progress as evidence

For a small task, the agent may work silently and return the result. For longer work, expect a brief start notice, updates at real milestones or blockers, and a final handoff.

Useful updates answer one of four questions:

- What fact did the agent establish?
- What changed?
- What is blocked?
- What decision is needed from a person?

An agent can send a bounded **ask** when it needs one choice from a short list. Answering the ask resumes the work. Open-ended discussion stays in the conversation instead.

Plain provider output is not a message to the team. A reply exists only when the agent sends a message, file, reaction, or ask through Anima. This is why the Activity view can distinguish an internal step from an outward action.

## Correct the work in place

When something is wrong, reply where the evidence lives:

- quote the failed claim or point at the affected file;
- name the behavior you expected;
- mention the agent responsible for the next move;
- ask for the proof that would make the correction credible.

The agent keeps the conversation context and can revise without a new briefing. For code and document work, a second agent should review the result before you accept it. The team pattern is covered in [Run an agent team](./how-your-agents-work-as-a-team.md).

## Make durable context explicit

Not every message should become memory. Tell the agent when a fact needs to survive:

- **A personal operating preference** belongs in the agent's maintained memory. Say, "Remember that release changes always need a canary replay."
- **Long-lived detail for one agent** belongs in notes under its agent home.
- **A decision or artifact the whole team needs** belongs in a shared [knowledge base](./knowledge-base.md) or repository.
- **A repeatable portable workflow** may be ready to become a [skill](./skills.md).

The agent's provider context can compact or be replaced. Maintained memory and files survive that boundary. Asking an agent to remember something means it should write the fact into the appropriate durable layer, not merely acknowledge the message.

## Ask for later work

An agent can persist a reminder for a later or recurring wake. Requests such as "check this after the deploy," "follow up Friday," or "run this every weekday morning" should become reminders rather than promises held only in the current conversation.

A reminder wakes the agent privately. It does not post by itself. When it fires, the agent re-evaluates the instruction in current context and takes any outward action explicitly. You can inspect active and past reminders in the dashboard.

## Transfer a secret without pasting it

Do not paste API keys or other secrets into Slack or Feishu. Ask the receiving agent to create a sealed handoff. It sends a one-time link; you enter the value on `handoff.meetanima.online`; the page encrypts it in your browser; and you return the complete encrypted block to the same conversation.

The receiving agent chooses the destination key only when it accepts the block. The one-time private key stays on its machine and is destroyed after a successful acceptance. The link and ciphertext do not transfer provider login state, Slack or Feishu credentials, or other Anima-managed credentials.

The protocol and CLI commands are documented in [Transfer a secret](../agent/reference.md#transfer-a-secret). The broader credential boundaries are in [Security and data](../security-and-data.md#credentials-and-secret-handling).

## Use the dashboard for oversight

Conversation is where you work with an agent. The dashboard is where you inspect and operate it.

Open the dashboard when you need to:

- see whether work is running, queued, retrying, or unhealthy;
- inspect the Activity trail after a task;
- review the channels the agent can see;
- change its role, provider, team, owner, or transport setup;
- browse its files, skills, and reminders;
- stop current work, rotate a session, copy diagnostics, or perform recovery.

See [Use the dashboard](./using-the-dashboard.md) for the current surface and the consequences of each lifecycle action.

## Next

- [Run an agent team](./how-your-agents-work-as-a-team.md) adds visible handoffs, independent review, and human gates.
- [Set up a software team](../use-cases/run-a-software-team.md) turns those agreements into a concrete builder-reviewer loop.
- [Architecture overview](../architecture/overview.md) explains the runtime path behind a message and a turn.
