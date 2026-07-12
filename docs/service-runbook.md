---
title: Recover local services
description: Diagnose and recover the agent and web daemons for one Anima home.
---

# Recover local services

Use this runbook when the dashboard is unreachable, the agent daemon is unhealthy, or a normal
runtime restart did not return cleanly. Most routine operations belong in [Runtime and
services](./deployment.md).

Always identify the Anima home before acting. The **Home** row in the Server panel is the easiest
source when the dashboard still works. In a terminal, set it explicitly for every command:

```bash
export ANIMA_HOME=/absolute/path/to/anima-home
```

Do not operate a development home when you intend to recover the managed home, or the reverse.

## Start with status

```bash
npx -y @meetquinn/animactl@latest status
```

Status reports:

- the installed managed runtime and runtime directory
- the `agent` and `web` service state
- process IDs when available
- launchd or systemd ownership when OS services are installed
- the dashboard URL and log paths

Record this output before restarting. A status snapshot distinguishes a service problem from a
wrong-home or wrong-version problem.

## Read the logs

The selected Anima home owns both service logs:

```text
$ANIMA_HOME/logs/agent.log
$ANIMA_HOME/logs/web.log
```

Use the agent log for transport, scheduler, queue, worker, and provider-child failures. Use the web
log for dashboard and local API failures.

Logs can contain message context, paths, provider diagnostics, and errors. Treat them as sensitive
operator data. Do not paste a full log into a public issue; extract the narrow relevant lines and
remove secrets or private content.

## Choose the smallest recovery action

| Symptom                                        | First action                                                  | Why                                     |
| ---------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| Dashboard unavailable, agents still responding | restart only `web`                                            | avoids touching agent work              |
| Dashboard works, one agent is hung             | use **Restart agent** after inspecting Activity               | scopes the force-stop to that agent     |
| Both local services need a clean restart       | top-level `restart`                                           | uses drain and requeue behavior         |
| Provider login, billing, or quota failure      | repair it in the provider                                     | a restart does not change account state |
| Wrong Home or runtime version                  | stop and re-run with explicit `ANIMA_HOME` and package target | fixes the authority, not the symptom    |

Restart only the web service:

```bash
npx -y @meetquinn/animactl@latest restart --only web
```

Restart both services through the normal continuity path:

```bash
npx -y @meetquinn/animactl@latest restart
```

If agents are running, the normal restart asks them to drain, requeues the affected inbox items, and
recovers interrupted items after the worker returns. It does not make already-completed external
effects transactional.

## Stop and start manually

Use a manual stop/start when you need a quiet filesystem for backup or repair:

```bash
npx -y @meetquinn/animactl@latest stop
npx -y @meetquinn/animactl@latest start --no-browser
```

Wait for agents to become idle before stopping. `stop` is not a graceful drain command.

An Anima agent turn cannot stop or restart the agent service for its own Anima home. The CLI refuses
that self-stop boundary. Run the command from an external human shell. Cross-home control is allowed
only when the target home is explicit and differs from the caller's runtime home.

## Use force only during an incident

```bash
npx -y @meetquinn/animactl@latest restart --force
```

`--force` bypasses idle and drain protection. It can terminate the active provider turn. Use it only
after you have recorded the running item and accepted that the provider process will be interrupted.
The durable inbox record can recover, but external effects that already completed may run again when
the item is retried.

## Inspect the OS supervisor

When OS services are installed, launchd or systemd owns process restart and startup. Use the service
manager to inspect its view, but keep Anima lifecycle changes in `animactl` so the selected home,
runtime path, and service pair stay consistent.

macOS:

```bash
launchctl print gui/"$(id -u)" | grep -i anima
```

Linux:

```bash
systemctl --user status | grep -i anima
```

Homes without OS-managed services use pid files under:

```text
$ANIMA_HOME/run/agent.pid
$ANIMA_HOME/run/web.pid
```

Do not treat a stale pid file as proof that a process is alive. Use `status`, then the operating
system process table when the two disagree.

## Reinstall service definitions

Use this when a managed runtime moved, the generated PATH is stale, or the OS service files were
removed:

```bash
npx -y @meetquinn/animactl@latest uninstall-services
npx -y @meetquinn/animactl@latest install-services
```

This changes service definitions, not the Anima home. It does not log in to providers or recreate
chat apps.

## Verify recovery

Close an incident only after checking all relevant layers:

1. `status` reports the expected runtime and both intended services running.
2. **Server** reports the expected Home, version, health, and start time.
3. The web log shows the dashboard started on the expected host and port.
4. The agent log no longer repeats the failure that triggered recovery.
5. Queued work is advancing and no running item remains stranded.
6. One ordinary inbound and outbound message succeeds.

If a filesystem restore or machine move is involved, follow [Back up and restore](./guide/backup-and-restore.md) before starting services.
