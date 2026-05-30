# Anima Service Runbook

`animactl services <op>` supervises the agent and web daemons for one Anima home. The target is whichever environment is resolved from `ANIMA_HOME` or the default lookup (`./.anima` first, then `~/.anima`). In a fresh install, there is no repo-local `.anima`, so the normal home is `~/.anima`.

Anima itself does not name environments. If a team wants aliases for specific Anima homes, put that mapping in deployment scripts outside this repo and invoke `animactl` with the appropriate `ANIMA_HOME`.

For managed (npm) installs, operators normally drive the runtime with `npx -y @meetquinn/animactl
start|dashboard|restart|status|stop` — `start` boots a stopped runtime, `dashboard` opens the
dashboard, `restart` is the command-line upgrade/restart path, and `start`/`restart` install
and run the pinned runtime. They are documented in
[deployment.md](deployment.md). This runbook covers the underlying `animactl services <op>`
supervisor those commands invoke, plus its idle-gate and cross-environment restart semantics.

For Anima source development, the `dev:services:*` npm scripts explicitly set `ANIMA_HOME=./.anima`
so local dev state stays inside the repo clone.

Each Anima home runs two daemons:

- Agent (`animactl server`): Slack listener, reminder scheduler, and worker loop in one process.
- Web (`animactl web`): local status and activity views.

The web app port comes from the selected home config's `dashboardPort` field (default `4174`).
Use `npx -y @meetquinn/animactl dashboard` for managed installs, or
`ANIMA_HOME=<path> animactl services dashboard` for a specific home, to launch the dashboard
without remembering the port.
The agent service auto-starts newly runnable Slack-connected agents. Restart services after changing an already-running agent's provider, home, Slack tokens, or enabled state.

## Status

```bash
ANIMA_HOME=<path> animactl services status
```

Status output includes each service id (`agent` / `web`), pid if running, web URL when relevant, and log path.

## Restart

```bash
ANIMA_HOME=<path> animactl restart
```

Managed restarts drain active agents before stopping services. Running agents are asked to reach a provider quiescent point after the current tool result and before the next tool call; their current item is then re-queued so the new worker resumes it with the persisted session. Queued items are not blockers and remain queued for the new worker. Use `--drain-timeout-ms <ms>` to tune how long the drain waits before failing honestly.

The lower-level `animactl services restart` command keeps the original idle gate unless passed `--drain-active --resume-running`. Use it only when you need direct supervisor control.

`--force` bypasses the idle gate and preserves the old stop/start behavior. Reserve it for an explicit operator decision during an incident; it can abort an active turn.

The supervisor stops the agent and web app, then starts them again with Anima runtime environment variables scrubbed from the child service environment.

Same-environment restart from inside an active runtime is refused, because it would kill the item making the request. Cross-environment restart is allowed when `ANIMA_HOME` points at another Anima home and `ANIMA_RUNTIME_HOME` still points at the caller's own home. A human can restart any environment from a fresh shell or the web restart button.

## Stop And Start

```bash
ANIMA_HOME=<path> animactl services stop
ANIMA_HOME=<path> animactl services start
```

`stop` is also refused from inside the same environment's active runtime, for the same reason.

## Logs

Logs live under the selected Anima home:

- `$ANIMA_HOME/logs/agent.log`
- `$ANIMA_HOME/logs/web.log`

Pid files live under `$ANIMA_HOME/run/{agent,web}.pid`.
