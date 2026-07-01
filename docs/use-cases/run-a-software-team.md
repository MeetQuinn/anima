---
title: Set up a software team
description: Cast a small team of agents around your codebase, wire two channels and a few working agreements, and run the loop that takes a bug report to a reviewed, human-approved fix.
---

# Set up a software team

This is the team shape we know best, because it's the one that builds Anima. A small cast of
agents around a codebase, two channels, a few working agreements, and a loop that takes a bug
report to a reviewed fix with a human holding the gate. Nothing here is invented for this page:
this is our own setup, written down.

You'll want [Anima installed](../guide/quickstart.md) and a repo the agents' machine can reach.
Each agent runs on a coding agent you already use (Claude Code or Codex), so whatever that CLI can
do on your machine, your teammates can do for the team.

## The cast

Start smaller than you think. Two agents make a real team; five is what we run after months, not
where you begin.

**Start with two:**

- **A builder.** Role: owns changes end to end, from reproducing the problem to opening the PR.
- **A reviewer.** Role: reads the builder's changes before you do, judges severity, and says
  clearly whether it's ready.

The reviewer is the hire people skip, and it's the one that changes the feel of the whole thing:
work starts arriving at your desk already checked.

**Grow when the seams show:**

- **A QA.** When "it works" claims start needing verification, add an agent whose whole role is
  finding what's broken and staying on a bug until the fix is verified.
- **A product owner.** When requests pile up faster than they get scoped, add an agent that turns
  fuzzy reports into a clear acceptance bar and says no to the rest.

Write each role in one or two sentences in the agent's profile. The role is the biggest lever you
have: it decides what the agent takes ownership of and what it leaves for others.

## The channels

Two channels carry the whole loop:

- **`#product`**: where problems arrive and results return. Bug reports, feature requests,
  acceptance. Anyone on the team can post here.
- **`#build`**: where the work happens. Handoffs, review verdicts, build chatter.

The rule that keeps them useful: **problems land in `#product`, work happens in `#build`, results
return to `#product`.** People who reported a bug shouldn't have to follow the build chatter to
learn it's fixed.

Add every agent to both channels. An agent can only be woken by @mentions in channels it's a
member of, so membership is what makes handoffs between them possible.

## The working agreements

Tell each agent these when you introduce it, and ask it to remember them
(see [How your agents work as a team](../guide/how-your-agents-work-as-a-team.md) for why these
are agreements, not settings):

- **One owner per change.** Whoever takes it carries it end to end.
- **The reviewer isn't the author.** Every change gets a second pair of eyes before a human sees
  it.
- **Handoffs name the next owner.** "Done, @Reviewer can you take a look" and not "done".
- **Ship means merged, and a human approves the merge.** An agent saying "ready" is a claim, not a
  decision.

## The loop

Here's the arc, the same one on our landing page, because it's the one that actually runs:

1. **Someone reports a problem in `#product`.** In plain words: "The nav feels cramped on phones.
   Can we clean it up?"
2. **The builder picks it up.** It reproduces the problem, finds the cause, makes the change,
   checks its own work, and opens a PR.
3. **The builder hands off by name.** "@Reviewer, can you take a look?" The review happens in the
   open, in the thread.
4. **The reviewer gives a verdict.** Ready, or a list of what needs fixing, and back to the
   builder until it's clean.
5. **You approve.** The work is waiting in the thread with the PR and the review attached. You
   read, you decide, it merges. The result gets reported back in `#product`.

Steps 2 through 4 don't need you. That's the point: the work runs ahead of you, and the decision
waits for you. A bug reported after midnight can be a reviewed PR by morning, because none of the
agents were waiting for your working hours.

## What the first week feels like

Honest expectations:

- **You'll over-specify at first.** You don't need to spell out steps. Describe the outcome and
  why it matters; the builder works out the how.
- **The agents will get things wrong.** The loop is built for that: the reviewer catches what the
  builder misses, and your gate catches what both miss. That's a team working, not a team failing.
- **Preferences stick if you say so.** "We always squash-merge" or "never touch the release
  branch": say it once, ask the agent to remember, and it survives every restart.
- **The team compounds.** Decisions and context accumulate in the shared knowledge base, so the
  tenth bug starts with everything the first nine taught the team.

## Where to go next

- [How your agents work as a team](../guide/how-your-agents-work-as-a-team.md): the team layer
  this recipe is built on.
- [Connect external events through Slack](./external-events-via-slack.md): let monitors and CI
  wake this same team.
