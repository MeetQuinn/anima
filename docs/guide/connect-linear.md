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
one app per agent. Select **Agent session events**. Linear sends app revocation events automatically;
leave unrelated data and OAuth authorization events off. Anima
requests `read`, `write`, `app:assignable` and `app:mentionable` with `actor=app`.

You provide the public HTTPS ingress yourself. Anima does not create a tunnel, relay or
public domain. Forward only the public webhook URL to the configured local listener's
`/webhook` path. Do not forward dashboard routes through that listener.

## Install from the dashboard

1. Open the agent's **Profile**, then **Linear → Add Linear app**.
2. Enter the app's client ID and webhook signing secret. Do not paste the secret into chat.
3. Register the displayed **OAuth callback URL** in the Linear app. The callback uses the
   existing dashboard, not the webhook port; it must be reachable from your browser.
   Use HTTPS or a loopback HTTP address. An HTTP hostname such as `mini` is not a callback.
4. Select the listener address and port. Loopback is the default; all installed agents
   share one listener, on a port separate from the dashboard. If you expose it through a
   reverse proxy, keep the raw request body and `Linear-Signature` header unchanged.
5. Register your public webhook URL in Linear. Select **Prepare authorization**, then
   **Authorize in Linear** and approve the app. Refresh Profile after the callback completes.

Installation uses PKCE and a state tied to the current dashboard session. It expires after
10 minutes and can be used once. If authorization fails or expires, remove the pending
connection and prepare a new one. There is no separate CLI installation flow.

**App installed** records the verified app identity. It does not prove that ingress is reachable.
The setting shows the last verified, signed webhook received and the number of rejected
signature claims naming this app. The count is saved in a separate small diagnostic file,
at most once a minute and when the listener stops. Unknown app claims are not counted;
a crash can lose the unsaved batch. These are facts, not a health or availability verdict.

## Receive and report work

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
If a model run ends without a confirmed Linear response, the runtime reports that gap
as an error instead of leaving the conversation marked as working.

After 10 minutes without a successful activity, the runtime can post a fixed queued/executing
status for owned pending work. This is not a percentage or promise of progress. It stops on
response, question, failure, cancellation or settlement. Background or unrelated results do
not keep a Linear conversation active.

Linear's stop signal cancels pending work or requests interruption of its associated run.
A primary run can contain other accepted messages; interrupting it may affect them too.
The runtime reports that boundary rather than replaying accepted input automatically.
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

Protocol references: [OAuth](https://linear.app/developers/oauth-2-0-authentication),
[webhooks](https://linear.app/developers/webhooks),
[agent interactions](https://linear.app/developers/agent-interaction),
[stop signals](https://linear.app/developers/agent-signals).
