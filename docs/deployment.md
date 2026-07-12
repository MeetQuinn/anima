---
title: Runtime and services
description: Install and operate a managed Anima runtime without mixing code, runtime state, or agent files.
---

# Runtime and services

This page is the operator reference for a managed Anima installation. For the normal update task,
start with [Update Anima](./guide/updating-anima.md). For incident diagnosis, use
[Recover local services](./service-runbook.md).

## Keep three roots separate

Anima deliberately separates replaceable software from runtime state and team files:

| Root                 | Typical path                | Contains                                                           | Replaceable? |
| -------------------- | --------------------------- | ------------------------------------------------------------------ | ------------ |
| Managed runtime      | `~/.anima/runtime/current/` | Installed `@meetquinn/animactl` package                            | Yes          |
| Anima home           | `~/.anima/`                 | Config, agent records, queues, sessions, activity, reminders, logs | No           |
| Team and agent homes | `~/anima-team/`             | Knowledge bases, memory, notes, skills, work files                 | No           |

The managed runtime can be reinstalled from npm. Do not put durable files under `runtime/current`.
The Anima home and team or agent homes require separate backups because they can live at unrelated
paths.

Managed commands use `ANIMA_HOME` when it is set and `~/.anima` otherwise. A source checkout uses a
separate development home and must not serve or modify a live managed installation.

The canonical definitions are in [Concepts](./concepts.md#runtime-and-operation).

## Choose a runtime shape

| Shape       | Package or code | Home                        | Use                        |
| ----------- | --------------- | --------------------------- | -------------------------- |
| Stable      | npm `latest`    | selected managed Anima home | normal installation        |
| Canary      | npm `canary`    | selected managed Anima home | explicit canary validation |
| Development | source checkout | repo-local `.anima-dev`     | contributor testing        |

Stable does not silently switch to canary. The release track is an operator choice stored in the
Anima home and shown with the runtime version in **Server**.

## Install and start

The public installer checks the Node and npm prerequisites, installs the current stable runtime, and
starts the local services:

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
```

The equivalent managed command is:

```bash
npx -y @meetquinn/animactl@latest start
```

`start` installs the selected package into `runtime/current` when needed. On an interactive desktop
it opens the dashboard; add `--no-browser` for a headless shell.

Use `ANIMA_HOME=/absolute/path` on every command when operating a non-default home. Do not rely on
the current directory to select a managed installation.

## Choose a service supervisor

Without OS service definitions, Anima can run the agent and web daemons under its detached local
supervisor. Install operating-system user services when Anima should return after login or reboot:

```bash
npx -y @meetquinn/animactl@latest install-services
```

On macOS, this installs launchd LaunchAgents. On Linux, it installs systemd user services. For a
headless Linux host that must start before interactive login, enable user lingering separately:

```bash
loginctl enable-linger "$USER"
```

Generated service definitions carry an explicit Anima home and PATH because OS supervisors do not
load an interactive shell profile. The PATH includes normal system, Homebrew, and supported local
provider locations; it does not copy temporary turn-specific environment values.

Remove the OS definitions without deleting the Anima home:

```bash
npx -y @meetquinn/animactl@latest uninstall-services
```

The next start can use the detached supervisor again.

## Inspect status and open the dashboard

```bash
npx -y @meetquinn/animactl@latest status
npx -y @meetquinn/animactl@latest dashboard
```

Status reports the installed runtime and the agent and web services. The dashboard command opens the
URL configured in the selected Anima home without changing service state.

Each home runs two local daemons:

- **agent** receives transport events, schedules private wakes, and runs the workers
- **web** serves the local API and dashboard

Managed installs normally bind the dashboard to `127.0.0.1:4174`. The host and port come from the
selected Anima home, so treat the reported URL as authority.

## Restart without dropping the queue

Use the top-level managed restart for normal operations:

```bash
npx -y @meetquinn/animactl@latest restart
```

It installs the selected package when needed, asks running work to reach a provider-safe boundary,
requeues the affected inbox items, and restarts both services. Queued work remains queued. If a turn
does not drain before the timeout, Anima continues the restart and leaves that item for startup
recovery; the completion report does not claim it drained cleanly.

This is not a distributed exactly-once boundary. A shell command, Git push, chat delivery, or API
request that completed before the restart cannot be rolled back by requeuing an inbox item.

Use `--force` only for an explicit incident decision. It bypasses the normal gate and can abort the
active provider turn.

The lower-level `services restart` command exists for supervisor work. Its drain mode requires both
flags together:

```bash
npx -y @meetquinn/animactl@latest services restart \
  --drain-active --resume-running
```

Prefer the top-level `restart` command unless you are following the service runbook.

## Select a release target

The package passed to `npx` is the installation authority:

```bash
npx -y @meetquinn/animactl@latest restart
npx -y @meetquinn/animactl@canary restart
npx -y @meetquinn/animactl@<version> restart
```

There is no default silent auto-upgrade. The dashboard checks the selected release track and offers
an explicit update when a newer version is available.

## Verify an installation or restart

Verify the result from the selected home, not from the package cache or source checkout you used to
start the command:

1. `status` reports both services running.
2. **Server** reports the expected Home, track, version, health, and new start time.
3. The dashboard serves the expected UI.
4. Agent provider configuration and connected transports remain present.
5. One ordinary inbound and outbound message succeeds.

For the files that must survive a machine move, continue to [Back up and restore](./guide/backup-and-restore.md).
