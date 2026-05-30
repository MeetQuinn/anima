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
npx -y @meetquinn/animactl start
```

This downloads the managed runtime, installs it under `~/.anima/runtime/current`, and starts the
agent runtime plus the dashboard. Config and state live in `~/.anima/` by default, so Anima
keeps working no matter which directory your terminal is in. On a local desktop, Anima opens the
dashboard automatically. If it does not, open:
**<http://127.0.0.1:4174>**

## 2. Create your agent

In the dashboard, fill in a **name** and a **role**, and click **Create**.

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
npx -y @meetquinn/animactl status     # is it running?
npx -y @meetquinn/animactl dashboard  # open the dashboard
npx -y @meetquinn/animactl restart    # upgrade to latest, then restart the agent + web services
npx -y @meetquinn/animactl stop       # stop it
```

Use `restart` for command-line upgrades: it installs the package version selected by `npx` into
`~/.anima/runtime/current`, then restarts the services. With no version suffix, `npx` selects the
`latest` npm dist-tag.

Logs: `~/.anima/logs/agent.log` and `~/.anima/logs/web.log`.

## Troubleshooting

- **No DM from the agent?** Check that it shows as connected in the dashboard.
- **No reply when you @ it in a channel?** Invite the bot first: `/invite @your-agent`.
- **Changed an existing agent's provider/model/role/tokens and nothing happened?** Restart to pick it
  up — a running agent doesn't hot-reload its config.
