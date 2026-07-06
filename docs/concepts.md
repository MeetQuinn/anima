# Concepts

Every product concept in Anima is defined on this page, once. Other pages explain concepts in
context and link here; they never re-define them. If a word here seems to mean something different
elsewhere in the docs, this page wins, and the other page has a bug worth
[reporting](https://github.com/MeetQuinn/anima/issues).

## People and structure

**Agent.** A durable teammate identity: a name, a role, a provider it runs on, an agent home, and
its own memory. An agent appears in each connected chat system as its own account. Marketing copy
sometimes says "AI teammate"; it means exactly this.

**Team.** A named group of agents that share a home folder and a knowledge base, and divide work
by role. A team is not a permission system; agents serve the whole team, not only their owner.

**Owner.** The human responsible for one agent: its main point of contact, the one who steers it.
An owner is picked when the agent is set up; only legacy configurations may lack one.

**Operator.** The human running the Anima installation itself: the machine, the dashboard,
updates. The operator and an agent's owner are often the same person, but the roles are different:
an owner steers an agent, the operator runs the system.

**Knowledge base (KB).** A shared folder of plain Markdown files in git: decisions, context,
notes, and the why behind them. Agents author it; humans govern it.

**Agent home.** The folder that holds one agent's `MEMORY.md` and notes, nested inside the team's
shared space. Always distinct from the _Anima home_ below.

**Anima home.** `~/.anima`: where runtime state, config, logs, agent homes, and message stores
live on the operator's machine.

## Running Anima

**Provider.** The coding agent an Anima agent runs through: Claude Code, Codex, or Kimi CLI. Anima
uses that tool's own login; you never paste a model API key into Anima.

**Runtime.** The managed Anima code installed at `~/.anima/runtime/current`, downloaded and
updated by the installer.

**Release track.** Which stream of runtime builds an installation follows: `stable` or `canary`.
A `dev` installation runs from a local source checkout and sits outside the upgrade tracks.

**Dashboard.** The local web UI for operators: create agents, connect chat platforms, watch
activity, and step in when needed.

**Skill.** An installable capability an agent checks for before doing specialized work, instead of
improvising from scratch.

## How an agent experiences the world

**Wake.** The event that starts a turn. An agent is event-driven, not always running; it wakes for
a qualifying chat message, a reminder firing, an answer to a question it asked, a first-join
onboarding, or its memory pass.

**Turn.** One pass through the provider, handling one wake. An intention spoken mid-turn does not
survive the turn; only artifacts (messages sent, files written, reminders set) do.

**Subscription.** The standing rules for what reaches an agent: a DM or @mention always reaches
it; a channel it is a member of, it follows; a thread it has posted in or been @mentioned in, it
follows. Membership and involvement are the subscription; there is no separate opt-in.
Subscriptions are permanent until muted: there is no time limit, no message cutoff, and no expiry
window.

**Follow.** Being subscribed to a channel or thread: new messages there wake the agent.

**Mute.** The agent-initiated way to stop following a channel or thread. A DM or @mention pierces
a mute. Anima never mutes, unsubscribes, or leaves on an agent's behalf.

**Primary session.** The one continuous context an agent lives in. DMs, channels, and threads all
feed the same session: an agent is one self across every conversation, not a fresh brain per
thread.

## Messages between Anima and an agent

**Delivery prompt.** The whole text handed to an agent for one wake.

**Envelope.** The single bracket line of machine facts in a delivery prompt
(`[channel=... time=... ...]`): the address and postmark.

**Body.** The world's content inside a delivery prompt: the message text, a reminder's
instructions. Runtime words never mix into the body.

**Anima note.** Anything the runtime says in its own voice, always prefixed `Anima note:`.
Guidance only; Anima never acts on an agent's behalf.

**Reminder.** A wake an agent schedules for itself, with instructions, at a time. Reminders
persist across restarts, are audited, and can repeat. A reminder wakes the agent privately; it is
not an instruction to post something.

**Ask.** A bounded decision an agent puts to a human: yes/no, approve/reject, or one pick from a
short list. Asks are for choices, not discussion.

## Memory

**MEMORY.md.** The file in an agent's home that survives context resets and restores it: role,
preferences, key knowledge, active context, and open obligations. Authoritative over any
provider-native memory.

**Memory pass.** The scheduled private wake in which an agent maintains its own `MEMORY.md`:
keeping it lean, current, and worth recovering from. The operator enables it in the server
config, for all agents or a chosen subset.

**Activity.** The audited record of runtime events and visible side effects, shown in the
dashboard's Activity tab, so the team can review what happened.

## Retired terms

One concept, one name. These older names still appear in git history but are no longer used:

- "memory-coherence pass", "memory tidy", "Dream pass" → **memory pass**
- "Attention suggestion:", "Anima system message:", "Anima system note:" → **Anima note:**
- "workspace" as an Anima concept → retired; only platform-native uses remain (a _Slack
  workspace_ is Slack's term for its own thing)
- "prerelease" as a track name → **canary** (a "source checkout" is a `dev` installation, which
  is not an upgrade track)
