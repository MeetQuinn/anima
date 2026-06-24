# Anima Service Runbook

This is an operator runbook for the lower-level service supervisor. Most users should start with
[Quickstart](guide/quickstart.md) and [Deployment and upgrades](deployment.md). Use this page when you need
to inspect or directly control the local daemons behind an Anima home.

`animactl services <op>` supervises the agent and web daemons for one Anima home. The target is the
home selected by `ANIMA_HOME`, or the default managed home `~/.anima` when `ANIMA_HOME` is unset.
Anima records the visible runtime track (`dev`, `canary`, or `stable`) in that home's config; the
track is shown in the dashboard so operators can tell which kind of runtime they are looking at.
On macOS, `animactl services install` installs launchd LaunchAgents for the selected home. On Linux,
it installs systemd user services. Once installed, `services start`, `stop`, `restart`, and `status`
use the OS manager for those services. Homes without installed OS services keep using Anima's
detached pid-file supervisor, which remains useful for source development and CI.

For managed installs, operators normally drive the runtime with the public commands:

```bash
curl -fsSL https://anima.meetquinn.ai/install.sh | sh
npx -y @meetquinn/animactl@latest dashboard
npx -y @meetquinn/animactl@latest install-services # optional: install OS services on macOS/Linux
npx -y @meetquinn/animactl@latest restart
npx -y @meetquinn/animactl@latest status
npx -y @meetquinn/animactl@latest stop
```

Those commands are documented in [Deployment and upgrades](deployment.md). This runbook covers the
underlying `animactl services <op>` supervisor they invoke, plus its idle-gate and cross-environment
restart semantics.

For Anima source development, the `dev:services:*` npm scripts explicitly set
`ANIMA_HOME=./.anima-dev` and seed dashboard port `14174`, so local dev state stays inside the repo
clone and does not collide with the managed `~/.anima` dashboard on `4174`.

Each Anima home runs two daemons:

- Agent (`animactl server`): Slack listener, reminder scheduler, and worker loop in one process.
- Web (`animactl web`): local status and activity views.

The web app port comes from the selected home config's `dashboardPort` field. Managed installs
normally use `4174`; source-development services seed `14174`. Use
`npx -y @meetquinn/animactl@latest dashboard` for managed installs, or
`ANIMA_HOME=<path> npx -y @meetquinn/animactl@latest services dashboard` for a specific home, to
launch the dashboard without remembering the port.
The agent service auto-starts newly runnable Slack-connected agents. Restart services after changing an already-running agent's provider, home, Slack tokens, or enabled state.

## Status

```bash
ANIMA_HOME=<path> npx -y @meetquinn/animactl@latest services status
```

Status output includes each service id (`agent` / `web`), pid if running, `launchd` or `systemd` when
the service is OS-managed, web URL when relevant, and log path.

## Install OS Services

```bash
ANIMA_HOME=<path> npx -y @meetquinn/animactl@latest install-services
```

On macOS this installs the selected package into that home's managed runtime directory, then writes
LaunchAgent plists under `~/Library/LaunchAgents`, with `RunAtLoad` and `KeepAlive` enabled. On Linux
it writes systemd user units under `${XDG_CONFIG_HOME:-~/.config}/systemd/user`, runs
`systemctl --user enable`, and starts the services. Headless Linux hosts should run
`loginctl enable-linger $USER` once if the user services must start after boot before the user logs
in.

The generated service environment is explicit because OS service managers do not load shell startup
files. It includes the selected `ANIMA_HOME`, a durable `PATH` with Anima's runtime, local provider
bins such as `~/.local/bin` and `~/.kimi-code/bin`, Homebrew locations on macOS, and system
directories. It intentionally does not copy temporary provider/Codex shell paths or in-flight
`ANIMA_*` item context.

Use `--only agent` or `--only web` to install one service. Use `uninstall-services` to remove the OS
service definitions and return that home to pid-file supervision on the next start. The lower-level
`animactl services install` command exists for the pinned runtime/admin CLI; avoid running that
lower-level command from a transient `npx` cache because the generated service definition records
the CLI path.

## Restart

```bash
ANIMA_HOME=<path> npx -y @meetquinn/animactl@latest restart
```

Managed restarts drain active agents before stopping services. Running agents are asked to reach a provider quiescent point after the current tool result and before the next tool call; their current item is then re-queued so the new worker resumes it with the persisted session. Queued items are not blockers and remain queued for the new worker. Use `--drain-timeout-ms <ms>` to tune how long the drain waits before failing honestly.

The lower-level `animactl services restart` command keeps the original idle gate unless passed `--drain-active --resume-running`. Use it only when you need direct supervisor control.

`--force` bypasses the idle gate and preserves the old stop/start behavior. Reserve it for an explicit operator decision during an incident; it can abort an active turn.

The supervisor stops the agent and web app, then starts them again with Anima runtime environment variables scrubbed from the child service environment.

Same-environment restart from inside an active runtime is refused, because it would kill the item making the request. Cross-environment restart is allowed when `ANIMA_HOME` points at another Anima home and `ANIMA_RUNTIME_HOME` still points at the caller's own home. A human can restart any environment from a fresh shell or the web restart button.

## Stop And Start

```bash
ANIMA_HOME=<path> npx -y @meetquinn/animactl@latest services stop
ANIMA_HOME=<path> npx -y @meetquinn/animactl@latest services start
```

`stop` is also refused from inside the same environment's active runtime, for the same reason.

## Logs

Logs live under the selected Anima home:

- `$ANIMA_HOME/logs/agent.log`
- `$ANIMA_HOME/logs/web.log`

Pid files live under `$ANIMA_HOME/run/{agent,web}.pid` for homes that have not installed OS-managed
services. Launchd-managed services are inspected through `launchctl`, and systemd-managed services
through `systemctl --user`, not pid files.
