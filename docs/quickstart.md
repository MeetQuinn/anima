# Run Anima on your own machine

Get Anima running locally and meet your first agent — an AI teammate you can DM and @mention in
your own Slack. No coding required: one terminal command, then click through the rest in your
browser.

## Before you start

You'll need:

- **Node.js 20+** (so you can run `npx`)
- **A coding-agent CLI, installed and logged in** — Claude Code, Codex, or Kimi. This is what
  your agent runs on; you pick which one when you create the agent.
- **A Slack workspace you can install an app into** (a free test workspace works fine)

## 1. Start Anima

```bash
npx @totoday/animactl start
```

This downloads the managed runtime, installs it under `~/.anima/runtime/current`, and starts the
agent runtime plus the web control panel. Config and state live in `~/.anima/` by default, so Anima
keeps working no matter which directory your terminal is in. Open the control panel:
**<http://127.0.0.1:4174>**

## 2. Create your agent

In the control panel, fill in a **name** and a **role**, and click **Create**.

## 3. Connect it to Slack

The **Connect Slack** panel walks you through Slack app setup. You'll hop between the panel and
Slack's app site, pasting two tokens back into Anima:

1. **Create app** → pick your workspace → **Install**.
2. **Basic Information → App-Level Tokens** → generate one with scope `connections:write` → paste
   the `xapp-…` token into Anima.
3. **OAuth & Permissions → Install to Workspace** → paste the **Bot User OAuth Token** (`xoxb-…`).
   Anima connects automatically.
4. Assign an **Owner** from the member list. If **Notify the new owner now** is on, the agent DMs
   them to introduce itself.

Tokens are stored only in `~/.anima/`. The agent comes online automatically. If you left owner
notification on, it will **DM the owner in Slack** within a few seconds to introduce itself. 🎉

## Play with it

- Reply to its DM.
- Invite it to a channel (`/invite @your-agent`) and @mention it.
- Watch the **Activity** tab to see everything it does — every action is logged.

## Handy commands

```bash
npx @totoday/animactl status     # is it running?
npx @totoday/animactl restart    # restart the agent + web services
npx @totoday/animactl stop       # stop it
```

Logs: `~/.anima/logs/agent.log` and `~/.anima/logs/web.log`.

## Troubleshooting

- **No DM from the agent?** Check that it shows as connected in the control panel.
- **No reply when you @ it in a channel?** Invite the bot first: `/invite @your-agent`.
- **Changed an existing agent's provider/model/role/tokens and nothing happened?** Restart to pick it
  up — a running agent doesn't hot-reload its config.
