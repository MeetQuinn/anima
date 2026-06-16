---
title: Connect external events through Slack
description: Route external tools like uptime monitors, CI, and error trackers into Slack so your agents wake, triage, and respond, with a human holding the gate on anything destructive.
---

# Connect external events through Slack

External tools have things to tell your team: a monitor goes down, a build fails, an error spikes. The usual way to deliver those events to software is an inbound webhook. Anima takes a different path, and it is a better fit for how agents already work.

## The frame (why Slack, not a webhook)

Anima runs on your own machine. There is no public IP and nothing listening on your machine for inbound traffic, so a classic inbound webhook has nowhere to land. That is a feature, not a gap: there is no inbound surface to secure.

External events reach your agents the way a teammate does: through Slack. An external tool posts a message into a Slack channel your agent is in, and the agent wakes on that message and acts on it. Same path a human teammate uses, no new attack surface, no port to open.

**Pattern in one line:** an external event posts to a Slack channel an agent watches, the agent wakes and responds, and a human holds the gate on anything destructive.

## Two hard rules (read these first)

These two are the difference between "works" and "silently does nothing" or "leaks a credential."

### Rule 1: connect the tool with its official "Add to Slack" button, not a webhook URL

When you connect a tool to Slack you'll usually see two options. Pick the official Slack app: the "Add to Slack" button that asks you to authorize it. Don't pick "Incoming Webhook," the option that hands you a URL to paste somewhere.

Why it's make-or-break: only messages that arrive through the official app will wake your agent. A webhook posts in a way Anima can't see, so the alert lands in the channel, looks completely normal, and your agent just never responds. Nothing errors. It silently does nothing.

Two-glance test that you did it right:

- The tool shows up in your channel as an app you authorized, not a one-off URL you pasted.
- Fire a test alert: it should show a plain text summary line, not only a card. (A rich card with no summary line won't wake the agent either, even through the official app.)

If your agent isn't waking, this is almost always why. Reconnect using "Add to Slack."

::: details For the curious: why a webhook can't wake your agent
Anima only wakes an agent for a message that posts as a `user`. The official app posts under its bot-user identity, so its message carries a `user` field. An incoming webhook posts as the app, not as a user, so its message has a `bot_id` and no `user` field, and the agent never wakes. This holds whether the webhook is a legacy custom integration or a modern app-scoped one: a webhook is never a user. The message must also carry non-empty top-level text or a file. Most tools set a fallback summary, but a blocks-only card with empty text won't wake the agent even from a proper app.
:::

### Rule 2: never paste an API token into Slack

When you connect a monitoring tool you may get an API token for teardown or automation. Keep it in a private location on your own machine. Never paste it into a Slack message, channel or DM. A token pasted into Slack is an exposed credential and must be rotated. Treat Slack as the event bus, not the secret store.

## Worked example: monitoring and alerting

Goal: when a monitor detects a problem, an agent wakes in your Slack, triages it, and recommends a next step, while a human stays in control of any action that touches production.

1. **Pick a monitoring tool with a native Slack app.** We used Better Stack Uptime. Anything with a real "Add to Slack" / OAuth integration works (status pages, error trackers, CI). A raw incoming webhook does not (see Rule 1).
2. **Make a channel for the alerts** (we used `#alerts-demo`) and add both the monitoring tool's Slack app and the agent you want to respond. The agent's subscription to the channel is created automatically the first time a message lands there.
3. **Point the monitor at the channel.** When an incident fires, the tool posts an alert card into the channel. That post wakes the responding agent.
4. **The agent triages.** A good responder reply has a clear spine: acknowledge, state what fired, give severity, add context, recommend a next step, and name the human gate explicitly. Here is the reply from our drill:

   > Ack. I'm on the Better Stack alert.
   >
   > What fired: `Anima Slack wake drill` reported a new incident for `https://anima-better-stack-drill.invalid/`.
   >
   > Severity: **drill / expected failure**, not production impact. This URL was deliberately invalid so we could prove external monitoring alerts wake an agent through Slack.
   >
   > Quick context: this follows the Better Stack OAuth connection test; the monitor was created a few minutes ago for the controlled-failure drill. No recent release or service change is implicated.
   >
   > Recommended next step: mark this as a successful drill, then remove the test monitor and rotate the temporary API token.
   >
   > Human gate: I will not restart, rollback, or make any destructive production change without explicit human approval.

   ![The #alerts-demo channel showing a Better Stack incident alert card with the monitor name, cause, and checked URL, followed by the agent's triage reply: an acknowledgement, what fired, severity, context, a recommended next step, and an explicit human-gate line.](/use-cases/alerts-slack-exchange.png)

   *The exchange in `#alerts-demo`: the incident alert, then the agent's triage reply.*

5. **The human holds the gate.** The agent triages and recommends. It does not restart, roll back, or make destructive changes on its own. You decide.

Both ends of the incident lifecycle wake the agent: the open alert and the auto-resolve notification carry the same routable shape, so the agent can both raise an incident and stand down.

## What this gives you

- No inbound surface. External events reach your agents through Slack, the way a teammate does.
- The whole exchange happens in the Slack the team already uses, on one shared context, in the open.
- A human gate on anything that touches production, by default.
