# Run Anima on your own machine

In a few minutes you'll have an AI teammate you can DM and @mention in your own Slack.

## Before you start

You need two things ready first. The coding tool is the more involved one, so start there.

### A supported coding tool, installed and signed in

This is the engine your agents run on. Your agents think and act through a coding tool that lives
on your own machine. You sign into that tool once, and Anima uses that sign-in. You never paste an
API key into Anima.

Don't have one yet? Install and sign into one of these, then come back here:

- **Claude Code**: [install and sign in](https://code.claude.com/docs/en/setup). After it's
  installed, run `claude` in your terminal and follow the browser prompt to log in. Needs a paid
  Claude plan (Pro, Max, Team, or Enterprise).
- **Codex**: [install and sign in](https://developers.openai.com/codex/cli/). After it's installed,
  run `codex` in your terminal and sign in with your ChatGPT account. Needs a paid ChatGPT plan.

To confirm it's ready, run `claude --version` (or `codex --version`). You should see a version
number, not an error.

<!-- SCREENSHOT (Nora): ONE frame — the "it worked" confirmation. Terminal back at a ready prompt with
     `claude --version` (or `codex --version`) returning a version number. Skip the OAuth login form
     (most drift-prone vendor screen). Raw frame from a real authenticated install; Nora owns crop +
     callout + de-identify. -->

This is the most technical step in the whole setup. If you can install an app and sign into it, you
can do this. Give it a few minutes. The tool's own page (linked above) walks you through it, and its
screens may differ from any image here.

### A Slack workspace you can install an app into

A free test workspace works fine. You'll create the agent's Slack app during setup, so you just need
a workspace where you're allowed to add one.

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
into Anima. Anima tells you which token goes in which field, so copy each one across as you go.

<!-- SCREENSHOT (Nora): Slack app create + two-token paste. Annotated callouts on each token field
     ("paste Bot token here" / "paste App token here"). Third-party UI (Slack admin): keep minimal + annotated.
     This is the second activation cliff for non-technical users. -->

The Slack app screens are Slack's own, so they may look a little different from any image here.

## 5. Pick an owner

Pick an **owner**: the person responsible for this agent, its main point of contact, and the one who
steers it. Within a few seconds, the new agent DMs that owner in Slack to introduce itself and start
onboarding. Reply to tell it what you need, and it gets set up with you right there in the conversation.

## You're set

Reply to its DM, or invite it to a channel (`/invite @your-agent`) and @mention it to bring it into
shared work. For how to work with your team day to day, see **[Working with your agent](./working-with-your-agent.md)**.
