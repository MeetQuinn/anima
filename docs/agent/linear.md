# Work in Linear

Your connected app is your Linear identity. You can find issues, create work and join
existing discussions without an assignment or an incoming agent session. These actions
use the app's current workspace/team permissions and your existing primary context.

## Issues and ordinary comments

```sh
anima linear teams
anima linear search 'login timeout'
anima linear issue ANI-123
anima linear create --team <team-uuid> --title 'Fix login timeout' <<'DESCRIPTION'
Context, expected behavior and acceptance criteria.
DESCRIPTION
anima linear comment --issue ANI-123 <<'COMMENT'
Here is another observation.
COMMENT
anima linear comment --issue ANI-123 --reply-to <comment-uuid> <<'REPLY'
This answers your question.
REPLY
```

`teams`, `search` and `issue` return one page. Use `--limit` (1–100) and the returned
`pageInfo.endCursor` as `--after` when `hasNextPage` is true. For `issue`, the cursor
pages its comments. Issue IDs may be UUIDs or identifiers such as `ANI-123`; creation
uses a team UUID from `teams`.

`--reply-to` accepts either a root comment or a reply. Linear has one reply level;
Anima resolves a reply to its root so the new comment stays in that discussion.

Ordinary comments can be added after a task is complete. They do not claim an inbox
request, complete a work session, or resume work that a person stopped. Use session
responses below when replying to an assigned request.

Creation commands print their generated UUID to stderr before sending and accept an
explicit `--id`. They make one write attempt. If the result is uncertain, inspect that
UUID with `issue` or the API's `comment(id: ...)` query before retrying; do not start a
second creation with a fresh UUID. A successful response includes the object's ID and
URL. Common creation/comment commands record activity and outbox entries; a local
audit warning after success does not mean the external write failed.

## Credentials and API access

At startup the runtime supplies `LINEAR_ACCESS_TOKEN` and
`LINEAR_ACCESS_TOKEN_EXPIRES_AT` when the identity is available. This is a snapshot;
an already-running child does not receive refreshed environment variables. Get current
credentials when needed:

```sh
anima linear token
```

The JSON contains `accessToken`, `expiresAt`, `organizationId` and `appUserId`. Keep it
private; never paste it into messages or files shared with others. Anima keeps the
refresh token and refreshes access on demand. A refresh failure leaves other connected
places available, but Linear commands still require a connected, enabled identity.

For API operations without a dedicated command, pass GraphQL JSON on stdin:

```sh
anima linear api <<'JSON'
{"query":"query { viewer { id name } }"}
JSON
```

`variables` and `operationName` are optional. This command refreshes credentials,
uses Linear's fixed GraphQL endpoint, returns the `data` object and fails on GraphQL
errors (including partial results). It never retries a request. For a failed mutation,
inspect the affected object before attempting another write. API bodies and credentials
are not copied into Anima's activity or message ledger; direct calls using the token
have the same limitation. Use common commands when you want their outbox receipts.

## Notifications and follow-up

An incoming **Linear notification** is context, not a new work assignment. It can
report a new comment, status change or removal of your assignment. Reactions do
not wake the agent. Use
the issue and comment IDs in its envelope to read the discussion or reply with
`anima linear comment`. No automatic reply is required, and finishing the turn
silently does not post a missing-response error. A notification does not resume
work that a person stopped.

Mentions and assignments arrive as work-session requests instead. Replies in your
app's existing work-session thread also use that session, without a second ordinary
notification wake. Own activity and repeated deliveries do not wake you again.
Team-access changes ask you to check `anima linear teams`; the API's current
permissions determine which work you can read or change.

## Assigned work sessions

When your agent has a Linear identity, signed requests arrive with `session_id` in their
Linear delivery envelope. The session is a conversation surface. It shares your primary
working context with other connected places; do not create another provider session for it.

Reply through Anima; your plain model output is not a Linear response:

```sh
anima linear respond --session <uuid> <<'REPLY'
Here is the result and its evidence.
REPLY
```

Use `--kind thought` for progress such as “Started”; it keeps the request open for a later
reply. Use `--kind elicitation` to ask the person for missing information, or `--kind error` to
report a blocker or failed outcome. The default is `response`. Body text goes through stdin.
Only report what happened; do not expose raw tools, private reasoning or credentials.

Read the latest session activities:

```sh
anima linear read --session <uuid>
```

Attach a pull request before or alongside your reply:

```sh
anima linear attach-pr --session <uuid> --url https://github.com/example/repo/pull/1
```

The runtime sends receipt and truthful queued/executing status separately. A receipt is not
a finished task. A response, question or error ends status updates for the inputs it owns.
A later turn can attach a PR and answer a delivered request that is still unanswered, including after
background work finishes. The runtime waits for provider background work and queued wakes
to finish before reporting a missing response.
Follow-up envelopes carry the new prompt only; read session history when you need earlier details.

Stop means stop the associated work. The shared run can include other accepted inputs;
check prior effects before resuming. If its inbox run already ended, Stop blocks later
Linear replies but cannot cancel provider-native background tasks; check those separately.
Removal/revocation blocks writes. If a send result is
unknown, inspect the session; do not change the wording to bypass the recorded retry boundary.
An accepted activity with degraded local bookkeeping does not need another send.
If the automatic missing-response notice fails, its request stays open and Anima records
the failure without retrying it on each idle poll. Inspect the session before responding;
an explicit response still checks any uncertain earlier send.

Installation and ingress belong to the operator. See [Connect Linear](/guide/connect-linear)
for downtime and retry limits. Linear is not Anima's reminder or task store.
