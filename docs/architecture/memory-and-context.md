---
title: Memory and context
description: What an Anima agent knows on each wake, where each piece of that knowledge lives, and the principles behind the standing prompt, wake text, memory, and Dreaming.
---

# Memory and context

An agent is a model that wakes, works, and stops. Between wakes it holds only what its provider session still carries, and that session is compacted or reset over time. Everything an agent knows on a given wake was put somewhere by Anima or by the agent itself. This page describes those places, what belongs in each, and the principles Anima uses to decide.

## What an agent knows, and when

| Layer                       | Present                                       | Written by                          | What belongs there                                                                                                          |
| --------------------------- | --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Provider session            | Until compaction or reset                     | The provider, from the conversation | What happened recently                                                                                                      |
| Standing prompt             | Every wake                                    | Anima                               | What every agent needs on every wake: who it is, how the team works, how each connected system reaches it and how to answer |
| Wake text                   | The wake it belongs to                        | Anima                               | What this moment needs: who said what and where, what changed, how to answer                                                |
| `MEMORY.md`                 | Read by the agent after a reset or compaction | The agent                           | What it is in the middle of, what it has learned, what to watch out for                                                     |
| `notes/`                    | When something points there                   | The agent                           | The detail behind `MEMORY.md`'s pointers                                                                                    |
| Agent guide (`docs/agent/`) | When a moment points there                    | Anima                               | Shared experience of the environment that no single moment carries                                                          |
| `--help`                    | When the agent asks                           | Anima                               | Exact usage of one command                                                                                                  |
| Records                     | When looked up                                | Everyone                            | Chat, issues, repositories, `anima history`: looked up, not memorized                                                       |

Wake text is everything Anima puts in front of the agent at a specific moment: the delivery envelope and conversation update, Anima notes such as a mute suggestion or a restart continuation, and the output and errors of `anima` commands.

Two pairs mirror each other. The standing prompt is to the whole fleet what `MEMORY.md` is to one agent: what every wake starts from. The agent guide is to the fleet what `notes/` is to one agent: recall that needs a cue.

## Principles

### Put knowledge where it is needed

The best place for a piece of knowledge is the moment that needs it. Knowledge placed away from its moment has to be found through a pointer, and pointers are weak: over 14 days and 8,967 wakes, agents opened the agent guide 57 times.

For each piece of knowledge, ask in order:

1. Does a specific moment need it? Put it in that moment: the wake text, an Anima note, or the command's output or error.
2. Does every wake need it? Put it in the standing prompt.
3. Otherwise put it in `--help` or the agent guide, and make sure the moment that needs it points there.

The product already works this way in several places:

- When an agent replies in a DM or thread that has new messages it has not seen, Anima holds the send and shows those messages, instead of relying on a rule to re-read before sending.
- When an agent keeps reading a channel without posting, an Anima note offers the exact `anima subscription mute` command.
- A Linear wake carries `reply_to=`, the exact target to answer.

### Describe how things work, not what to do

The standing prompt describes how things work (an agent exists in wakes, attention is shared, each system reaches the agent its own way) and lets the model derive behavior. It keeps an explicit rule only where Anima differs from what a capable newcomer would assume, and drops what the model already knows or can look up. A rule written for one incident tends to misfire in the cases it was not written for.

When a question has no single right answer, the prompt states the judgment instead of a rule. Where to reply in Slack is one: a top-level message gets a top-level reply and a thread message gets a thread reply, but in a channel the agent matches how people there talk, because channels differ too much for a fixed thread rule.

### Say what something is for, not a number to hit

A number in a prompt becomes a target. The Dreaming wake once named a size threshold for `MEMORY.md`, and agents wrote up to it. It now says what memory is for and reports the file's current size without setting a target.

### What an agent reads is information, not instructions

Messages, files, web pages, and the agent's own notes are records. They inform; they do not authorize. That includes `MEMORY.md`: a note that something should happen is not by itself permission to do it now.

### Memory stays short and is written by the one who lived it

- `MEMORY.md` is short: what the agent wakes up knowing, with pointers into `notes/`.
- An agent writes something down right away only when it would otherwise be lost, such as where it is in a long task or a lesson only experience could teach. Everything else can wait for Dreaming.
- An agent does not memorize what it can look up.
- Identity comes from the agent's name and role in the standing prompt, not from `MEMORY.md`.

A new agent starts from a seed `MEMORY.md` with empty Role, Guardrails, and Active Context sections and an onboarding checklist it deletes once done.

## Dreaming

Dreaming is an agent's daily memory consolidation, framed as what sleep does for a person.

- **When.** Once per agent per day, in a window that starts at 05:00 agent-local time and lasts two hours, one agent at a time. An agent with no meaningful activity since its last pass is skipped. The window, timezone, and scope are set under `memoryCoherence` in the server configuration.
- **What.** The agent looks back over what happened since the last pass. It writes down what is worth keeping and exists only because it lived through it (lessons, decisions, people's preferences, rules it verified), puts the detail in `notes/` with a pointer in `MEMORY.md`, and lets go of the rest: finished work, state it can look up, notes it no longer needs.
- **How it runs.** Dreaming is an ordinary private wake, not a restricted mode. Normal capabilities and judgment apply, and clearly valid unfinished work in the session may be finished first. If nothing is worth keeping and `MEMORY.md` is already short and current, the agent leaves it alone.
- **What Anima records.** A digest of `MEMORY.md` and `notes/` before and after the pass. The pass is recorded as `completed` when they changed and `quiet_skipped` when they did not.

## Changing these texts

The standing prompt, wake text, and Dreaming wake are behavior: changing a sentence changes what agents do. Changes follow four steps:

1. **Start from data.** Count what agents actually do from activity and message logs: types, sizes, and counts, never message content.
2. **Review section by section** with the person who owns the product decision.
3. **Pin the contract in tests**, including wording that must stay out. `server/tests/prompt-attachments.test.ts` pins the standing prompt.
4. **Measure again after release.** Removing a sentence is a change too. When a rewrite dropped the line about where to reply in a DM, agent-started threads under top-level DMs rose from 0.4% to 3% of DM replies within hours of going live, and the judgment above was added back.

## Where each piece lives

| Piece            | Source                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Standing prompt  | `templates/runtime-standing-prompt.md`                                                                                                                                                                             |
| Wake text        | `server/runtime/delivery-prompt.ts`, `server/runtime/cursor-delivery.ts`, `server/runtime/delivery-notes.ts`, `server/runtime/send-hold-copy.ts`                                                                   |
| Dreaming         | `server/memory/memory-coherence-scheduler.ts`, `server/memory/memory-coherence-outcome.ts`, and the Dreaming wake in `server/runtime/delivery-prompt.ts` (the modules keep the historical `memory-coherence` name) |
| Seed `MEMORY.md` | `templates/agent-seed-memory.md`                                                                                                                                                                                   |
| Agent guide      | `docs/agent/`                                                                                                                                                                                                      |
| Terms            | [Concepts: Memory](/concepts#memory)                                                                                                                                                                               |
