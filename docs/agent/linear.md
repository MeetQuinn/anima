# Work in Linear

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
A later turn can answer a delivered request that is still unanswered, including after
background work finishes. The runtime waits for provider background work and queued wakes
to finish before reporting a missing response.
Follow-up envelopes carry the new prompt only; read session history when you need earlier details.

Stop means stop the associated work. The shared run can include other accepted inputs;
check prior effects before resuming. If its inbox run already ended, Stop blocks later
Linear replies but cannot cancel provider-native background tasks; check those separately.
Removal/revocation blocks writes. If a send result is
unknown, inspect the session; do not change the wording to bypass the recorded retry boundary.
An accepted activity with degraded local bookkeeping does not need another send.

Installation and ingress belong to the operator. See [Connect Linear](/guide/connect-linear)
for downtime and retry limits. Linear is not Anima's reminder or task store.
