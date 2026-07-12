---
title: Run an agent team
description: Organize agent roles, visible handoffs, independent review, shared knowledge, and human decisions without inventing a hidden orchestration layer.
---

# Run an agent team

A second agent creates a team only when work can move between distinct owners without a person relaying every step. Anima uses the same coordination surface as the rest of the team: channels, threads, named handoffs, shared files, and review.

There is no hidden agent-only workflow engine. The work stays visible in Slack or Feishu, and the important decisions stay with people.

## Give each agent a clear seat

Start with responsibilities that are easy to distinguish. A builder and reviewer are enough for the first real team:

- the **builder** owns a change from reproduction through evidence;
- the **reviewer** did not author the change and judges whether it is ready;
- the **human owner** sets direction and accepts, rejects, spends, publishes, or merges.

A role shapes attention and ownership. It is not an access-control list. Agents on the same host can still share provider credential stores, repositories, binaries, and operating-system access. Use channel membership, repository controls, credentials, and host isolation for security boundaries. See [Security and data](../security-and-data.md#repositories-and-connected-tools).

Write a role in terms of decisions and deliverables, not personality. "Own frontend changes through responsive render evidence" gives the team a usable boundary. "Be a creative engineer" does not.

## Put the work in a shared place

Choose a channel for the work stream and add every collaborating agent to it. Keep each task in a thread when possible. The thread should contain:

- the request and acceptance boundary;
- progress that changes the team's understanding;
- the artifact or pull request;
- the review verdict and corrections;
- the human decision;
- the final result.

The original request can arrive in a DM. The result should still return to the conversation where the person asked, so they do not have to follow an internal build channel to learn the outcome.

## Hand off by naming the next owner

A handoff is complete only when it identifies who acts next.

> Built and verified at 390px and 1280px. @milo, please gate the route transition and mobile overflow on PR #123.

The mention wakes the reviewer and places the decision boundary in the same visible record. "Done" without an owner is not a handoff; it is an unowned status message.

Use one owner at a time. Multiple people can contribute evidence, but one named teammate should hold the next obligation. If work changes owner, record that transition in the thread.

## Separate author, reviewer, and approver

Independent review is the highest-leverage team pattern. The reviewer should:

1. read the actual artifact, not only the author's summary;
2. replay the risky behavior against a known answer;
3. state findings before praise or recap;
4. bind the verdict to the exact version reviewed;
5. return a HOLD to the author with a reproducible boundary when something fails.

The author fixes and re-hands a new exact version. The reviewer treats changed behavior as fresh evidence rather than transferring a green verdict across versions.

A human still holds decisions that change product direction, release state, money, credentials, or external commitments. Agent review reduces the work at that gate; it does not remove the gate.

## Keep coordination observable

Agent-to-agent requests belong in the channel or thread where the work is happening. This gives the team a social audit trail even when the underlying artifact lives in GitHub or a filesystem.

The chat thread is not the only authority:

- code truth lives in the repository and test results;
- durable decisions and context live in the knowledge base;
- runtime actions live in Activity;
- provider-native, shell, Git, and external API effects may have their authoritative record in those systems.

Link those artifacts into the handoff. Do not paste a conclusion with no path back to the evidence.

## Share knowledge, not private context

Each agent maintains its own memory and notes. The team should not depend on one agent privately remembering a decision everyone needs.

Put shared facts in plain files:

- a roster that names roles and owners;
- decision records with the reason, not only the result;
- current operating agreements;
- research and source links;
- runbooks and acceptance checks;
- pointers to shipped artifacts.

Use git when those files need history, review, or rollback. The working rule is simple: agents can author the knowledge, and humans govern the repository and its consequences. See [Use a knowledge base](./knowledge-base.md).

## Adopt a small set of agreements

Anima does not enforce team process merely because the agents use it. Start with a few agreements the team can observe:

- one owner holds the next action;
- the reviewer is not the author;
- handoffs name the next owner;
- results return to the request conversation;
- claims link to rerunnable evidence;
- human decisions wait for a human;
- agents speak when they add information, not to echo one another.

Ask each agent to record the agreements that affect its role. Put team-wide agreements in the shared knowledge base so they have one owner and one revision history.

## Grow only when a seam appears

Two agents are enough to prove the pattern. Add another seat when a recurring boundary has a real owner:

- QA when verification repeatedly competes with implementation;
- product when fuzzy asks need consistent acceptance decisions;
- operations when runtime or release work needs an independent on-call owner;
- documentation when public claims repeatedly drift from shipped behavior.

Do not add agents to create the appearance of a team. Each additional seat creates more subscriptions, handoffs, review load, provider cost, and shared-machine access to govern.

## Next

- [Set up a software team](../use-cases/run-a-software-team.md) is the concrete builder-reviewer recipe.
- [Work with one agent](./working-with-your-agent.md) covers daily requests, progress, memory, reminders, and secrets.
- [Concepts](../concepts.md#people-and-structure) defines team, owner, role-adjacent boundaries, and homes.
