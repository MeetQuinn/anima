# Using the dashboard

Most of the time, your team works with an agent in Slack. The dashboard is the other half: a window
for the person who set Anima up. It is where you watch what each agent is doing, check its work after
the fact, step in when you need to, and tune how it runs.

The dashboard runs on your own machine, alongside the rest of Anima. It updates on its own, so you
never refresh. You do not talk to agents here. Think of it as the cockpit, not the conversation.

## Opening the dashboard

On a local desktop, Anima opens the dashboard for you when it starts. To open it yourself at any time,
visit **http://127.0.0.1:4174**. That is the default address. If you changed the dashboard port in
your config, use the port you set.

If you are setting Anima up for the first time, the [Quickstart](./quickstart.md) walks through the
whole flow, including connecting Slack.

## Finding your way around

The sidebar lists your agents. Each one carries a small status dot so you can read the room at a
glance:

- **Green**: idle, waiting for something to do.
- **Amber**: working on an item right now.
- **Off**: the agent is disabled. It stays in the list with its config and memory intact, it just
  is not responding.

Open an agent and you get three views: its **activity**, its **reminders**, and its **profile**. The
address bar follows wherever you are, so you can bookmark or share a link and land back on the same
agent and the same view. (To browse the team's shared files, see
[Your knowledge base](./working-with-your-agent.md). The knowledge base is its own surface.)

<!-- TODO(screenshot): sidebar with a few agents showing different status dots (idle / working / Off). Demo team data only. -->

## Is the agent healthy?

At the top of the activity view, a status line tells you whether the agent is **working** right now
(with how long ago it started) or **idle**. Next to it, a short note shows the latest thing the agent
did, so you can tell a long-running task from a stuck one without digging.

## What did the agent actually do?

The activity view is where you verify an agent's work. This is its single most useful job: a record
you read **after** the fact to see what happened, not a gate that approves actions before they run.

It has two lenses:

- **Conversation**: the Slack back-and-forth. The messages that woke the agent and what it sent back,
  with an Inbox / Outbox filter when you want one side only.
- **Activity**: the step-by-step trail. The tools the agent called, the files it wrote, the messages
  and reactions it sent, and any errors. Turn on **Failed only** to jump straight to what went wrong,
  or **Show all steps** to see the full, unfiltered sequence.

Entries are grouped by day, and while an agent is working the feed follows along live.

<!-- TODO(screenshot): activity view, Activity lens, showing a few tool steps + one message in/out. Demo data. -->

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

## The profile

The profile is where you see and change how an agent is set up, and check how its current session is
doing. It reads from the top down.

The settings at the top are editable in place:

- **Name** and **Role**: how the agent is addressed and what it is responsible for. The role is the
  biggest lever on how useful the agent is. (See [Configuring an agent](./configuring-an-agent.md).)
- **Provider**, **model**, and **reasoning effort**: the engine the agent runs on and how hard it
  thinks.
- **Home**: the folder that holds the agent's memory and notes.
- **Owner**: the person responsible for the agent.

It also shows a few read-only facts: when the agent was **created**, when it was **last active** (the
last time it did anything), and how many past sessions have been **archived**.

Changes are saved as soon as you make them, and the agent applies them the next time it is idle. If it
is mid-item, you will see a note that the change will apply once the current item finishes, so you are
never left guessing. Changing the provider asks you to confirm, then the agent reloads itself.
Switching to a different provider starts a fresh session, but MEMORY.md, notes, and activity history
stay intact.

Below that, the **Slack** section shows the workspace and handle the agent posts as. You can re-pull
the agent's avatar from Slack with **Sync avatar from Slack**, or open its Slack app settings to change
the icon at the source.

<!-- TODO(screenshot): profile top block (Name / Role / Provider / Home / Owner) with the apply-when-idle notice. Demo data. -->

Further down, the **This session** block shows how the agent's current working session is doing:

- **Context**: how full the agent's working memory is, as a percentage. When it fills up the agent
  automatically compacts, so this tells you how close that is. (Some providers do not report it, in
  which case it shows a dash.)
- **Compactions**: how many times the session has compacted so far.
- **Started**, with how long the session has been up.

<!-- TODO(screenshot): the This session block (Context + Compactions + Started). Demo data. -->

Last, the profile lists the agent's **Skills** (see [Skills](./skills.md)).

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
