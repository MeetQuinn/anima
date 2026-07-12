---
title: Back up and restore
description: Preserve Anima runtime state, agent homes, team files, and external credentials as separate authorities.
---

# Back up and restore

An Anima installation has more than one durable root. A useful backup must preserve the selected
Anima home and every configured team or agent home. Provider credentials and chat-platform apps live
outside both and need their own recovery plan.

Anima does not currently provide a single backup command. Use ordinary filesystem backup tools and
keep the copy encrypted.

## Inventory the authorities

Before copying anything, record these paths and systems:

| Authority                  | Where to find it                   | What it owns                                                       |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Anima home                 | **Server** -> **Home**             | config, agent records, queues, sessions, activity, reminders, logs |
| Team homes                 | team switcher edit view            | shared files and default location for future agents                |
| Agent homes                | each agent **Profile** -> **Home** | `MEMORY.md`, notes, local skills, and working files                |
| Knowledge bases            | sidebar knowledge-base entries     | registered shared folders, which may live outside the team home    |
| Provider credential stores | provider-owned host-user config    | provider login, account choice, plugins, MCP, and provider history |
| Slack or Feishu apps       | platform administration            | app identity, installation, permissions, and availability          |

The managed package under `$ANIMA_HOME/runtime/current` is reconstructable. The other Anima-home
records are not. Team, agent, and knowledge-base folders can point anywhere, so do not infer their
coverage from the Anima home path.

## Create a consistent backup

1. Wait for agents to become idle.
2. Record status and the serving version:

   ```bash
   export ANIMA_HOME=/absolute/path/from-the-server-panel
   npx -y @meetquinn/animactl@latest status
   ```

3. Stop the local services from an external shell:

   ```bash
   npx -y @meetquinn/animactl@latest stop
   ```

4. Copy the complete Anima home, excluding `runtime/current` only if your backup tool has an explicit
   rule to reinstall it later.
5. Copy every team home, agent home, and knowledge-base folder from the inventory.
6. Preserve file permissions and symbolic links.
7. Restart the original installation and verify it before moving the backup elsewhere:

   ```bash
   npx -y @meetquinn/animactl@latest start --no-browser
   ```

Do not copy while the worker is actively changing queues, sessions, or activity files and then call
the result a consistent snapshot. A filesystem snapshot facility can reduce downtime, but the
services should still be idle or stopped at the snapshot boundary.

## Protect the backup

The Anima home can contain Slack or Feishu tokens, agent env values, message records, asks, and
provider-related diagnostics. Agent and team homes can contain private source code, memory, and
secrets stored by the team.

- encrypt the archive or backup destination
- restrict access to the same operator boundary as the live host
- avoid public cloud links without access controls and retention policy
- do not attach a complete Anima home to a support issue
- test restore access without printing secret values

The managed runtime package is not the sensitive part. The state and working files are.

## Restore on the same machine

1. Stop services for the target Anima home.
2. Move the damaged directory aside instead of overwriting the only remaining copy.
3. Restore the Anima home to its original absolute path with permissions intact.
4. Restore every team, agent, and knowledge-base folder to the paths recorded in config.
5. Reinstall and start the managed runtime:

   ```bash
   ANIMA_HOME=/restored/anima-home \
     npx -y @meetquinn/animactl@latest start --no-browser
   ```

6. Reinstall OS service definitions if this home previously used them:

   ```bash
   ANIMA_HOME=/restored/anima-home \
     npx -y @meetquinn/animactl@latest install-services
   ```

The npm package can be newer than the backed-up package cache. If version compatibility matters for
an incident replay, target the exact recorded version first, verify, then perform a normal update.

## Move to another machine or host user

A filesystem copy does not move every dependency. Before starting the restored agent service:

1. Restore team, agent, and knowledge-base folders at the same paths when possible.
2. If paths must change, start only the web service before installing OS service definitions:

   ```bash
   ANIMA_HOME=/restored/anima-home \
     npx -y @meetquinn/animactl@latest services start --only web
   ```

   Use the dashboard to update each team and agent home to an existing directory. Re-register any
   knowledge base that cannot keep its previous root, verify the files, then stop the web service.

3. Install each provider CLI under the new host user.
4. Restore provider-owned configuration according to that provider's supported method or sign in
   again. Do not assume copying an agent home transfers provider authentication.
5. Confirm Slack or Feishu app credentials and platform installations are still valid.
6. Reinstall OS service definitions so they reference the new user, home, runtime, and PATH.
7. Keep the old host stopped while validating the new one. Two hosts using the same bot credentials
   can compete for event delivery.

Changing the host user can also change home-relative paths, provider credential stores, and file
ownership. Treat it as a migration, not as a simple runtime update.

## Verify a restore

Check the restored authorities one by one:

- **Server** shows the intended Anima home and runtime version.
- Teams, agents, knowledge bases, and sidebar order appear.
- Agent Profiles point at the expected homes and provider settings.
- `MEMORY.md`, notes, skills, and shared files open from the dashboard.
- Queued and past activity records are present.
- Slack or Feishu connections validate under the intended apps.
- Each provider starts under the intended host account.
- One ordinary inbound and outbound message succeeds.

Do not declare the restore complete from a healthy dashboard alone. The dashboard proves the web and
runtime state loaded; it does not prove external apps, provider accounts, or every filesystem path.

## Related operations

- [Runtime and services](/deployment)
- [Recover local services](/service-runbook)
- [Security and data](/security-and-data)
