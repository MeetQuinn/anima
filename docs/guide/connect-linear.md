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

You provide the public HTTPS address yourself. Anima does not create a tunnel or register a
domain. Anima has one **public address**, for example `https://anima.example.com`, shared
by the integrations and agents in this Anima home. Forward the whole address to the
dashboard, for example with a Cloudflare Tunnel to `http://127.0.0.1:4174`. Set it in
**Settings → Server**, or when you connect the first agent.

## Install from the dashboard

1. Open the agent's **Profile**. In **Setup**, select **Connect** on the Linear row.
2. If no public address is saved yet, the dialog asks for it first. Enter the HTTPS origin
   without a path and select **Save**. It applies to every agent. The dialog then shows
   whether Linear can reach it (see [Public address](#public-address)).
3. Select **Create app in Linear**. Linear opens in a new tab with the agent's name, its
   avatar when available (see below), both URLs and the event subscriptions filled in.
   Review and create the app. To reuse an app you already created, select
   **I already have one** and make sure its URLs and subscriptions match.
4. Copy the **Client ID**, **Client secret** and **Webhook signing secret** into Anima.
   Do not paste the secrets into chat.
5. Select **Authorize in Linear**. Linear opens in the same tab and asks which teams the
   agent can access. Choose all available teams if the agent should work across the
   workspace; workspace admins can change this later in Linear.
6. After you approve, Linear returns you to the agent's profile with the Linear dialog
   open. Authorization completes installation; there is no required test task. Mention the
   agent or delegate an issue to it. If Linear does not show "Received by Anima." after you
   mention it, check the public address in **Settings → Server**, and the app's webhook URL
   and event subscriptions in Linear.

### Public address

Forward the whole public address to the loopback dashboard listener (`127.0.0.1` on the
dashboard port, `4174` by default), not the restricted LAN or tailnet listener. Linear
uses two paths on it:

| Path                         | Used for                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `/webhooks/linear`           | Signed Linear events (the app's webhook URL)                |
| `/api/linear/oauth/callback` | Returning your browser to Anima after you authorize the app |

The dashboard passes each event's raw body and `Linear-Signature` unchanged to the
runtime's Linear receiver on loopback (`127.0.0.1:14185` by default), which verifies it.
If the runtime is not running, the dashboard answers `503` and Linear retries the delivery.
Apps created before this layout use `/webhook`; the dashboard accepts that path too, so
existing apps keep working without changes. If you put a sign-in gateway in front of the
address (see below), also let `/webhook` through, or first change each such app's
webhook URL in Linear to `/webhooks/linear`. Otherwise their events stop at the gateway.

Anima checks the address when it is shown and after you save it: it requests a one-time
path under `/webhooks/` through the public address and expects this Anima to answer.
The result names what is in the way: a sign-in page or access rule, a different site, an
error from the tunnel, or no answer within five seconds. Select **Check again** after
changing the tunnel. A reachable address means requests through it arrive at this
dashboard. It does not show that events are accepted: that also needs a connected agent
and a running runtime, and the app's webhook URL in Linear. A connected agent's **Last
event** shows that Linear's events arrive.

If a sign-in gateway such as Cloudflare Access protects the address, let `/webhooks/`
through without sign-in, for example with a Cloudflare Access application for that path
and a **Bypass** policy. Linear cannot sign in. The OAuth callback is opened by your own
browser, so it can stay behind the gateway.

Without a dashboard password, the public address serves only Linear's paths (`/webhooks/`,
the legacy `/webhook` and the OAuth callback); every other request through it gets `403`. Anima recognizes requests through
the public address by their `Host` or `X-Forwarded-Host` header naming its host.
cloudflared keeps the original `Host` by default. If your proxy replaces both, the check
warns that the dashboard is open there. To use the dashboard itself through the public
address, set a password with `dashboard-auth set` (see
[Configuration](../configuration.md#dashboard-password-dashboardauth)); it then asks for
that password there. Requests to the dashboard's local address are unaffected.

The OAuth callback only returns the browser to the dashboard that started authorization.
That dashboard checks the original login session before exchanging the code. Authorize in
the same browser and keep that dashboard reachable from the device you use. The browser
may return to a LAN or tailnet dashboard, but it must still match that listener's allowed
peer and host lists. Do not rewrite redirect destinations to a different dashboard origin.

Select **Rename** to adjust the suggested app name. Linear app names need 2–80 characters
and cannot contain “Linear” or a URL. The callback and webhook URLs come from the public
address; there is no per-agent callback field. The receiver's local address is the
`linearWebhook` key in the server config, and rarely needs changing; see
[Configuration](../configuration.md#linear-receiver-linearwebhook).

The new app's icon is prefilled from the agent's avatar only when that avatar is already a
public HTTPS image, such as a Slack profile photo. Otherwise the app is created without an
icon and you can set one in Linear. Anima does not publish local files for this, and changing
the agent's avatar later does not update apps you already created.

Saving the public address does not change existing Linear apps. After changing it, update
both registered URLs in each app. Existing installed identities
continue working without the new setting. A previous `linearWebhookUrl` is discarded when
reading config, rather than guessing that its origin also forwards OAuth callbacks. Set the
public address explicitly before another installation. The setting is `publicUrl` in the
server `config.json` at the root of the Anima home, not an agent's config. Remove that key
before downgrading to a version without it.

Installation uses PKCE and a single-use state bound to the initiating dashboard session,
valid for ten minutes. The code exchange sends the app's client secret together with the
PKCE verifier. If you decline in Linear or the exchange fails, Linear still returns
you to the agent's dialog. It names the problem, with a safe connection, HTTP-status or
response category for failures, plus a standard OAuth error code such as `invalid_client`
when Linear gives one; raw errors, response bodies and credentials are not recorded.
`invalid_client` means Linear did not accept the Client ID and Client secret. The dialog
resumes at your existing app: enter its Client ID and both secrets again and select
**Authorize in Linear**. A failed attempt is not retried automatically.
An attempt that expired or was left unfinished is replaced by authorizing again.

When a return from Linear cannot be tied to an attempt in this browser session, because it
expired, was replaced or was started in another browser, Anima shows a page that names no
agent and asks you to open the agent and authorize again. It never completes or clears
another agent's attempt. An unfinished or revoked connection can also be cleared with
**Disconnect from Linear instead**. Disconnecting never uninstalls the app at Linear.
There is no separate CLI installation flow.

The row shows the workspace name saved during installation, or **Connected** for an older
installation without a saved name. Reading settings does not fetch the name or refresh
credentials. Connection and listener details are in the dialog behind **Manage**.

A connection records the verified app identity. It does not prove that the public address
is reachable; that is the public address check. **Local listener** reports a recent runtime
observation of the receiver: **Listening**, **Failed** or **Stopped**. A failure shows a
coarse reason (port in use, permission denied, address unavailable or other) and what to
check. **Not observed yet** is shown if
the record is missing, unreadable, future-dated, 90 seconds old or older, from an exited
process or for a different configured address. The runtime refreshes this small record during reconciliation. An observation write
failure does not stop intake; it can leave an earlier observation visible until it expires.
These states do not check your public address. Check `linearWebhook` and the runtime logs
when binding fails.

**Last event** shows when the last verified, signed webhook arrived, and the dialog counts
rejected signature claims naming this app. The count is saved in a separate small diagnostic file,
at most once a minute and when the listener stops. Unknown app claims are not counted;
a crash can lose the unsaved batch. These are facts, not a health or availability verdict.

## Receive and report work

Ordinary comments and issue changes addressed to the app arrive through
inbox notifications. They share the agent's main context and do not require a
delegation or an open work session. The agent can reply with an ordinary comment
or decide that no response is needed.

Only requests addressed to the agent wake it: a mention, a work session, or a
reply in a comment thread the agent started or replied in. Other notifications
are context: other new comments, status changes, unassignment and team-access
changes. If the agent is working, they join that work; otherwise they wait and
arrive the next time it wakes. Waiting context does not count as queued work and
does not hold up a restart. If a mention or a work session later addresses a waiting
comment, the agent wakes for that request instead. A direct comment mention can also wake the
agent when Anima cannot yet match it to a work session, including mentions from another
app. The agent replies in the original comment thread. When Anima can match the mention
to a work session before delivery, it uses that session instead. A comment delivered
before its session arrives is not delivered again. The late session gets one receipt
pointing to the original thread, and its Stop still reaches the comment's queued or
running work. That receipt does not claim completion; subsequent replies stay in the
comment thread, without automatic session progress or a second reply obligation.
A Stop gets an end notice confirming the stop request, without claiming that earlier
actions or provider background work have been undone.
Anima filters overlapping notifications, self-authored activity
and delivery retries. Permission-change
notifications report added and removed team access. Reactions do not wake
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

Anima leaves issue status unchanged when a delegation arrives or a run starts. The
agent chooses when to update issue status as it begins and completes the work. The
agent reports a response, question or error, and can attach a PR link.
A question ends the current status updates until a new prompt arrives.
An agent can also start work without a mention or delegation: `anima linear start --issue <id>`
opens a session and posts its initial progress from stdin. It can target an existing comment
with `--comment <uuid>`. The session belongs to the app and shares the agent's current
working context; a creation webhook matching the recorded session does not wake the agent again.
If creation was uncertain and no session ID was recorded, the webhook follows normal intake. Human replies still wake the agent.
When the initial prompt identifies the app itself as the delegator, Anima sends
**Received by Anima** and links the session without waking the agent again. Later human
prompts in that session wake it normally. If the origin cannot be confirmed, the session
follows normal intake.
For longer work, the agent can send progress with `anima linear reply --kind thought`
and send its final response in a later turn, for example after background work finishes.

While a request is queued or its run is executing, the runtime posts a fixed queued/executing
status after 10 minutes without a successful activity. Failed status sends are attempted at
most once per 10-minute interval. Once the run ends, the runtime says nothing more: only the
agent's response, question or error finishes the request. If Anima has no recorded reply and
the session has had no recorded activity for 30 minutes, the agent's Linear row in the dashboard
counts it as a session with no recorded reply. This uses Anima's records, not Linear's session
state; Linear may show the session as stale. Check the session in Linear: reply there to wake
the agent again, or stop it. A crashed or interrupted run still gets one error notice.

After a runtime restart, interrupted background work gets a durable recovery wake. The agent
checks earlier effects before continuing; native background tasks are not automatically
resumed or rerun. During downtime or failed status sends, Linear can also display the session
as stale; a later activity recovers it.
See [Linear’s interaction guidance](https://linear.app/developers/agent-best-practices).

Linear's stop signal cancels pending work or requests interruption of its associated run.
A primary run can contain other accepted messages; interrupting it may affect them too.
Changes made through `anima linear api`, including adding a PR link, use Linear's
permissions and are not blocked by Anima's local Stop checks.
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

**Disconnect**, in the agent's Linear dialog, stops local intake and authorized writes and
clears local credentials. It does not uninstall the app in Linear. Revocation in Linear, a
definite API authorization failure, or a token renewal that Linear answers with
`invalid_grant` marks the local identity revoked; authorize again with the same app to
resume, or disconnect to start over. Other renewal failures, including `invalid_client`,
other or unreadable error responses, server errors and network failures, keep the
installation and its tokens. Writes that failed are not resent automatically.

Installations made before Anima stored the client secret show **Client secret: Not stored**
under **Manage** and keep renewing access without it while Linear allows that. If Linear
answers a renewal with `invalid_client`, the row shows **Credentials not accepted** and the
dialog asks for the secret. Select **Add** (or **Replace** for a stored secret that Linear
no longer accepts), paste the **Client secret** from the app's page in Linear and select
**Save**. Anima checks it by renewing access with Linear and stores the secret only together
with the renewed tokens. A secret Linear rejects, an unreachable or failing Linear, or a
renewal whose result could not be stored leaves the stored connection unchanged, and the
dialog says which happened. If a renewal could not be stored, Linear may already have
replaced the old tokens: try again, and authorize again if Linear has ended the
authorization. If Linear answers `invalid_grant`, authorize again.

Runtime credentials are separate from provider launch environments, prompts and public API
responses. The credential file uses mode `0600`. This protects it from other OS users, not
from processes running as the same user. Include it in your private runtime backup policy;
never attach it to a support report.

An accepted external activity and local audit failure are different outcomes. If the
response to a session activity is lost, Anima stores an unknown result and checks that
activity before a retry. It does not blindly resend. An unavailable lookup is not proof that nothing was sent.

Protocol references: [app manifests](https://linear.app/developers/oauth-app-manifests),
[OAuth](https://linear.app/developers/oauth-2-0-authentication),
[webhooks](https://linear.app/developers/webhooks),
[agent interactions](https://linear.app/developers/agent-interaction),
[stop signals](https://linear.app/developers/agent-signals).
