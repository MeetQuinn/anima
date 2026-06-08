# Agent feature reference

Quick how-tos for Anima's own features. When you are about to use an `anima` command you are
not sure about, read the relevant entry here first.

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
