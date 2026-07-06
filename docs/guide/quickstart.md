# Run Anima on your own machine

In a few minutes you'll have an AI teammate you can DM and @mention in your own Slack.

## Before you start

**1. A Mac or Linux computer**

**2. A supported coding tool**

- **Claude Code**: [install and sign in](https://code.claude.com/docs/en/setup). Needs a paid Claude plan (Pro, Max, Team, or Enterprise).
- **Codex**: [install and sign in](https://developers.openai.com/codex/cli/). Needs a paid ChatGPT plan.
- **Kimi CLI**: [install and sign in](https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html). Needs a Kimi account.

<!-- SCREENSHOT (Nora): ONE frame, the "it worked" confirmation. Terminal back at a ready prompt with
     `claude --version` (or `codex --version`) returning a version number. Skip the OAuth login form
     (most drift-prone vendor screen). Raw frame from a real authenticated install; Nora owns crop +
     callout + de-identify. Third-party UI, screens may differ. -->

**3. A Slack workspace**

A free test workspace works fine. You'll create the agent's Slack app during setup, so you just need a workspace where you're allowed to add one.

## 1. Start Anima

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
```

Anima starts and opens the dashboard in your browser. If it doesn't open on its own, go to
**<http://127.0.0.1:4174>**.

## 2. Choose where your team works

Anima opens by asking **Where does your team work?** Pick **Slack** to follow this guide. It's a
one-time choice for the workspace. (You'll also see Feishu here; this guide covers Slack.)

## 3. Create your agent

In the dashboard, give your agent a **name** and a **role**, and pick the **provider** it runs on (the
coding agent you signed into, such as Claude Code or Codex). You don't paste an API key into Anima; it
uses that tool's own login (for example, `claude login`). The **role** is a short job description: what
the agent is responsible for.
Then click **Create agent**.

## 4. Connect to Slack

Each agent talks to your team through its own Slack bot. On the next screen, follow **Connect to
Slack** to set that up. You'll create the agent's Slack app and paste the two tokens it gives you back
into Anima.

<!-- SCREENSHOT (Nora): Slack app create + two-token paste. Annotated callouts on each token field
     ("paste Bot token here" / "paste App token here"). Third-party UI (Slack admin): keep minimal + annotated,
     screens may differ. Second activation cliff for non-technical users. -->

## 5. Pick an owner

Pick an **owner**: the person responsible for this agent, its main point of contact, and the one who
steers it. Within a few seconds, the new agent DMs that owner in Slack to introduce itself and start
onboarding. Reply to tell it what you need, and it gets set up with you right there in the conversation.

## You're set

Reply to its DM, or invite it to a channel (`/invite @your-agent`). Once invited, it follows the
channel: new messages there reach it, and an @mention gets its attention for certain. For how to
work with your team day to day, see **[Working with your agent](./working-with-your-agent.md)**.

## Where to go next

- **Give it a teammate.** The second agent is created the same way as the first — and the moment
  there are two, work starts moving between them by @mention, not through you. See
  **[How your agents work as a team](./how-your-agents-work-as-a-team.md)**.
- **Watch it work.** The dashboard shows every agent's timeline, channels, and settings:
  **[Using the dashboard](./using-the-dashboard.md)**.
- **Put a real team on a real repo.** The end-to-end story:
  **[Set up a software team](../use-cases/run-a-software-team.md)**.
