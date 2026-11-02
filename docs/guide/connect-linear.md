---
title: Connect an agent to Linear
description: Install an optional Linear app for an agent and receive signed webhooks through your own HTTPS ingress.
---

# Connect an agent to Linear

Each agent can have its own optional Linear OAuth app. People can delegate issues to it,
mention it and continue the conversation in a Linear agent session. Linear conversations
use the agent's existing primary provider session, alongside Slack and Feishu.

## Before you install

You need permission to create and install an OAuth app in your Linear workspace. Create
one app per agent. Select **Agent session events**, **Inbox notifications** and
**Permission changes**. Linear sends app revocation events automatically;
leave unrelated data and OAuth authorization events off. Anima
requests `read`, `write`, `app:assignable` and `app:mentionable` with `actor=app`.

You provide the public HTTPS address and forwarding yourself. Anima does not create a
tunnel or register a domain. Set one **Anima public address** in **Settings → Server**,
for example `https://anima.example.com`. It is shared by the integrations and agents
in this Anima home.

## Install from the dashboard

1. Open the agent's **Profile**. In **Setup**, select **Configure Linear**.
2. If no public address is saved, select **Open Server settings**, save the HTTPS origin
   without a path, then return. The connection form refreshes when you return to the tab.
3. Select **Create app in Linear**. Anima prefills the agent's name, both URLs below and
   the event subscriptions. Review and create the app. For an existing app, select
   **I already have an app** and make sure its URLs and subscriptions match.
4. Copy the **Client ID** and **Webhook signing secret** into Anima. Select **Prepare
   authorization**, then **Authorize in Linear**. Choose all available teams if the agent
   should work across the workspace; Linear controls the granted access, including private
   teams. Do not paste the secret into chat.
5. Return to Anima. Authorization completes installation. You can mention the agent or
   delegate an issue to it. If Linear does not show "Received by Anima." after you mention
   it, check HTTPS forwarding. There is no required test task.

For `https://anima.example.com`, forward these paths:

| Public path                  | Local destination                                         |
| ---------------------------- | --------------------------------------------------------- |
| `/webhook`                   | The Linear listener, by default `127.0.0.1:14185/webhook` |
| `/api/linear/oauth/callback` | The dashboard's same path, on its configured port         |

Keep the webhook's raw body and `Linear-Signature` unchanged. The dashboard and other API
routes can remain private. The public callback only returns the browser to the dashboard
that started authorization. That dashboard checks the original login session before
exchanging the code. Authorize in the same browser and keep that dashboard reachable from
the device you use; a public callback cannot make a private dashboard reachable remotely.
Do not rewrite redirect destinations to a different dashboard origin.

**App name** lets you adjust the suggested name. Linear app names need 2–80 characters and
cannot contain “Linear” or a URL. The callback and webhook URLs come from the public address;
there is no per-agent callback field. Listener host and port are under **Settings → Server →
Advanced integration settings**. Existing custom listeners are preserved and remain locked
while an app is installed or authorization is pending.

Saving the public address does not change existing Linear apps or verify reachability.
After changing it, update both registered URLs in each app. Existing installed identities
continue working without the new setting. A previous `linearWebhookUrl` is discarded when
reading config, rather than guessing that its origin also forwards OAuth callbacks. Set the
public address explicitly before another installation. The setting is `publicUrl` in the
server `config.json` at the root of the Anima home, not an agent's config. Remove that key
before downgrading to a version without it.

Installation uses PKCE and a single-use state bound to the initiating dashboard session,
valid for ten minutes. A failed exchange or declined authorization clears that attempt and
shows a retry explanation. Prepare again to get a new code; the failed attempt is not retried
automatically. Expired attempts, or consumed attempts left by an older version or an interrupted
process, can be removed using **Remove connection**. Removing an attempt never uninstalls
the app at Linear. There is no separate CLI installation flow.

The row shows the workspace name saved during installation. If an older installation has no
saved name, it shows “Workspace name unavailable”. Reading settings does not fetch the name
or refresh credentials. Connection and listener details remain in the settings dialog.

**App installed** records the verified app identity. It does not prove that ingress is reachable.
**Local listener** separately reports a recent runtime observation: listening locally,
bind failed or stopped. Bind failures show a coarse reason: port in use, permission denied,
address unavailable or other. No current observation is shown if the record is missing,
unreadable, future-dated, 90 seconds old or older, from an exited process or for a different configured
address. The runtime refreshes this small record during reconciliation. An observation write
failure does not stop intake; it can leave an earlier observation visible until it expires.
These states do not check your public HTTPS ingress. Check your local address and runtime
logs when binding fails, and check the tunnel or reverse proxy separately.

The setting shows the last verified, signed webhook received and the number of rejected
signature claims naming this app. The count is saved in a separate small diagnostic file,
at most once a minute and when the listener stops. Unknown app claims are not counted;
a crash can lose the unsaved batch. These are facts, not a health or availability verdict.

## Receive and report work

Ordinary comments and issue changes addressed to the app arrive through
inbox notifications. They share the agent's main context and do not require a
delegation or an open work session. The agent can reply with an ordinary comment
or decide that no response is needed. Mentions, assignments and replies in the
app's work-session thread use session events; Anima filters the overlapping
notifications, self-authored activity and delivery retries. Permission-change
notifications tell the agent to check current team access. Reactions do not wake
the agent.

Existing installations need the two additional app webhook subscriptions enabled
to receive these notifications. They use the same listener and signing secret;
no new OAuth scopes are requested. Anima does not fetch missed notifications
retroactively when subscriptions are enabled.

The dedicated port runs only when at least one enabled agent has a complete installed
identity. It rejects unsigned, incorrectly signed, stale and mismatched requests. It serves
no dashboard, OAuth, command or credential-proxy routes.

Accepted requests persist locally before the webhook acknowledgement. A separate runtime
activity says **Received by Anima** without waiting for model capacity. The target is within
10 seconds; API, network or credential failures can prevent that activity.

At work start, eligible human-delegated issues move to the team's first started state.
Mentions without delegation, already started/completed/canceled issues and the human assignee
are preserved. The agent reports a response, question or error, and can attach a PR link.
A question ends the current status updates until a new prompt arrives.
An agent can also start work without a mention or delegation: `anima linear start --issue <id>`
opens a session and posts its initial progress from stdin. It can target an existing comment
with `--comment <uuid>`. The session belongs to the app and shares the agent's current
working context; a creation webhook matching the recorded session does not wake the agent again.
If creation was uncertain and no session ID was recorded, the webhook follows normal intake. Human replies do.
For longer work, the agent can send progress with `anima linear respond --kind thought`
and send its final response in a later turn. An unanswered request stays open while the
provider has background work or the agent has queued wakes. Once both are empty, the
runtime reports a missing response as an error. Providers without background-work
reporting use the active run and queue state.

After 10 minutes without a successful activity, the runtime can post a fixed queued/executing
status for owned inbox work. After the inbox run finishes, it can instead report that the agent
still has ongoing work and the request is waiting for a final response. This checks the whole
agent's active run, background work and queue; it does not claim progress on a particular request.
Unrelated work can also delay a missing-response notice. Status updates stop on response, question,
failure or cancellation. Failed status sends are attempted at most once per 10-minute interval.

After a runtime restart, interrupted background work gets a durable recovery wake.
If its records cannot be read or the wake cannot be saved, ordinary work still starts, but
automatic Linear idle completion waits for a later retry. The agent checks earlier effects
before continuing; native background tasks are not automatically resumed or rerun. During downtime
or failed status sends, Linear can still display the session as stale after 30 minutes; a later
activity recovers it. See [Linear’s interaction guidance](https://linear.app/developers/agent-best-practices).

Linear's stop signal cancels pending work or requests interruption of its associated run.
A primary run can contain other accepted messages; interrupting it may affect them too.
When the inbox run has already ended, Stop closes the request to later replies; it does
not cancel provider-native background tasks. The notice makes that limit explicit.
The runtime does not replay accepted input automatically.
Inspect any effects that already ran before asking the agent to continue.

## Downtime and delivery gaps

Linear retries failed delivery after **1 minute, 1 hour and 6 hours** and may disable delivery.
Anima recovers locally accepted requests after restart and deduplicates delivery retries.
It does not scan the workspace at startup for sessions it never received.

If Anima is offline beyond Linear's retry window, or Linear disables delivery, those unseen
requests are **not recovered**. Restore your ingress, re-enable delivery in Linear, check
what the agent already did and send a new prompt. Do not assume that local queue recovery
means no messages can be lost. A missing first activity is a reason to check delivery.

## Removal, revocation and credentials

**Remove connection** stops local intake and authorized writes and clears local credentials.
It does not uninstall the app in Linear. Revocation in Linear, or a definite API authorization
failure, marks the local identity revoked; remove and reinstall it to resume.

Runtime credentials are separate from provider launch environments, prompts and public API
responses. The credential file uses mode `0600`. This protects it from other OS users, not
from processes running as the same user. Include it in your private runtime backup policy;
never attach it to a support report.

An accepted external activity and local audit failure are different outcomes. If a response
is lost, Anima stores an unknown result and checks the activity/link before a retry. It does
not blindly resend. An unavailable lookup is not proof that nothing was sent.

Protocol references: [app manifests](https://linear.app/developers/oauth-app-manifests),
[OAuth](https://linear.app/developers/oauth-2-0-authentication),
[webhooks](https://linear.app/developers/webhooks),
[agent interactions](https://linear.app/developers/agent-interaction),
[stop signals](https://linear.app/developers/agent-signals).
