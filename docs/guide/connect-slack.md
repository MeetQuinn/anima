---
title: Connect an agent to Slack
description: Create the generated Slack app, install it, and connect its two tokens to one Anima agent.
---

# Connect an agent to Slack

Each Anima agent has its own Slack app and bot identity. This setup is per agent, not per Anima installation.

Start from the **Connect to Slack** step during agent creation. For an existing unconnected agent, open its **Profile** tab and find the Slack section.

## Before you start

You need permission to create and install an app in the target Slack workspace. If workspace policy requires administrator approval, arrange that before creating the agent.

The dashboard generates the app manifest. Use that generated flow instead of assembling scopes, events, Socket Mode, and interactivity by hand.

## 1. Create and install the app

Select **Create app in Slack** in the dashboard. Slack opens with the generated manifest already filled in.

1. Choose the target workspace.
2. Review the requested app configuration.
3. Select **Install** or **Install to Workspace** and approve the app.
4. Return to Anima.

If you reuse an older Slack app, its manifest must match Anima's current requirements and Interactivity must be enabled. Creating a new app is the reliable first-install path.

## 2. Add the App-Level Token

In the Slack app settings:

1. Open **Basic Information**.
2. Under **App-Level Tokens**, generate a token.
3. Give it the `connections:write` scope.
4. Copy the token beginning with `xapp-` into **App-Level Token** in Anima.

Anima validates the token with Slack. Wait for the verified state before continuing.

## 3. Add the Bot User OAuth Token

In the same Slack app:

1. Open **OAuth & Permissions**.
2. Install or reinstall the app to the workspace if Slack asks.
3. Copy **Bot User OAuth Token**, beginning with `xoxb-`.
4. Paste it into the matching Anima field.

Anima checks each token, then verifies that both came from the same Slack app. The connection completes automatically when the pair is valid.

Treat both values as credentials. Put them only into the dashboard fields. Do not paste them into Slack, source files, screenshots, or support messages.

## 4. Pick the owner

Choose the person responsible for the agent. The owner is its main point of contact and the person who steers onboarding. The owner is not an access-control boundary.

After confirmation, the agent sends the owner a DM. Reply there to start work.

## Use the agent in channels

Invite the bot to a channel with Slack's normal `/invite` command. Once present, it follows that channel. An @mention is the most reliable way to wake it for a specific request.

Slack does not allow bot-to-bot DMs. Agents reach each other by @mention in a shared channel or thread.

## Troubleshooting

### The token is in the wrong field

The dashboard detects the prefix and tells you where it belongs: `xapp-` is the App-Level Token and `xoxb-` is the Bot User OAuth Token.

### The App-Level Token is rejected

Regenerate it with `connections:write` enabled.

### The tokens are valid but do not connect

They may belong to different apps. Copy both tokens again from the same Slack app.

### Slack behavior changed after an Anima update

Open the agent's Profile tab. If the app manifest needs newer scopes, events, or shortcuts, Anima shows a manifest-update card with the exact replacement YAML and any reinstall step.

## What is stored

The Slack app credentials are stored locally in the agent configuration and injected into that agent at runtime. The dashboard hides secret values after setup. See [Security and data](../security-and-data.md) for the host and credential boundaries.

