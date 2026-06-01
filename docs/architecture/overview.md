# Architecture overview

Anima's architecture starts with one agent and one loop:

**Slack message -> agent inbox -> one agent turn -> agent outbox -> Slack reply.**

That loop is why Anima feels like a teammate in Slack instead of a private terminal session. The
agent has a durable Slack identity, a continuous working context, and a clear boundary for what it
receives and what it sends.

## The shape

<div class="architecture-map" aria-label="Your team works in Slack, Anima runs on one machine you control, and the provider runs AI work under your account.">
  <div class="architecture-card architecture-card-slack">
    <span>Shared surface</span>
    <strong>Your team in Slack</strong>
    <p>Channels, DMs, and threads where people talk to the agent and see its replies.</p>
  </div>
  <div class="architecture-flow" aria-hidden="true">
    <span>messages in</span>
    <strong>↓</strong>
    <span>replies out</span>
  </div>
  <div class="architecture-card architecture-card-anima">
    <span>Local runtime</span>
    <strong>Anima on one machine</strong>
    <p>Slack connection, agent inbox, agent outbox, durable state, and local activity trail.</p>
  </div>
  <div class="architecture-flow" aria-hidden="true">
    <span>agent turn</span>
    <strong>↓</strong>
    <span>result</span>
  </div>
  <div class="architecture-card architecture-card-provider">
    <span>AI engine</span>
    <strong>Your provider account</strong>
    <p>Claude Code, Codex, Kimi, or another supported provider runs the work.</p>
  </div>
</div>

One machine runs Anima for the team. Slack stays the shared surface. The provider does the AI work
under your account. Anima is the local layer between them.

## The one-agent loop

<div class="agent-loop-diagram" aria-label="A Slack message goes into the agent inbox, the agent runs one turn through the provider, then the agent outbox sends the result back to Slack.">
  <div class="agent-loop-node agent-loop-slack">
    <strong>Slack</strong>
    <span>DM, mention, or followed thread</span>
  </div>
  <div class="agent-loop-arrow" aria-hidden="true">↓</div>
  <div class="agent-loop-node agent-loop-inbox">
    <strong>Agent inbox</strong>
    <span>What reached the agent, where it came from, and why it wakes up</span>
  </div>
  <div class="agent-loop-arrow" aria-hidden="true">↓</div>
  <div class="agent-loop-node agent-loop-turn">
    <strong>One agent turn</strong>
    <span>The provider runs the work under your account</span>
  </div>
  <div class="agent-loop-arrow" aria-hidden="true">↓</div>
  <div class="agent-loop-node agent-loop-outbox">
    <strong>Agent outbox</strong>
    <span>Messages, files, reactions, and asks the agent sends through Anima</span>
  </div>
  <div class="agent-loop-arrow" aria-hidden="true">↓</div>
  <div class="agent-loop-node agent-loop-slack">
    <strong>Slack</strong>
    <span>The result returns to the same DM, channel, or thread</span>
  </div>
</div>

The useful mental model is simple:

- **Inbox** is what the agent receives. It includes the Slack message, who sent it, where it came
  from, and the reason Anima is waking the agent.
- **One agent turn** is the work. The agent reads the inbox item with its existing context and uses
  the coding tool you connected, such as Claude Code, Codex, or Kimi.
- **Outbox** is what reaches the team. A reply, file, reaction, or question is not visible until it
  goes out through Anima.

The dashboard's activity view is built from this boundary: what came in, what the agent did through
Anima, and what went back out.

## Where it runs

Anima runs on one machine you control. That machine keeps the local runtime, the agent's durable
state, and the local activity trail. Your teammates do not each install Anima. They work with the
agent from Slack.

```text
Your machine
  Anima runtime
  Agent state
  Local activity trail

Your team
  Slack channels, DMs, and threads

Your provider account
  Claude Code, Codex, Kimi, or another supported provider
```

This split matters. Slack is where people talk and see the results. The provider is the coding agent
you connect, such as Claude Code, Codex, or Kimi; it runs the AI work under your account. Anima is the
local teammate layer that connects Slack and the provider, keeps the agent continuous, and records the
Anima-mediated work for review.

The agent state on your machine is the part that makes the agent durable: its configuration, local
history, sessions, preferences, and activity trail.

## How a message reaches the agent

Anima stays connected to Slack for each agent's Slack app. When a Slack event arrives, Anima decides
whether it belongs in that agent's inbox.

A message reaches the agent when:

- it is a DM to the agent;
- it @mentions the agent;
- it appears in a channel or thread the agent follows and has not muted.

An agent follows a thread after it is @mentioned there, or after it has already replied there. It keeps
following that thread until it mutes it; there is no short time window you need to beat.

If the message qualifies, Anima records an inbox item and wakes the agent. If it does not qualify,
the agent is not asked to spend a turn on it.

This is how Anima can feel present in Slack without requiring the agent to speak all the time. It can
receive context broadly, then choose when to act.

## What happens during one turn

An agent turn is one pass through the connected coding agent. Anima hands over the inbox item with the
agent's existing session context. The provider does the AI work under your account, then the agent
decides whether to send something back through Anima.

During the turn, the agent can:

- read the message and the surrounding delivery context;
- use its continuous session context;
- call Anima tools, the Slack-facing actions Anima exposes, when it needs to reply, react, send a file,
  or ask for a decision;
- use other configured tools when the agent's role and provider support them.

Some turns are quick replies. Others take longer because the provider is reading files, running tasks,
or preparing a larger answer. The important boundary stays the same: the work is not visible to your
team until the agent sends an outbox action.

Plain text the agent produces internally is not a Slack reply. The team only sees an action when the
agent sends it through the outbox.

## How the outbox keeps the boundary clear

The outbox is the agent's outward boundary. It is where the agent turns private work into visible team
actions.

Outbox actions include:

- posting a message back to the same Slack DM, channel, or thread;
- sending a file;
- adding a reaction;
- asking a bounded question in Slack, such as approve or reject.

Those Anima-mediated actions are recorded to the local activity trail, along with runtime events. The
point is reviewability: you can see what the agent received and what it sent through Anima without
watching every internal step.

## Data boundaries

Anima does not add an Anima cloud to the loop.

- **Slack remains your team's conversation system.** Messages and replies are still Slack messages.
- **The AI work runs through the provider account you connect.** That provider sees the turns it is
  asked to run.
- **Anima state stays on the machine running Anima.** Agent state, local config, logs, and the
  activity trail live in the selected Anima home on that machine.

That means local control does not remove Slack or provider egress. Slack and the provider are real
parts of the loop. The promise is that Anima itself is not a hosted service in the middle.

## What to remember

- One controlled machine runs Anima for the team.
- Slack is the shared surface.
- The inbox decides what reaches the agent.
- One provider turn does the work.
- The outbox is the only way work becomes visible to the team.
- The local activity trail lets you review the work that went through Anima.
