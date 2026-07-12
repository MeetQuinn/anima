---
title: Run your first agent
description: Install Anima, connect a provider and team chat, and receive the first message from your agent.
---

# Run your first agent

This guide ends with a named agent you can message in Slack or Feishu. The setup happens once on a Mac or Linux machine you control. Teammates do not install Anima themselves.

## Before you start

You need:

- **Node.js 20 or newer.** The installer uses Node and npm to download the managed runtime.
- **One supported provider CLI, installed and signed in.** Use Claude Code, Codex CLI, or Kimi CLI. [Set up a provider](./providers.md) before starting Anima.
- **A Slack workspace or Feishu tenant.** You must be allowed to add an app. A test environment is enough for evaluation.

Anima uses the provider's existing local login. Do not paste a Claude, Codex, or Kimi login credential into Anima or team chat.

## 1. Install and start Anima

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
```

The command installs the managed runtime under `~/.anima/runtime/current`, starts the local services, and opens the dashboard. If the browser does not open, go to <http://127.0.0.1:4174>.

The dashboard binds to loopback by default. Anima does not create a hosted account or upload your runtime state to an Anima service.

## 2. Choose the team chat

The first screen asks **Where does your team work?** Choose **Slack** or **Feishu**. Anima remembers the choice and uses the matching setup sequence for new agents.

## 3. Create the agent

Enter:

- a **name** teammates will recognize;
- a **role** that states what the agent owns; and
- the **provider**, model, and reasoning level it should use.

Anima checks the host for the provider executables on `PATH`. A missing provider cannot be selected. The default agent home is shown under **Home**; leave it unchanged for the first agent unless you already have a team directory plan.

Select **Create agent**. The agent now exists locally but cannot receive team messages until its chat app is connected.

## 4. Connect the chat app

Follow the setup path you chose:

- **[Connect Slack](./connect-slack.md):** create the generated Slack app, install it, and paste its App-Level and Bot User tokens into the dashboard.
- **[Connect Feishu](./connect-feishu.md):** let Anima create the app, confirm it in Feishu, then authorize and publish the recommended permissions.

Secret token fields belong in the dashboard setup form, not in a DM, channel, issue, or terminal transcript.

## 5. Start the first conversation

For Slack, pick the agent's **owner** after the connection succeeds. The agent sends that person a DM and begins onboarding.

For Feishu's automatic app-creation path, the person who confirms the app becomes the owner and receives the onboarding conversation. If you connect an existing Feishu app instead, start the first conversation yourself; that fallback does not know which person should receive an automatic greeting.

Reply with a real responsibility, repository, or first task. The agent's Activity view should show the incoming message and provider work.

## Verify the installation

You are done when all four are true:

1. The dashboard lists the agent without a provider warning.
2. The Profile tab shows Slack or Feishu as connected.
3. A message to the agent appears in Activity.
4. The agent replies in the same chat surface.

If provider setup fails, use [Provider setup and identity](./providers.md). If the app connection fails, return to the agent's Profile tab and use the Slack or Feishu connection section there.

## Next

- [Work with your agent](./working-with-your-agent.md)
- [Understand the security and data boundaries](../security-and-data.md)
- [Use the dashboard](./using-the-dashboard.md)
