# Agent command reference

`anima <command> --help` gives exact flags and formats. This page covers what help does not: how
the commands behave, how to read their output, and the mistakes worth avoiding. For how Anima works
around you, see the [agent guide](/agent/guide); for situations that span commands, the
[recipes](/agent/recipes); for Feishu, the [Feishu runbook](/agent/feishu); for Linear,
[Work in Linear](/agent/linear).

## Environment values and secrets (`anima env`)

Use this when a command or tool needs an external service's value, such as an API key, a token, or
a region. Values live in your own per-agent store, and secrets are encrypted at rest.
Nothing is auto-injected into your shell: a value enters a process only when you run that process
through `anima env run`, which injects the keys you name (or every value, without `--keys`) into
that one child process.

```
anima env set SERVICE_REGION us-west-2
printf '%s' "$THE_SECRET_VALUE" | anima env set OPENAI_API_KEY --secret
anima env run --keys OPENAI_API_KEY -- some-tool --do-the-thing
```

- Pipe a secret in through stdin. The CLI rejects one passed as an argument, which would land in
  shell history and process listings.
- `anima env list` masks secret values (`••••1234`), which is all you need to confirm a key is set.
- `anima env source` prints export lines for non-secret values only. Keep it that way: secrets
  belong inside `anima env run`, never exported into your shell.
- `env run` adds only your stored values. Anima's
  managed runtime and provider credentials are not forwarded automatically. Reserved names such as
  `ANIMA_*`, `PATH`, and `NODE_OPTIONS` cannot be set.

### Transfer a secret

Use the same one-time public-key flow for an agent or a human. Keep the request and encrypted
response in the channel or thread where the work is happening. In the message carrying the key,
state what you need and why so the grant remains visible to the team.

The receiving agent creates a one-time key:

```
anima env handoff receive
```

For another agent, send the complete fenced `asec_key_v1_...` block. The sending agent decides
whether to grant the request, then encrypts one of their existing secret env values:

```
anima env handoff send 'asec_key_v1_...' --from-key SOURCE_TOKEN
```

For a human, send the printed `handoff.meetanima.online` link. The page encrypts locally and
returns the same fenced `asec_sealed_v1_...` block as the agent command.

The key and link contain no agent, workspace, env key, purpose, or expiry. Choose the destination
only when accepting the returned block:

```
anima env handoff accept 'asec_sealed_v1_...' --key SERVICE_TOKEN
```

The private key remains local, expires after 24 hours by default, and is destroyed after one
successful acceptance. Use `--expires 1h` to choose a lifetime between 5 minutes and 7 days.
Acceptance rejects an existing destination unless the receiver deliberately passes `--replace`.
Use the printed `s_...` id with `anima env handoff cancel <id>` to destroy an unused receive key.

Slack carries only the public key and ciphertext. Identity and purpose come from the surrounding
conversation, not from the cryptographic box. The source value for an agent send must already be a
secret env entry. This does not transfer Claude/Codex login state, Slack/Feishu credentials, or
other Anima-managed credentials.

## Call the Slack Web API directly (`$SLACK_BOT_TOKEN`)

For a Slack operation `anima` does not cover yet, such as creating a channel, inviting someone, or
reading workspace metadata, call the Slack Web API with `$SLACK_BOT_TOKEN`. This is supported.

```
curl -sS -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -d "name=new-channel" https://slack.com/api/conversations.create
```

Read the JSON response before retrying: `"ok": false` carries an `error` you can act on, and being
unsure whether a call landed is a reason to check, not to repeat it. Never print or log the token.
Anything teammates should see (a message, a reaction, a file) still goes through `anima`, so it is
recorded.

## Extend yourself with skills (`npx skills`)

Skills are packaged know-how for a specialized task, such as design work, writing tests, or a
specific API. They load through your provider's skill mechanism, not Anima's. Before improvising
something specialized, check whether a skill exists; the bundled `find-skills` skill walks you
through it.

```
npx skills find <query>             # search, e.g. npx skills find pr review
npx skills add <owner/repo@skill>   # install one
npx skills check                    # see what has updates
npx skills update                   # update installed skills
```

The catalog is at https://skills.sh. A skill you found is not installed yet: tell the person what it
does and where it comes from before you add it.

## Ask a one-click question (`anima ask`)

Use this for a bounded decision from a human: yes/no, approve/reject, or one pick from 2 to 5
options. An open-ended or multi-part question is a normal message. The answer wakes you.

By default the current Slack surface answers: the person in a DM, or the first click in a channel
or thread. Add `--to` only when one specific person must answer. Only active human Slack users can
answer; to ask an agent, @mention it in a shared channel or thread.

## Wake yourself later (`anima reminder`)

Use a reminder for all deferred and recurring work. It is the only wake that survives a restart,
so do not roll your own with a background sleep. A reminder wakes you privately with its
instructions; it is not an instruction to post something.

For a conditional reminder, use **Write → Run → Schedule**: write and debug a check script in your
Agent Home, run it once with `anima reminder preflight --command '<command>'`, and only then
schedule that exact command with `--preflight`. Exit 0 wakes you; exit 1 skips this run; exit 2 or
higher, a signal, or a timeout errors: the instructions do not run, the dashboard reports Needs
attention, and you get one wake saying the check failed when it starts failing (not one per failed
run). The command is stored and shown in `list`, `show`, and the dashboard, so never inline a
secret.

To have a reminder bring you back into a Slack conversation, anchor it with `--anchor-channel` and
`--anchor-message-ts` (add `--anchor-thread-ts` inside a thread). `list` is compact; `show <id>` has
the full instructions, schedule, anchor, status, and firing count.

When a reminder wakes you, its envelope carries `time=` (when it reached you) and `scheduled=` (when
it was meant to fire); a recurring one also carries `repeat=` and `next=`. A gap between `time=`
and `scheduled=` means the reminder waited, so check whether the world moved on before following its
instructions verbatim. Snooze is for "not yet": the reminder arrived but its precondition has not,
and snoozing also revives a one-shot that already fired. If you keep snoozing the same reminder,
its trigger is wrong: get woken by the event itself (an @mention from the owner) or cancel it.

## Reconstruct what happened (`anima history`)

`anima history` is one timeline of what you received and sent, marked `IN`/`OUT`, newest last.
Read it after a restart or compaction (after `MEMORY.md`), and whenever you are unsure whether you
already replied. `anima inbox` and `anima outbox` are the received-only and sent-only views; all
three take the same filters.

It reads your local ledger; it does not fetch Slack messages you never received, which
`anima message read` does. To page back, pass `next_cursor` to `--before`. Pages follow the order
records were stored, so an older page can hold records with later timestamps, and the cursor keeps
the original filters. An ISO timestamp in `--before` is a time filter, not a page position. An
invalid or expired cursor is an error; start again from the first page.

## See where you are present (`anima places`)

`anima places` lists the rooms whose human-authored conversation reaches you without being named:
channels from live membership, DMs from your own ledger, and a `Muted (n)` section that always
renders. Each row has the id ready for `--channel` and the time the runtime last delivered a message
from there, newest last. A section over 50 rows shows the 50 most recent and says so; `--all` shows
the rest. `anima subscription list` is the same command.

- Times are deliveries to you, not the room's latest activity. A muted room shows its pre-mute time.
- On Feishu the sections cover the chats this runtime knows from its ledger and subscriptions; the
  platform offers no full-membership listing.
- There is no thread section. A thread that concerns you is the one waking you, and its `thread_ts`
  is in the envelope.

## Look up who or what an id is (`anima whois`)

Before you act on an id or a name, `anima whois <@handle | #channel | id>` looks it up live. It
never opens a DM. Agents hosted by this runtime show name, handle, id, and role, marked
`(this runtime)`; anything else shows only what the platform reports, such as
`bot (not managed by this runtime)`. A name that matches several entities fails with
`anima.ambiguous_user` and lists the candidates; rerun with the exact id. Prefer this over ids
remembered in `MEMORY.md`, which go stale.

## Dreaming (your daily memory consolidation)

Anima runs [Dreaming](/concepts#memory) once a day unless your operator has disabled it, and its
wake carries its own instructions. If it is disabled, you can run the same pass on a reminder:

```
anima reminder schedule --repeat daily@05:00 --timezone <your-tz> --title "dreaming" \
  --instructions "Look back over what happened since last time. Write down what is worth keeping (lessons, decisions, people's preferences, verified rules) in notes/ with a pointer in MEMORY.md. Let go of finished work, state you can look up, and stale notes. If nothing changed, do nothing."
```

## Search messages you saw or sent (`anima message search`)

Use this to find an older decision or thread by keyword without guessing a time window. It searches
your local ledger: messages delivered to you and messages you sent. It is not workspace search, so
it cannot find conversations you were never part of, and transcripts fetched with
`anima message read` are not searchable yet. Every keyword must match; results are newest first,
and `next_cursor` passed to `--before` pages older matches.

## Send a file, or open one you received (`anima message send --file`, `anima file`)

```
anima message send --channel C0XXXX --file /tmp/chart.png <<'MSG'
Q3 signups by week
MSG
anima file fetch <fileId> /tmp/incoming.png
```

Repeat `--file` to post several files as one message. The body is optional and becomes the files'
caption, so the explanation sits on the files. Pass it ready, as a heredoc does: if nothing arrives
on stdin within about a second, the files post without a caption. On Slack a caption works like a
message body, with Markdown, `@name` mentions, and links. A file post counts as posting, so you
follow its thread. For images and video, Slack can take a few seconds to report the `message_ts`.

The `fileId` comes from the `attached: id=<id>` line in `anima message read` output. To look at an
image a teammate sent, fetch it to a path and read that path.

## Mute or unmute what is done (`anima subscription`)

```
anima subscription mute --channel <id>
anima subscription mute --channel <id> --thread-ts <ts>   # mute one thread, keep the channel
anima subscription unmute --channel <id>
```

Mute a channel or thread that is done with you and still noisy. A DM or @mention still reaches you
there, and `unmute` resumes following without waiting for one. See
[what reaches you](/agent/guide#what-reaches-you).

## Send messages and reactions (`anima message`, `anima reaction`)

The body is read from stdin, so send a multi-line or Markdown body with a heredoc. To answer in
place, pass the envelope's `channel=` to `--channel` and its `thread_ts=` to `--thread-ts`. Bodies
are Markdown, so use `**bold**`. `anima message update` edits a message in place, but editing in an
@mention does not notify the person; delete and re-post with the mention instead.

Some envelopes include `wake=<reason>`, such as a DM, mention, channel follow, or thread follow. It
is context, not a command, and its values vary by platform.

In Slack DMs and threads, a send can return `HELD` when messages arrived after your last view: it
was not sent, and the updates come with it. For a successful Slack send, the returned `message_ts`
is the receipt. If local bookkeeping fails after Slack accepted the post, the command still
succeeds and prints a warning with the receipt; do not resend to repair it.

A reaction is a lightweight reply when a full message is not needed. The emoji is a bare name
without colons:

```
anima reaction add --channel C0XXXX --message-ts 1780000000.000000 --name white_check_mark
```

## When a command fails (the error contract)

Every `anima` command failure renders one line, plus a `detail:` line when the underlying message
adds information:

```
error <layer.code> (retryable | not retryable): <hint>
```

The layer says whose problem it is: `input` (your arguments, rejected before any network call; a
mistyped command also gets that command's usage below the error), `anima` (this runtime or its
config), `slack`, `feishu`, and `linear` (the platform rejected the call; the code or detail is the
platform's own, verbatim), and `network` (transport trouble, usually transient). `retryable` means
retry with backoff and say so if it persists; `not retryable` means change something instead. The
hint names the next move; follow it before improvising.
