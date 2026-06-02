# Using the dashboard

Most of the time, your team works with an agent in Slack. The dashboard is the other half: a window
for the person who set Anima up. It is where you watch what each agent is doing, check its work after
the fact, step in when you need to, and tune how it runs.

The dashboard runs on your own machine, alongside the rest of Anima. It updates on its own, so you
never refresh. You do not talk to agents here. Think of it as the cockpit, not the conversation.

## Finding your way around

The sidebar lists your agents. Each one carries a small status dot so you can read the room at a
glance:

- **Green**: idle, waiting for something to do.
- **Amber**: working on an item right now.
- **Off**: the agent is disabled. It stays in the list with its config and memory intact, it just
  is not responding.
- **Not connected**: the agent exists but has no Slack workspace linked yet.

Open an agent and you get three views: its **activity**, its **reminders**, and its **profile**. The
address bar follows wherever you are, so you can bookmark or share a link and land back on the same
agent and the same view. (To browse the team's shared files, see
[Your knowledge base](./working-with-your-agent.md). The knowledge base is its own surface.)

<!-- TODO(screenshot): sidebar with a few agents showing different status dots (idle / working / Off). Demo team data only. -->

## Is the agent healthy?

At the top of the activity view, a status line tells you what the agent is doing:

- **Working**, with how long ago the current item started.
- **Queued**, with how many items are waiting.
- **Idle**, when there is nothing in flight.

Next to it, a short note shows the latest thing the agent did, so you can tell a long-running task
from a stuck one without digging.

## What did the agent actually do?

The activity view is where you verify an agent's work. This is its single most useful job: a record
you read **after** the fact to see what happened, not a gate that approves actions before they run.

It has two lenses:

- **Conversation**: the Slack back-and-forth. The messages that woke the agent and what it sent back,
  with an Inbox / Outbox filter when you want one side only.
- **Activity**: the step-by-step trail. The tools the agent called, the files it wrote, the messages
  and reactions it sent, and any errors. Turn on **Failed only** to jump straight to what went wrong,
  or **Show all steps** to see the full, unfiltered sequence.

Entries are grouped by day, and while an agent is working the feed follows along live. A small `↳`
marks a follow-up message when you are looking at the full trail.

::: info One honest caveat
The activity view shows what the agent did through Anima's standard commands. An agent can also call
Slack directly for edge cases, and those direct calls are not recorded here. That is why the standard
commands are preferred for anything you want to be able to review later.
:::

<!-- TODO(screenshot): activity view, Activity lens, showing a few tool steps + one message in/out. Demo data. -->

## Session vitals

The **This session** block on an agent's profile shows how its current working session is doing:

- **Context**: how full the agent's working context is. For Claude this reads as a percentage toward
  the point where it automatically compacts, with the model's full window noted alongside. Providers
  that do not report this show a dash instead of a misleading gauge, rather than guess.
- **Compactions**: how many times the session has compacted so far.
- **Started**, with how long the session has been up.
- **Latest activity**: when the agent last did something.

The profile also records a few lifetime facts: when the agent was **created**, its **owner**, and how
many past sessions have been **archived**.

<!-- TODO(screenshot): the This session block (Context gauge + Compactions + Started + Latest activity). Demo data. -->

## Stepping in

When you need to take the wheel:

- **Stop** halts the item an agent is working on right now. It appears while the agent is busy.
- The **More actions** menu (the `⋯` on an agent) holds the rest:
  - **Disable when idle**: the agent stops after its current item finishes, then sits out until you
    turn it back on. Memory and session are preserved. This is the reversible pause, distinct from
    removing the agent.
  - **Rotate session**: the current item keeps running, but the next item starts with a fresh
    context. The old session is archived. Reach for this when a session has gotten cluttered and you
    want a clean slate without losing history.
  - **Remove agent**: stops the agent and deletes its local Anima config. Its home files (memory,
    notes) are left untouched.

::: tip Restarting does not lose work
When a restart is needed, agents that are mid-task save their place and pick up right where they left
off afterward. Nothing in flight is thrown away.
:::

## Tuning an agent

Everything on the profile is editable in place. The main dials:

- **Name** and **Role**: how the agent is addressed and what it is responsible for. The role is the
  biggest lever on how useful the agent is. (See [Configuring an agent](./configuring-an-agent.md).)
- **Provider**, **model**, and **reasoning effort**: the engine the agent runs on and how hard it
  thinks.
- **Home**: the folder that holds the agent's memory and notes.
- **Owner**: the person responsible for the agent.

Changes are saved as soon as you make them, and the agent applies them the next time it is idle. If it
is mid-item, you will see a note that the change will apply once the current item finishes, so you are
never left guessing. Changing the provider asks you to confirm, then the agent reloads itself.
Switching to a different provider starts a fresh session, but MEMORY.md, notes, and activity history
stay intact.

The **Slack** section shows the workspace and handle the agent posts as. From here you can re-pull the
agent's avatar from Slack with **Sync avatar from Slack**, or open its Slack app settings to change the
icon at the source.

<!-- TODO(screenshot): profile top block (Name / Role / Provider / Home / Owner) with the apply-when-idle notice. Demo data. -->

## Reminders

The reminders view lists an agent's scheduled wakes in two sections:

- **Active**: reminders that are still scheduled, each with its schedule (one-shot, or recurring on an
  interval, daily, or weekly), when it next fires, and when it last fired.
- **Past**: reminders that have fired or been cancelled, with their status.

Expand any reminder to see its instructions, how many times it has fired, and the Slack message it was
anchored to, plus a jump to the activity stream from when it last ran.

<!-- TODO(screenshot): reminders view with an Active and a Past section. Demo data. -->

## In short

The dashboard is for oversight. Day to day you will work with your agents in Slack and glance at the
dashboard when you want to check what happened, adjust how an agent runs, or step in. The more you use
it, the faster you will read an agent's state from a single look at the sidebar.
