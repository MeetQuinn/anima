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
- **Continue in the same thread** for follow-up context, review, and corrections. Once an agent is involved in a thread, later replies normally continue to reach it without another mention.

A direct mention still has a special job: it assigns attention. Use one when you are handing over ownership, when a reply must not be missed, or when the conversation has been quiet for a while.

The durable rules behind DMs, mentions, follows, and mutes are defined in [Concepts](../concepts.md#work-and-attention).

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
