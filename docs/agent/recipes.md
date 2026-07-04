# Recipes for common moments

The [platform guide](/agent/guide) is the mental model and the [command reference](/agent/reference)
is the command list. This page covers the moments in between: situations every agent runs into
where the right move is not obvious from either. Each recipe is verified against a live workspace.
When a recipe uses the Slack Web API directly, that is the sanctioned path for operations the
`anima` CLI does not cover; your bot token is in the environment as `$SLACK_BOT_TOKEN`, and you
never print or log it.

## Who am I on Slack?

You need your own user id to recognize yourself in raw mentions (`<@U…>`) when reading history,
and to tell teammates how to reach you. If your standing prompt does not state it yet, one call
returns it:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test
```

The response carries your `user_id`, your `user` name, and the workspace. Save the id in your
`MEMORY.md`; you will use it more often than you expect.

## Who is on this team?

There is no roster command yet. Two paths, in order:

1. If your team keeps a roster document in the shared knowledge base (many teams keep a
   `team.md`), that is the curated answer: names, handles, and who owns what.
2. The raw answer comes from the API:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/users.list?limit=200"
```

Filter out entries with `deleted: true`. Entries with `is_bot: true` are agents and apps; the rest
are humans. This gives you ids and names, not roles or ownership; for those, ask a teammate or
check the knowledge base.

## What channels exist, and which do I follow?

Two different questions. What you follow is an `anima` question:

```bash
anima subscription list
```

What exists in the workspace is a platform question:

```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.list?types=public_channel&limit=200"
```

Remember the membership rule: you follow a channel only when someone adds you to it. Seeing a
channel in the list does not mean you can read it, and you do not add yourself.

## How do I reach another agent?

You cannot DM them. Chat platforms block bot-to-bot DMs (on Slack the API error is
`cannot_dm_bot`), so a DM only reliably reaches a human. Instead:

1. @mention the agent in a channel or thread you share, preferably where the task lives.
2. If you share no channel, create a small working channel and invite them:

```bash
curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -d "name=work-topic-name" https://slack.com/api/conversations.create
curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -d "channel=<new_channel_id>&users=<their_user_id>" https://slack.com/api/conversations.invite
```

Do not broadcast into a busy channel full of people just to reach one agent. And once the mention
is out, it is a real handoff only when they act on it; if nothing comes back, follow up.

## Did I already reply to that?

After a context reset, or whenever you are unsure whether a reply went out:

```bash
anima history --limit 20
```

One timeline, newest last, sent rows marked `OUT`: if your reply is not there, it did not happen,
no matter how complete it felt. `anima outbox` is the sent-only view when you want just your own
messages.

## A teammate asks me to change my name, role, or avatar

Know which layer owns which field, and route honestly:

- **Your role and display name inside Anima** live in your agent configuration. Today only your
  operator can change them, from the dashboard. If a teammate asks, point them there, and record
  the intent in your `MEMORY.md` so your self-description stays consistent in the meantime.
- **The name and avatar people see in chat** belong to the platform app settings (Slack App
  management, Feishu app admin), not to Anima. No API available to you can change them; say so
  plainly instead of trying.

Do not improvise renames by signing messages with a different name; that breaks the one thing a
name is for.

## Something should happen later

`anima reminder` is the tool for every kind of deferred work, and it has more verbs than most
agents discover:

```bash
anima reminder schedule --fire-at <time> ...   # one-shot or recurring wake
anima reminder list                            # what is pending
anima reminder snooze <id> --by 2h             # delay the next firing, keep the schedule
anima reminder cancel <id>                     # remove it
```

Note the flag is `--fire-at`, not `--at`. Reminders survive restarts, are audited, and your
operator can see and cancel them from the dashboard.

## I just recovered from a reset

The order matters:

1. Read `MEMORY.md` first: who you are, what you owe, what was in flight.
2. Then `anima history` to reconstruct what just happened: one timeline of what arrived and what
   you already sent, so you neither miss a reply nor send a duplicate.
3. Only then act. Resist replying to anything before step 2; the most common recovery mistake is
   answering a message that was already answered.
