# Feishu runbook for agents

Read this when you are handling Feishu work and the normal `anima` command help is not enough.
The command reference has exact commands and API snippets. This page is the operating model: what
the Feishu identifiers mean, which settings humans must configure, and how to avoid blind retries.

## The mental model

Your Feishu identity is a Feishu app with a bot account. Anima delivers Feishu messages to you and
sends your replies back through that app. For ordinary visible output, use audited Anima commands:
`anima message send`, `anima message read`, `anima message update`, `anima file fetch`, and
`anima message react`.

Some Feishu actions do not have first-class Anima commands yet, such as creating a group or adding
members to a group. For those, you may call Feishu OpenAPI directly with
`FEISHU_TENANT_ACCESS_TOKEN`. Do not print or log that token. Anything a human should see still goes
through `anima message`, so the action is visible in Anima's audit trail.

Do not start with web search. First inspect the delivery envelope and this runbook, then use the
command reference for the exact call.

## Feishu identifiers

- `chat_id` starts with `oc_`. It names a Feishu conversation. It can be a DM, a group, or a topic
  container. Use it with `anima message send --chat-id <chat_id>`.
- `message_id` usually starts with `om_`. It names a message. For a topic reply, pass the topic
  `thread_id` when present, otherwise the root `message_id`, as `--thread-ts`.
- `open_id` usually starts with `ou_`. It is the stable user identifier you normally want for
  mentions and human invites.
- `user_id` is the tenant user identifier. Use it only when the envelope or user gave it
  explicitly.
- `app_id` starts with `cli_`. It identifies a Feishu app. Use an Anima-created agent's Feishu App
  ID when inviting another bot into a chat.

Display names are not identifiers. If you only have a name, ask the user to mention that person in
Feishu and send the request again. The mention metadata gives Anima stable IDs.

## Permissions are not visibility

Feishu has two separate gates:

- **API permissions**, also called scopes. These let the app perform actions like send messages,
  read group messages, add group members, or look up users by email or phone. Users authorize these
  in Anima's Feishu setup flow and publish a new app version.
- **App visibility or availability range.** This controls which users can see or use the app. It is
  configured in the Feishu developer console or admin console. The app cannot grant itself wider
  visibility through OpenAPI.

If an API call says a scope is missing, ask the user to add the recommended permission and publish a
new app version. If a member invite fails with `232024` and says users do not have app visibility,
ask the user to add the target person, department, or all members to the app's visibility or
availability range, save or publish that change, then retry.

## Replying, reading, and editing

Use the envelope. In a Feishu chat:

```
anima message send --chat-id <chat_id> <<'ANIMA_MESSAGE'
<reply>
ANIMA_MESSAGE
```

For a topic, include the topic id:

```
anima message send --chat-id <chat_id> --thread-ts <thread_id_or_root_message_id> <<'ANIMA_MESSAGE'
<reply>
ANIMA_MESSAGE
```

Use `anima message read --chat-id <chat_id>` when you need recent chat history. Add `--thread-ts`
when you need a topic's thread history. Use `anima message update --chat-id <chat_id>
--message-ts <message_id>` only for messages you sent.

## Mentioning people

When you know a user's `open_id`, mention them in message text like this:

```
<mention open_id="ou_...">Name</mention>
```

Anima sends that as a Feishu rich-text mention. Do not write raw `@Name` when the user needs a real
mention. Do not invent an `open_id` from a name.

## Creating a group

There is no first-class `anima` command for Feishu group creation yet. Use the direct Feishu API
path in the command reference. The practical sequence is:

1. Get at least one user `open_id` from the envelope, usually the person who asked you.
2. Call the chat-create API once.
3. Read the JSON response. If it contains `chat_id`, the group exists.
4. Send the visible confirmation or test message with `anima message send --chat-id <chat_id>`.

Do not create another group just because you are unsure whether the first call worked. Check the
response first.

## Inviting people or bots

For a human teammate, prefer `open_id`. If the user mentions the teammate in Feishu, use the
mention metadata. If you only have a tenant `user_id`, you may call the member API with
`member_id_type=user_id`. If you only have a display name, ask for a mention, email, phone number,
`open_id`, or `user_id`.

For another Anima-created Feishu bot, invite by that agent's Feishu App ID, not by bot `open_id`.
Ask the user to copy it from the target agent's Profile page if you cannot see it.

When invite calls fail:

- `232024` or "visibility of the app" means app visibility is missing for the target user. Ask the
  user to update the app availability range, then retry.
- A permission error means the current app probably lacks the group-member scope or the new app
  version has not been published.
- A group management error means this bot may not be allowed to manage members in that specific
  group.

Report the specific error and the next human action. Do not keep trying the same identifiers after
the platform has returned a configuration error.

## Safe direct API use

Use `FEISHU_TENANT_ACCESS_TOKEN` only as an HTTP bearer token. Do not echo it, write it into a file,
paste it into chat, or include it in command output. It is acceptable to check whether it exists
without printing the value.

Keep visible communication separate from direct API work. A curl call may create a group or invite
a member, but the human-facing explanation should still be sent with `anima message send`.
