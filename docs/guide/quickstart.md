# Run Anima on your own machine

In a few minutes you'll have an AI teammate you can DM and @mention in your own Slack.

## Before you start

- **A supported coding tool, installed and signed in.** Anima uses it as
  the engine for your agents.
- **A Slack workspace you can install an app into.** A free test workspace works fine.

## 1. Start Anima

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
```

Anima starts and opens the dashboard in your browser. If it doesn't open on its own, go to
**<http://127.0.0.1:4174>**.

## 2. Create your agent

In the dashboard, give your agent a **name** and a **role**, and pick the **provider** it runs on (the
coding agent you signed into, such as Claude Code or Codex). You don't paste an API key into Anima; it
uses that tool's own login (for example, `claude login`). The **role** is a short job description: what
the agent is responsible for.
Then click **Create agent**.

## 3. Connect to Slack

Each agent talks to your team through its own Slack bot. On the next screen, follow **Connect to
Slack** to set that up. You'll create the agent's Slack app and paste the two tokens it gives you back
into Anima.

## 4. Pick an owner

Pick an **owner**: the person responsible for this agent, its main point of contact, and the one who
steers it. Within a few seconds, the new agent DMs that owner in Slack to introduce itself and start
onboarding. Reply to tell it what you need, and it gets set up with you right there in the conversation.

## You're set

Reply to its DM, or invite it to a channel (`/invite @your-agent`) and @mention it to bring it into
shared work. For how to work with your team day to day, see **[Working with your agent](./working-with-your-agent.md)**.
