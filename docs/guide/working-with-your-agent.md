# Work with your agent like a teammate

Most tools make you learn them first: the right prompt, the special syntax, one more app to open. Your agent is
the opposite. It is a teammate in the chat your team already uses. Tell it what you need in plain words, and it
works from there, replying right in the channel or DM. If you can send a message, you can work with it. Nothing
for your team to install, nothing to learn.

> You talk in the chat. The work runs on your machine. Your agent lives in both, and remembers.

Here's what your agent can do, and how to work with it day to day.

## Talk to it

Two ways to reach it, both things you already do:

- **DM it.** A direct message always gets through.
- **@mention it in a channel it is in.** That is how you pull it into the work happening there. It picks up the
  message and replies in that channel or thread.

Say what you want in plain language. No prompts, no special syntax. You send the message, you watch it pick the
message up, and it answers where you asked.

## A shared teammate, not a private bot

Your agent belongs to the whole workspace. Anyone can DM it, and anyone in a channel it is in can @mention it. It
works with each person the way it works with you: answering questions, talking things through, and picking up the
work they hand over. One teammate the team shares, not a dozen private chats.

## Hand it work

Give work to your agent the way you would hand it to a person: describe what you want, and @mention it. Say what
you want and why, and leave the how to the agent.

- **Small things, it just does.** You see it take the message, and it reports back when it is done.
- **Longer things, it keeps you posted.** A quick heads-up up front, a check-in at milestones or blockers, and a
  word when it is finished.
- **When something is yours to decide, it asks.** A clear question with a few options is your cue to weigh in.
  That part it is holding for you. Everything else, it handles.

You do not spell out the steps. Describe the outcome, and the agent works out how to get there.

## It does real work, not just chat

Your agent is not a chat box you type at. It is a real member of your workspace, and it does the things a capable
teammate does in the chat, and more:

- post messages and reply in threads
- react with emoji
- spin up a channel for a piece of work and bring the right people in
- pin and bookmark what the team keeps coming back to
- share files
- schedule a message to go out later, like a morning update
- ask for a quick decision, right in the conversation

That is the everyday stuff, across every channel and DM it is part of, in the same chat your team already uses.
You are not setting up a bot. You have a colleague who knows their way around.

And it goes beyond chat. It works with files and runs real tasks, not just messages, and it is built to be
extended: give it new skills, connect new tools, and it takes on much more.

## Give it keys and settings

Real work often needs a service credential: an API key for a tool, a token, a region setting. Each agent has its
own small store for these, so a value you give one agent is not visible to the others, and secrets are encrypted
at rest. The agent injects a value only into the specific command that needs it; nothing sits in its shell
waiting to leak.

For a plain setting, just tell the agent in chat: "use region us-west-2 for the reports" and it stores the value
itself. For a real secret, do not paste it into Slack: anything you send in chat lives in your workspace history.
Instead, set it from a terminal on the machine Anima runs on:

```bash
printf '%s' "$THE_SECRET" | anima env set OPENAI_API_KEY --secret --agent <agent-id>
```

The secret goes straight into that agent's encrypted store without ever touching the chat. Then tell the agent
the key is there; it can confirm with `anima env list`, which shows names but masks values.

## It remembers what you tell it

What you tell it and what it learns working with you stay with it: across channels, across DMs, and from one day
to the next. You do not re-explain the background every time, and you do not start over after a break. The more
you work together, the more it knows, and the less you repeat.

Want something to stick? Say so. "Remember this for next time," and it holds onto it. And it knows the difference
between what belongs in a private DM and what belongs in a shared channel.

## It takes initiative

A good teammate does not only move when you message it, and neither does your agent. It follows up on the work it
owns, keeps things moving, and sets its own reminders for later or recurring work, so "circle back on this Friday"
or "check this every morning" actually happens.

It drives the work you hand it. You stay in charge of direction: you decide what matters, and the agent carries it
forward.

## Where to go next

- **[How an agent works](./how-an-agent-works.md)** explains what is going on inside a single agent.
- Once you are running more than one agent and want them coordinating, see
  **[How your agents work as a team](./how-your-agents-work-as-a-team.md)**.
