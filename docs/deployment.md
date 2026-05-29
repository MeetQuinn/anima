# Deployment And Upgrades

This document describes the npm-era deployment model. The goal is to keep development, dogfood, and
stable user installs isolated from each other.

## Environments

| Environment | Code source | Anima home | Purpose |
| --- | --- | --- | --- |
| Development | Source checkout, usually `~/anima` | Repo-local `./.anima` or `~/.anima-dev` | Build and test Anima itself |
| Dogfood / staging | Pinned npm canary package | `~/.anima` for Anima's own live team | Run real usage before stable |
| Stable user install | Pinned npm stable package | User's chosen home, normally `~/.anima` | External users |

Do not run dogfood or stable installs from a development checkout. A development rebuild should not
be able to change the UI or server code used by a live install.

## Code Root Vs Data Home

Keep these separate:

- **Code root:** where the package or source checkout lives.
- **Anima home:** where runtime state, config, logs, pid files, agent homes, reminders, and message
  stores live.

For example:

```text
~/anima/          source checkout for development
~/anima-prod/     npm-installed dogfood runtime
~/.anima/         dogfood runtime data
~/anima/.anima/   development runtime data
```

The code root can be replaced during an upgrade. The Anima home is durable user data and should not
move during a normal deploy.

## Dogfood Deployment

Anima's own live install should run a pinned canary version, not a mutable checkout:

```bash
cd ~/anima-prod
npm install @totoday/anima@0.2.0-canary.20260529.36fa5d8
ANIMA_HOME=~/.anima npx animactl services restart
```

Restarts should stay idle-gated. If agents are active, the restart waits or exits without killing
active turns. Use `--force` only for an explicit incident decision.

## Stable User Upgrades

External users should not be silently upgraded. A stable install checks the `latest` dist-tag and
offers a one-click upgrade when a newer stable version exists.

First-version behavior:

1. Detect the current package version.
2. Check npm `latest`.
3. If newer, show an upgrade button in the dashboard.
4. On click, install the selected version.
5. Restart services through the idle gate.
6. Verify the service comes back on the new version.
7. If the upgrade fails, report the error and leave the old version running when possible.

Dogfood installs may optionally check `canary` instead of `latest`, but that should be an explicit
setting. Stable users should not see pre-release upgrades unless they opt in.

## Auto-Upgrade Policy

Default policy: no silent auto-upgrades.

Reasons:

- Agents may be in the middle of active work.
- Users run Anima on varied local machines.
- A package upgrade can require a service restart.

The safe default is a visible update prompt plus a user-initiated restart. Fully automatic dogfood
upgrades can come later after the one-click path is reliable.

## Verification

After a deploy or upgrade, verify:

- Agent and web pids changed if a restart was expected.
- `startedAt` advanced.
- `/api/server-info` reports the expected package version or commit.
- `/api/health` returns 200.
- The dashboard serves the expected UI.
- Agent provider configs are intact.
- Agents can receive and send Slack messages.

The service should expose enough metadata to make wrong-root or wrong-version deployments obvious:
package version, code root, Anima home, environment, startedAt, and build commit when available.
