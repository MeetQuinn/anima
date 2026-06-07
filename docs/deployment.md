# Deployment And Upgrades

This document describes the npm-era deployment model for running Anima on a machine you control. The
goal is to keep the runtime package replaceable while your local Anima home stays durable.

## Runtime Shape

| Runtime shape      | Code source                         | Anima home                              | Purpose                    |
| ------------------ | ----------------------------------- | --------------------------------------- | -------------------------- |
| Stable install     | Pinned npm stable package           | User's chosen home, normally `~/.anima` | Default user install       |
| Prerelease install | Pinned npm prerelease package       | User's chosen home                      | Opt-in validation          |
| Source checkout    | Local source tree, for contributors | Repo-local `./.anima-dev`               | Development and PR testing |

Do not run a managed install directly from a development checkout. A development rebuild should not
be able to change the UI or server code used by a live `~/.anima` install.

## Code Root Vs Data Home

Keep these separate:

- **Code root:** where the package or source checkout lives.
- **Anima home:** where runtime state, config, logs, pid files, agent homes, reminders, and message
  stores live.

For example:

```text
~/anima/                         optional source checkout for contributors
~/.anima/                        default managed runtime data
~/.anima/runtime/current/        npm-installed managed runtime
~/anima/.anima-dev/              development runtime data
```

The code root can be replaced during an upgrade. The Anima home is durable user data and should not
move during a normal deploy.

`~/.anima/runtime/current` is a replaceable cache of the npm package. Do not put durable user state
there. It can be deleted and reinstalled from npm as long as `~/.anima` is intact.

## Managed Runtime Commands

The public npm package exposes a user-facing `animactl` entrypoint. `start` and `restart` install
the package version that `npx` downloaded into `~/.anima/runtime/current`, then run services from
that pinned runtime:

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
npx -y @meetquinn/animactl@latest start # first start on stable/latest
npx -y @meetquinn/animactl@latest dashboard # launch the local dashboard
npx -y @meetquinn/animactl@latest restart # command-line upgrade to stable/latest
npx -y @meetquinn/animactl@canary restart # opt in to the prerelease restart path
npx -y @meetquinn/animactl@latest status
npx -y @meetquinn/animactl@latest stop
```

The curl installer is a bootstrap convenience for first-run stable installs. It checks for Node/npm,
then runs the `latest` npm dist-tag for `@meetquinn/animactl`. `start` is the first-run path, or for
starting stopped services. On an interactive desktop it launches the dashboard automatically; use
`--no-browser` for headless scripts. `dashboard` launches the current home's dashboard without
starting services. `restart` is the command-line upgrade path: it installs the package version
selected by `npx` into `~/.anima/runtime/current`, then restarts services with drain-and-resume.
Docs use `@latest` explicitly because the installer does not add `animactl` to the user's `PATH`.
Use `@canary` or an exact version suffix when you want a different target.

The admin CLI exposes the lower-level runtime status/install commands:

```bash
npx -y @meetquinn/animactl@latest runtime status
npx -y @meetquinn/animactl@latest runtime install --channel canary
```

Set `ANIMA_HOME=/path/to/home` to manage a non-default home. If `ANIMA_HOME` is unset, managed
runtime commands use `~/.anima` even when the shell is currently inside a source checkout that has a
repo-local `.anima-dev`.

## Stable User Upgrades

External users should not be silently upgraded. A stable install checks the `latest` dist-tag and
offers a one-click upgrade when a newer stable version exists.

First-version behavior:

1. Detect the current package version.
2. Check npm `latest`.
3. If newer, show an upgrade button in the dashboard.
4. On click, install the selected version.
5. Restart services through drain-and-resume.
6. Verify the service comes back on the new version.
7. If the upgrade fails, report the error and leave the old version running when possible.

Canary installs may optionally check `canary` instead of `latest`, but that should be an explicit
setting. Stable users should not see pre-release upgrades unless they opt in.

## Restart Behavior

Restarts should use drain-and-resume. If agents are active, the restart waits for each running agent
to reach a provider quiescent point, re-queues those items, and lets the new worker resume them.
Queued items remain queued. Use `--force` only for an explicit incident decision.

## Auto-Upgrade Policy

Default policy: no silent auto-upgrades.

Reasons:

- Agents may be in the middle of active work.
- Users run Anima on varied local machines.
- A package upgrade can require a service restart.

The safe default is a visible update prompt plus a user-initiated restart. Fully automatic canary
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

The service should expose enough metadata to make wrong-version deployments obvious: package
version, Anima home, runtime track, startedAt, and build commit when available.
