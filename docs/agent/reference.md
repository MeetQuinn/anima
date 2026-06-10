# Agent command reference

Quick how-tos for the `anima` commands you use as an agent. When you are about to use a command
you are not sure about, read the relevant entry here first. For the mental model behind these
commands (how Anima works around you), see the agent guide.

## Per-agent environment values and secrets (`anima env`)

Use this when you need an external service's value to run a command or tool, for example an API
key, a token, or a config setting like a region.

These values live in your own per-agent store. Setting a value does not put it into your shell.
A value only enters a process when you explicitly run that process through `anima env run`.

**Set a plain (non-secret) value:**

```
anima env set SERVICE_REGION us-west-2
```

**Set a secret (API key, token). The value is read from stdin, never from the command line:**

```
printf '%s' "$THE_SECRET_VALUE" | anima env set OPENAI_API_KEY --secret
```

Secrets are encrypted at rest. The CLI rejects a secret passed as an argument, so always pipe it
in through stdin.

**Use values to run a command.** Inject only the keys that command needs, into that one child
process:

```
anima env run --keys OPENAI_API_KEY -- some-tool --do-the-thing
```

Omit `--keys` to inject every configured value. Nothing is auto-injected into your shell, so wrap
the command each time you need a value. Only selected stored values are added; Anima's managed
runtime and provider credentials are not forwarded automatically.

**Check what is configured.** Secret values are shown masked, for example `••••1234`:

```
anima env list
```

**Do not:**

- Never print or echo a secret value, in any message, file, or log. `anima env list` masks values
  so you can confirm a key is set without revealing it. That is all you need.
- Do not pass a secret as a command argument; it would land in shell history and process listings.
  Use stdin only.
- Some names are reserved or managed and cannot be set (for example `ANIMA_*`, `PATH`,
  `NODE_OPTIONS`, and the dotenv key material). The CLI will tell you if a name is not allowed.

## Invite another Feishu bot into a chat

Use this when the user asks you to add another Anima-created Feishu agent to the current Feishu
chat and there is no `anima` command for the invite yet.

Feishu invites bots by **app ID**, not by `open_id`. For an Anima-created Feishu agent, the target
app ID is the agent's Feishu App ID (`feishu.appId`). If you cannot see the target agent's app ID,
ask the user for it or ask them to open the target agent's Profile page and copy the Feishu App ID.
Do not guess it from the bot name.

You need the current chat ID from the delivery envelope, for example `chat_id=oc_...`. The current
agent must already be in that chat, and its Feishu app must have the recommended group-member
permission authorized and published.

Call Feishu's chat-member API with the runtime tenant token:

```
curl -sS -X POST \
  "https://open.feishu.cn/open-apis/im/v1/chats/<chat_id>/members?member_id_type=app_id" \
  -H "Authorization: Bearer $FEISHU_TENANT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"id_list":["<target_app_id>"]}'
```

Replace `<chat_id>` with the Feishu `oc_...` chat ID and `<target_app_id>` with the target
agent's Feishu App ID.

Do not print or log `$FEISHU_TENANT_ACCESS_TOKEN`. If the API says the app lacks permission, ask the
user to authorize the recommended Feishu permissions, publish a new app version, then try again. If
the API says the bot cannot manage chat members, the current bot may not be allowed to invite
members in that group.

## Invite a Feishu user into a chat

Use this when the user asks you to add a human teammate to the current Feishu chat and there is no
`anima` command for the invite yet.

Use deterministic identifiers only:

- If the teammate appears in the current message envelope or readable history, use their Feishu
  `open_id`.
- If the user gives an email address or phone number, resolve it to an `open_id` first.
- If the user gives a tenant `user_id`, you may invite with `member_id_type=user_id`.
- Do not guess from display name. If you only have a name, first ask the user to mention the
  teammate in Feishu and send the request again so Anima can read the stable ID from the mention
  metadata. If they cannot mention the teammate, ask for an email, phone number, `open_id`, or
  `user_id`.

To resolve an email or phone number to an `open_id`, call Feishu's user ID lookup API:

```
curl -sS -X POST \
  "https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id" \
  -H "Authorization: Bearer $FEISHU_TENANT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"emails":["<email>"],"mobiles":["<phone>"],"include_resigned":false}'
```

Use only the fields you have. For example, omit `mobiles` when you only have an email address. If
Feishu returns no matching user, first ask the user to mention the teammate in Feishu and send the
request again. If they cannot mention the teammate, ask for another deterministic identifier.

After you have the target user's `open_id`, invite them with the chat-member API:

```
curl -sS -X POST \
  "https://open.feishu.cn/open-apis/im/v1/chats/<chat_id>/members?member_id_type=open_id" \
  -H "Authorization: Bearer $FEISHU_TENANT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"id_list":["<target_open_id>"]}'
```

Replace `<chat_id>` with the Feishu `oc_...` chat ID and `<target_open_id>` with the user's Feishu
`open_id`. If you already have a tenant `user_id`, use
`member_id_type=user_id` and pass that `user_id` in `id_list`.

Do not print or log `$FEISHU_TENANT_ACCESS_TOKEN`. The current agent's Feishu app must have the
recommended member-invite and user-lookup permissions authorized and published. If the API says the
bot cannot manage chat members, the current bot may not be allowed to invite members in that group.

## Ask a one-click question (`anima ask`)

Use this when you need a bounded decision from a human: yes/no, approve/reject, or one pick
from a short list of 2 to 5 options. For an open-ended or multi-part question, send a normal
message instead. `ask` is for choices, not discussion.

The question posts with clickable answer buttons. By default the current Slack surface answers
it: the person in a DM, or first-click-wins in a channel or thread. Add `--to` only when one
specific person must be the one to answer.

```
anima ask --question "Ship the release to stable now?" --option "Ship" --option "Hold" --to @teammate
```

## Wake yourself later (`anima reminder`)

Use this for all deferred or recurring work: check back on a task, follow up with a teammate, run
a daily routine, or anything you need to do later. A reminder wakes you with its instructions at
the scheduled time. This is the most basic form of acting on your own initiative. Reminders
persist across restarts and are recorded in the audit log.

Schedule a one-shot with a delay or a fixed time, or a recurring one with a repeat rule and a
timezone:

```
anima reminder schedule --in 2h --title "check deploy" --instructions "verify prod is healthy"
anima reminder schedule --repeat daily@09:00 --timezone Asia/Shanghai --title "standup" --instructions "post the async standup"
```

Manage them with `anima reminder list`, `anima reminder cancel <id>`, and
`anima reminder snooze <id>`. Repeat formats: `every:<n>m|h|d`, `daily@HH:MM`, and
`weekly:<day,day>@HH:MM`. The timezone is an IANA name, for example `Asia/Shanghai`.

**Do not:**

- Do not roll your own scheduling, for example a background sleep. Only `anima reminder` survives
  a restart, which is the whole point: a scheduled wake must still fire after the runtime restarts.

## Reconstruct after a restart (`anima inbox`, `anima outbox`)

Use this when you have just restarted or compacted and need to see what was happening. Read your
`MEMORY.md` first to restore who you are and your open obligations, then check recent history.
`anima inbox` shows messages and wakes you received. `anima outbox` shows what you sent, including
messages, files, and reactions. If you are unsure whether you already replied to something, check
`anima outbox` before sending, so you do not answer it twice.

```
anima inbox
anima outbox
```

## Search messages you saw or sent (`anima message search`)

Use this when you need to find an older decision or thread by keyword without guessing a time
window. This searches your local Anima message ledger: conversations you were actually part of,
meaning messages delivered to you and messages you sent.

This is agent-visible history, not workspace search. It cannot find messages from channels or
threads where you were never present, and transcripts fetched with `anima message read` are not
searchable yet.

```
anima message search launch criteria
anima message search "invoice bug" --channel '#support' --since 2026-06-01
```

Search uses AND matching by default: every keyword must match. Results are newest first and include
the message timestamp, channel, direction, and a snippet. Use `--before <iso>` with the
`next_cursor` line to page older matches.

## Send a file, or open one you received (`anima file`)

Use this to upload a local file to the chat, or to open a file a teammate sent you. Sending fails
before upload if a path does not exist.

```
anima file send /tmp/chart.png
anima file fetch <fileId> /tmp/incoming.png
```

The `fileId` comes from the `attached: id=<id>` line in message-read output. To actually look at
an image a teammate sent, fetch it to a path and then read that path.

## See where you are listening, mute what is done (`anima subscription`)

Use this to check which channels and threads you are following (`list`), or to stop following one
that is finished with you (`mute`).

```
anima subscription list
anima subscription mute --channel <id>
```

Mute only when a thread or channel is clearly done with you and still noisy. An @mention always
brings you back, so muting is safe and is not the same as leaving. Finishing your part of a thread
is not a reason to mute, because follow-ups are common.

## Send messages and reactions (`anima message`, `anima reaction`)

The message body is read from stdin, so send a multi-line or Markdown body with a heredoc. Reply
where the message came from: pass the envelope's `channel=` to `--channel` and its `thread_ts=` to
`--thread-ts`. Bodies are Markdown, so use `**bold**`. `anima message update` edits a message in
place.

```
anima message send --channel C0XXXX --thread-ts 1780000000.000000 <<'MSG'
**Done.** Details here.
MSG
```

A reaction is a lightweight reply when a full message is not needed. The emoji is a name, without
colons:

```
anima reaction add --channel C0XXXX --message-ts 1780000000.000000 --name white_check_mark
```

**Do not:**

- Do not pass the emoji with colons, for example `:white_check_mark:`. Use the bare name
  `white_check_mark`.
- Editing a message to add an @mention does not notify the mentioned person. Delete and re-post
  with the mention instead.
