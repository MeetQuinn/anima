---
title: Update Anima
description: Install a newer managed runtime, restart safely, and verify the version now serving.
---

# Update Anima

An Anima update replaces the managed runtime under the selected Anima home. It does not move agent
homes, team homes, knowledge bases, or the runtime records stored in the Anima home.

Most operators should update from the dashboard. Use the terminal path when the dashboard is
unavailable or when you need an exact release target.

## Update from the dashboard

Open **Server** in the dashboard navigation. The **Version** row shows the runtime track and current
version. When a newer version is available, it shows the target, release notes when available, and
**Upgrade & restart**.

If agents are working, the confirmation names them. The upgrade worker installs and checks the
target before replacing the running services. During restart, Anima asks active work to reach a
provider-safe boundary and requeues the affected inbox items for the new worker. Queued work stays
queued.

The dashboard waits for the service to return, then reloads against the new runtime. A successful
drain reports how many agents resumed.

If installation fails before restart, the current runtime keeps serving. If a later upgrade phase
fails, the Server panel reports the running version, rollback result, error, and upgrade log path
instead of claiming success.

## Update from a terminal

Run the command from an external shell under the host user that owns the Anima installation:

```bash
npx -y @meetquinn/animactl@latest restart
```

This selects the npm `latest` release, installs it into the managed runtime directory for the
selected Anima home, and performs a drain-and-resume service restart.

To target canary or an exact version, make the target explicit:

```bash
npx -y @meetquinn/animactl@canary restart
npx -y @meetquinn/animactl@<version> restart
```

For a non-default runtime, always name its home:

```bash
ANIMA_HOME=/absolute/path/to/anima-home \
  npx -y @meetquinn/animactl@latest restart
```

Do not run a restart from inside an agent turn that belongs to the same Anima home. The CLI refuses
that self-stop boundary. Use an external shell or the dashboard.

## Verify the serving version

After the dashboard returns:

1. Open **Server** and confirm the expected track, version, health, uptime, and Home path.
2. Or run:

   ```bash
   npx -y @meetquinn/animactl@latest status
   ```

3. Confirm both the agent and web services are running.
4. Confirm an agent can receive and send one ordinary message before treating the update as closed.

Do not use **Restart agent** as an update mechanism. That action force-stops one hung agent and drops
its current work. Runtime updates use the machine-level drain-and-resume path.

## Go deeper

- [Runtime and services](/deployment) explains release tracks, homes, service installation, and
  managed commands.
- [Recover local services](/service-runbook) covers status, logs, force boundaries, and failure
  diagnosis.
- [Back up and restore](./backup-and-restore.md) separates runtime state from agent and team files.
