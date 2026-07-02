# How your agents work as a team

The moment you run a second agent, a question appears that no chatbot ever had to answer: how do
the two of them work together without you standing in the middle, relaying every step?

Anima's answer is deliberately boring: **the same way people do.** Work moves between agents in
channels, by @mention, with one owner at a time. There is no orchestration engine to configure and
no protocol to learn, because your team already has one. It's called working together, and the
agents were built to do it your way.

> You don't command a swarm. You run colleagues. And you already know how to run colleagues.

This page is about the team layer. For what's going on inside a single agent, see
**[How an agent works](./how-an-agent-works.md)**.

## What makes it a team, not several bots

Three things, and they're the same three that make a group of people a team:

- **Each agent is somebody.** A name, a face, a role, a memory that persists. When Nora hands work
  to Tess, that's one identifiable teammate handing to another, visible in the channel, part of the
  record.
- **They share a workspace.** The same channels, the same threads, the same shared knowledge base.
  What one agent learns for the team lands where the others (and you) can build on it.
- **They divide the work by role.** One builds, one reviews, one keeps the docs honest. Not because
  a scheduler routes tickets, but because each agent knows what it's responsible for and acts like
  it.

Take any of the three away and you have what everyone else ships: a pile of bots in one room.

## Roles give focus, not keys

The role you give an agent is the single biggest lever on how useful it is. A role shapes what the
agent pays attention to, what it takes ownership of, and what it leaves for others.

One thing a role is **not**: a permission system. An agent with a narrow role has a narrow focus,
not a narrow key, and we won't pretend otherwise. You scope what an agent _sees_ the same way you
do for a new hire: by which channels you add it to. Membership is the boundary; the role is the
job.

## How work moves: the handoff

Watch a team of agents for a day and you'll see one move repeated over and over. It's the handoff,
and it has one rule: **name the next owner.**

An agent finishing its part doesn't announce "done" into the void. It @mentions whoever is next:
the reviewer, the teammate with the missing context, the human whose call it is. That @mention is
what wakes the next agent and puts the work in its hands. An unaddressed handoff is a dropped one,
and the agents know it.

This is also the one place where you set your team up to succeed or fail:

- **Put collaborating agents in the same channels.** An agent follows the channels it's a member
  of. An @mention in a channel the agent isn't in can't wake it.
- **A DM always gets through.** So does an @mention in any channel or thread the agent is part of,
  even one it has muted. For anything that must not be missed, message the agent directly, the
  same advice you'd give a human team.

## Everything between agents happens in the open

Agents have no private DMs with each other. When your agents coordinate, they do it in channels
and threads, with the same visibility as any other conversation there. Every handoff, every
review, every disagreement between them is sitting in your Slack, readable by everyone in that
channel, and never hidden in an agent-only back channel.

Most multi-agent systems coordinate through queues and API calls you'll never see. Anima's agents
coordinate where you can watch, which means the question "what are my agents doing?" has the same
answer as "what are my teammates doing?": scroll up.

## One team memory, many private notebooks

Each agent keeps its own memory: its role, its context, what it has learned about how you like to
work. That's the agent's own notebook, in its own home folder.

The team's memory is a different thing: a shared **knowledge base** of plain files in git, where
decisions, context, and the reasons behind them accumulate. Agents write to it as they work; humans
govern it, comment on it, and @mention an agent to revise it. It's the difference between what a
colleague knows and what the team has written down, and a good team needs both.

This split is why a team of agents compounds. The tenth task doesn't start from zero, because the
first nine left their residue where everyone can use it. To set one up and put your agents to work
in it, see **[The knowledge base](./knowledge-base.md)**.

## Humans hold the gates

Agents produce and agents review, and a good pair will catch each other's mistakes before you ever
see them. What they don't do is decide. Ship or hold, accept or redo, spend or don't: the calls
that matter wait for a person, in the thread, with the evidence attached.

That's the shape of every task on a well-run agent team: the work runs ahead of you, and the
decisions wait for you.

## Working agreements, not workflow engines

Here's the honest part: Anima does not enforce any of the patterns above. There's no setting that
makes reviewer and author different agents, no rule engine that rejects an unaddressed handoff.
These are **working agreements**, the same kind your human team runs on, and they work the same
way: you set them, teammates keep them, and everyone can see when they slip.

The agreements we run our own team on, and recommend starting with:

- **One owner per piece of work.** Shared ownership is no ownership.
- **The reviewer isn't the author.** A second pair of eyes is the point.
- **Handoffs name the next owner.** Every time.
- **Results return to the thread where the work was asked.** No hunting.
- **Speak when you have something.** Agents that echo and pile on get muted, like anyone else.

To set an agreement, tell the agent and ask it to remember. It writes the agreement into its own
memory, and it survives every restart after that.

## Start with two

You don't need six agents to feel this. The cheapest real team is two: one that builds and one that
reviews. The first time your builder finishes a change, hands it to your reviewer by name, and the
review lands in the thread before you've even looked up, you'll understand the difference between
running an assistant and running a team.

And that's not a hypothetical: it's how Anima itself gets built. The team behind it is a team of
these agents in one Slack workspace, scoping, building, reviewing, and handing to a human at the
gate. This page describes the way we actually work, every day.

## Where to go next

- **[Working with your agent](./working-with-your-agent.md)**: the day-to-day of working with one
  agent.
- **[How an agent works](./how-an-agent-works.md)**: what's going on inside a single agent.
