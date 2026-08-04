---
title: Connect external events through Slack
description: Route external tools like uptime monitors, CI, and error trackers into Slack, explicitly mention the responding agent, and keep a human gate on anything destructive.
---

# Connect external events through Slack

External tools have things to tell your team: a monitor goes down, a build fails, an error spikes. The usual way to deliver those events to software is an inbound webhook. Anima takes a different path, and it is a better fit for how agents already work.

## The frame (why Slack, not a webhook)

Anima runs on your own machine. There is no public IP and nothing listening on your machine for inbound traffic, so a classic inbound webhook has nowhere to land. That is a feature, not a gap: there is no inbound surface to secure.

External events reach your agents through Slack. An external tool posts a message into a shared channel and explicitly mentions the agent that should handle it. Same path a human teammate uses, no new attack surface, no port to open.

**Pattern in one line:** an external event posts to Slack with an explicit `@agent` mention, that agent wakes and responds, and a human holds the gate on anything destructive.

## Two hard rules (read these first)

These two are the difference between "works" and "silently does nothing" or "leaks a credential."

### Rule 1: use the official Slack app and explicitly mention the responding agent

When you connect a tool to Slack you'll usually see two options. Pick an official Slack app whose alert template can include a Slack mention: use the "Add to Slack" button that asks you to authorize it, then configure its plain-text alert summary to mention the responding agent. Don't pick "Incoming Webhook," the option that hands you a URL to paste somewhere. If an app cannot include the mention, its alerts remain visible in Slack but do not wake an agent.

Why both parts matter:

- Top-level bot/app messages do not trigger passive channel follows. This prevents one automated post from waking every agent that happens to follow the channel. The alert must explicitly mention the agent you want. Replies inside an already-followed, unmuted thread can continue that thread, but alerts should not rely on follow state.
- A webhook posts in a shape Anima cannot route at all. The alert can land in Slack and look normal while no agent responds.

Three-glance test that you did it right:

- The tool shows up in your channel as an app you authorized, not a one-off URL you pasted.
- The alert's plain text includes the responding agent's Slack mention.
- Fire a test alert and confirm that only the mentioned agent wakes. A rich card with no summary text or mention will stay quiet.

If your agent is not waking, check the mention and plain-text summary first, then confirm that you connected the official app rather than an incoming webhook.

::: details For the curious: why a webhook can't wake your agent
Anima does not support an incoming webhook as a wake source. Even when its post appears in Slack, it does not provide the bot-user and direct-mention event shape this integration requires. A mention-capable official app can provide that shape; without the mention, its top-level bot-authored post intentionally stays silent.
:::

### Rule 2: never paste an API token into Slack

When you connect a monitoring tool you may get an API token for teardown or automation. Keep it in a private location on your own machine. Never paste it into a Slack message, channel or DM. A token pasted into Slack is an exposed credential and must be rotated. Treat Slack as the event bus, not the secret store.

## Worked example: monitoring and alerting

Goal: when a monitor detects a problem, an agent wakes in your Slack, triages it, and recommends a next step, while a human stays in control of any action that touches production.

1. **Pick a monitoring tool with a mention-capable native Slack app.** Use a real "Add to Slack" / OAuth integration whose plain-text alert template can mention the responding agent, not a raw incoming webhook (see Rule 1).
2. **Make a channel for the alerts** (we used `#alerts-demo`) and add both the monitoring tool's Slack app and the agent you want to respond.
3. **Configure the alert summary to mention the agent.** When an incident fires, the tool posts an alert card whose plain-text summary includes `@agent`. That direct mention wakes the responder; the channel post alone does not.
4. **The agent triages.** A good responder reply has a clear spine: acknowledge, state what fired, give severity, add context, recommend a next step, and name the human gate explicitly. Here is an example:

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

5. **The human holds the gate.** The agent triages and recommends. It does not restart, roll back, or make destructive changes on its own. You decide.

If you want both ends of the incident lifecycle handled, include the same explicit agent mention in the open alert and the auto-resolve notification.

## What this gives you

- No inbound surface. External events reach your agents through Slack, the way a teammate does.
- The whole exchange happens in the Slack the team already uses, on one shared context, in the open.
- A human gate on anything that touches production, by default.
