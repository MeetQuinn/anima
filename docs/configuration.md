---
title: Configuration reference
description: The server settings in config.json and the environment variables that change how the Anima services behave.
---

# Configuration reference

This page lists the server settings in `config.json` and the environment variables an operator can
set. For installing and restarting, see [Runtime and services](./deployment.md). For network
exposure, see [Security and data](./security-and-data.md).

## Where the file lives

The file is `config.json` in the Anima home: `$ANIMA_HOME/config.json`, normally
`~/.anima/config.json`. Every agent in that home shares it. A missing file reads as empty, so every
key is optional. `config.example.json` in the repository shows some of the keys at their defaults.

## When changes apply

Most keys need no restart. The agent service watches the Anima home and re-reads `config.json`
shortly after it changes. It also re-checks every 30 seconds. Both services cache the file by its
modification time and size, so the first read after a save sees the new contents.

| Key                                | Usually set from                | Takes effect                                   |
| ---------------------------------- | ------------------------------- | ---------------------------------------------- |
| `memoryCoherence.*`                | hand edit                       | next agent-service check                       |
| `cursorDelivery.enabled`           | hand edit                       | next Slack wake or send                        |
| `runtime.maxConcurrentAgentRuns`   | hand edit                       | next agent-service check                       |
| `providerCommands`, `providerArgs` | **Settings > Providers**        | affected agents reload at a safe boundary      |
| `providerContextLimits`            | **Settings > Providers**        | when saved, and at each provider session start |
| `releaseTrack`                     | `animactl release-track`        | next update check                              |
| `workspacePlatform`                | onboarding                      | next dashboard read                            |
| `linearWebhook`                    | the agent's Linear setup dialog | next agent-service check                       |
| `dashboardHost`, `dashboardPort`   | hand edit                       | after a service restart (see below)            |
| `dashboardAuth`                    | `animactl dashboard-auth`       | next dashboard request                         |
| `doNotContact`                     | **Settings > Outreach limits**  | next send                                      |
| `linearDoNotContact`               | **Settings > Outreach limits**  | next Linear write                              |

## Edit the file safely

- The schema is strict. An unknown key, a misspelled key, or a wrong type makes every read of the
  file fail with an error that names the path. Until you fix it:
  - the agent service doesn't start. If it is already running, it logs
    `Runtime host reconcile failed` and stops applying config changes;
  - Slack wakes are requeued instead of delivered, and Slack sends and Linear writes are refused;
  - dashboard API requests fail.
- Unknown keys inside `sidebarOrder` don't cause an error. Anima drops them, so a misspelled key
  there is ignored.
- Write valid JSON to a temporary file beside `config.json` and move it into place.
- When the dashboard or a CLI command saves a setting, Anima rewrites the whole file as indented
  JSON. Your own formatting is not kept.
- A leftover `providerAccounts` key from a removed feature is ignored and dropped on the next save.
- A leftover `memoryCoherence.consolidationThresholdBytes` is ignored and dropped on the next save:
  Dreaming has no size threshold.

## Dreaming (`memoryCoherence`)

Once a day, each eligible agent gets Dreaming: an ordinary scheduled wake in which it consolidates
what happened into `MEMORY.md` and `notes/` in its agent home and lets go of the rest (see
[Concepts](./concepts.md)). It asks the same thing whatever the file's size.
An agent is eligible when it is enabled, has a connected transport (Slack, Feishu, or Linear), and
can run. Dreaming is queued only when the agent's message history has a new entry since it last
ran, so idle agents are skipped.

Each agent gets a fixed slot inside the window, offset by a hash of its agent ID, so the wakes spread
out. If the service was down at the slot, Dreaming is queued when it comes back. Only the most
recent slot (today's or yesterday's) is caught up, and an agent dreams at most once per local day.
Outcomes appear in Activity as `memory_coherence.outcome` ([Activity events](./activity-events.md)).

| Key                                     | Type               | Default         | What it does                                                                                                                                                                             |
| --------------------------------------- | ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryCoherence.enabled`               | boolean            | `true`          | Only `false` turns Dreaming off.                                                                                                                                                         |
| `memoryCoherence.windowStart`           | `"HH:MM"`, 24-hour | `"05:00"`       | Start of the daily window.                                                                                                                                                               |
| `memoryCoherence.windowDurationMinutes` | integer, 1 to 1440 | `120`           | Length of the window. Every agent's slot falls inside it.                                                                                                                                |
| `memoryCoherence.timezone`              | IANA zone name     | `"agent-local"` | Zone for the window. `agent-local` means the agent service's system time zone (UTC if unknown). An invalid name stops scheduling and logs `Memory coherence scheduler reconcile failed`. |
| `memoryCoherence.maxConcurrent`         | integer, 1 to 100  | `1`             | Most Dreaming wakes queued or running at once, across all eligible agents.                                                                                                               |
| `memoryCoherence.scopeAgentIds`         | array of agent IDs | `[]`            | Limits Dreaming to the listed agents. Empty means every eligible agent.                                                                                                                  |

## Slack conversation view and send hold (`cursorDelivery`)

| Key                      | Type    | Default | What it does                                                       |
| ------------------------ | ------- | ------- | ------------------------------------------------------------------ |
| `cursorDelivery.enabled` | boolean | `true`  | Only `false` turns it off. One flag controls both behaviors below. |

When on, Anima keeps a read position per agent for each Slack conversation (channel, thread, or DM).

- **Conversation view.** A Slack wake carries the messages that arrived since the agent's last
  delivered view of that conversation, up to 20 messages and 16 KB. When there are more, the oldest
  are left out and the view notes it. Queued Slack wakes for messages already shown are settled
  without another turn.
- **Send hold.** In Slack DMs (including group DMs) and threads, `anima message send`, `anima ask`,
  and `anima file send` are held when new messages arrived after the agent's last view. Nothing is
  posted. The agent gets a `HELD` result listing the new messages and can resend. Top-level channel
  sends are never held. See the [agent reference](./agent/reference.md).

Only Slack is affected. If the setting cannot be read (for example, `config.json` fails to parse),
Anima fails closed: Slack wakes are requeued and logged rather than delivered with the view off, and
DM and thread sends return an error rather than posting unheld.

## Concurrency (`runtime`)

| Key                              | Type              | Default | What it does                                                                                                                                                                                         |
| -------------------------------- | ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.maxConcurrentAgentRuns` | integer, 1 to 100 | `10`    | Most agent turns running at once across all agents in this home. Each agent takes a slot before it claims its next inbox item; the rest wait queued. A higher limit admits waiting turns right away. |

## Providers (`providerCommands`, `providerArgs`, `providerContextLimits`)

Set these under **Settings > Providers**. [Providers](./guide/providers.md) explains each control.
Provider keys are `claude-code`, `codex-cli`, `kimi-cli`, `grok-cli`, `opencode-cli`, and `pi`.

| Key                              | Type                       | Default                                                | What it does                                                                                     |
| -------------------------------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `providerCommands.<provider>`    | string, up to 4096 chars   | `claude`, `codex`, `kimi`, `grok`, `opencode`, or `pi` | Executable name or absolute path launched for every agent on that provider. Not a shell command. |
| `providerArgs.<provider>`        | array of up to 128 strings | `[]`                                                   | Extra argv entries passed to the provider CLI. No blank entries, line breaks, or NUL bytes.      |
| `providerContextLimits.grok-cli` | positive integer (tokens)  | unset (no Anima limit)                                 | Machine-wide context cap for Grok. The dashboard offers `131072` or `200000`.                    |
| `providerContextLimits.kimi-cli` | positive integer (tokens)  | unset (no Anima limit)                                 | Machine-wide context cap for Kimi. The dashboard offers `131072` or `262144`.                    |

- An agent's own runtime command or arguments replace these values for that agent. They are not
  merged.
- The dashboard checks that the command exists and is executable before saving. A hand edit skips
  that check.
- A command or argument change reloads only the agents on that provider, after their active turn and
  provider background work reach a safe boundary.
- A context limit is written into the provider's own CLI config, outside the Anima home, when you
  save it and when a provider session starts. Remove it from the dashboard (**No Anima limit**).
  Deleting the key by hand leaves the value Anima already wrote in the provider's file.
- While a context limit is set, a Kimi or Grok agent needs a model configured. Without one, its
  provider session fails to start.

## Release track (`releaseTrack`)

| Key            | Type                               | Default                                                | What it does                                                                                                                                                                     |
| -------------- | ---------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releaseTrack` | `"stable"` or `"canary"`           | `track` if it is `canary` or `stable`, then `"stable"` | The npm tag the dashboard update check follows: `latest` for stable, `canary` for canary. **Update** installs the newest version on that tag.                                    |
| `track`        | `"dev"`, `"canary"`, or `"stable"` | `releaseTrack`, then `"stable"`                        | Managed by Anima; don't edit by hand. It is written together with `releaseTrack`, shown in **Server**, and set to `dev` for a development home, which turns off managed updates. |

Use the CLI instead of editing the file. It writes both keys, so on a development home setting a
track replaces `dev` and turns managed updates on:

```bash
npx -y @meetquinn/animactl@latest release-track          # show
npx -y @meetquinn/animactl@latest release-track canary   # set
```

The package you pass to `npx` still decides what `start` and `restart` install. See
[Select a release target](./deployment.md#select-a-release-target).

## Workspace platform (`workspacePlatform`)

| Key                 | Type                    | Default   | What it does                                                                                                                               |
| ------------------- | ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspacePlatform` | `"slack"` or `"feishu"` | `"slack"` | The chat platform chosen during onboarding. For an agent with no connected chat yet, the dashboard shows that platform's connection setup. |

## Public address (`publicUrl`)

`publicUrl` is this Anima home's public HTTPS origin, without a path, query or fragment.
Forward the whole address to the dashboard. Set it in **Settings → Server**, or in the
Linear dialog when you connect the first agent. Integrations derive their public URLs from
it; saving it neither creates forwarding nor changes a platform's registered app URLs.
The dashboard checks that the address reaches this Anima, and warns when the dashboard
opens there without signing in. Forwarding the whole address
exposes the whole dashboard there: protect it with a sign-in gateway or a
[dashboard password](#dashboard-password-dashboardauth). See
[Connect an agent to Linear](guide/connect-linear.md#public-address).

## Linear receiver (`linearWebhook`)

| Key                  | Type                   | Default       | What it does                                     |
| -------------------- | ---------------------- | ------------- | ------------------------------------------------ |
| `linearWebhook.host` | string                 | `"127.0.0.1"` | Address the Linear receiver binds.               |
| `linearWebhook.port` | integer, 1024 to 65535 | `14185`       | Receiver port. Keep it off the dashboard's port. |

Optional; edit by hand only if the default port is taken. The dashboard forwards Linear
events from the public address to this receiver, so it does not need its own forwarding.
All Linear agents share it. It runs in the agent service only while at least one enabled
agent has a complete Linear installation, and it rebinds on the next check when the host or
port changes. Earlier versions wrote this key when an agent was authorized; that address is
kept. See [Connect Linear](./guide/connect-linear.md#public-address).

## Dashboard listener (`dashboardHost`, `dashboardPort`)

| Key             | Type                | Default                      | What it does                                                                             |
| --------------- | ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `dashboardHost` | string              | `"0.0.0.0"` (all interfaces) | Address the web service binds. When it is `0.0.0.0`, the displayed URL uses `127.0.0.1`. |
| `dashboardPort` | integer, 1 to 65535 | `4174`                       | Port for the dashboard and local API.                                                    |

Both are read when the services start and passed to the web service as `--host` and `--port`. After
a change:

- with the detached supervisor, run `npx -y @meetquinn/animactl@latest restart`;
- with OS user services, run `npx -y @meetquinn/animactl@latest install-services --only web`. A plain
  `restart` reuses the installed service definition, which still holds the old values.

A `web-network.json` listener list replaces `dashboardHost` when present. See
[Use the dashboard](./guide/using-the-dashboard.md#keep-local-access-and-restrict-a-private-network-listener).

## Dashboard password (`dashboardAuth`)

Managed by Anima; don't edit by hand. The key holds `enabled`, the session length
(`sessionTtlHours`), a scrypt password hash, and a session signing secret that only the CLI
generates. Treat `config.json` as sensitive once a password is set.

```bash
npx -y @meetquinn/animactl@latest dashboard-auth status
printf '%s\n' "$NEW_DASHBOARD_PASSWORD" | npx -y @meetquinn/animactl@latest dashboard-auth set --password-stdin
npx -y @meetquinn/animactl@latest dashboard-auth set --password-stdin --session-ttl-hours 72 < password.txt
npx -y @meetquinn/animactl@latest dashboard-auth disable
```

- `set` needs a password of at least 8 characters; one trailing newline is dropped. It stores a new
  hash and a new session secret, which signs out every existing dashboard session.
- `--session-ttl-hours` sets how long a login lasts: 1 to 8760 hours, default 336 (14 days).
  Without the flag, `set` keeps the current value, or uses 336 after a `disable`.
- `disable` removes the stored hash, secret, and session length.
- A client that enters 10 wrong passwords is refused (`429`) until five minutes after its first
  wrong one. Clients are told apart by connecting address. Anima treats a connection from the same
  host as a trusted proxy, such as cloudflared or Tailscale Serve, and uses the last
  `X-Forwarded-For` address. That proxy must append its client's address to the header or replace
  the header with it. If it sends none, all its clients share one count.
- Changes apply to the next dashboard request. Add `ANIMA_HOME=/absolute/path` for a non-default
  home.

## Other keys

| Key                  | Type                                      | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doNotContact`       | Slack workspace ID → list of member IDs   | unset   | Agent Slack messages (sends and updates) are refused when they DM a listed member, include one in a group DM, or @mention one in any channel. While a list is active, a DM whose recipients can't be resolved is refused too. Edit it in **Settings > Outreach limits**; see [Working with your agent](./guide/working-with-your-agent.md).                                                                                   |
| `linearDoNotContact` | Linear organization ID → list of user IDs | unset   | Agent Linear writes (`anima linear reply`, `start`, and `api` writes) are refused when they @mention a listed person, by `@displayName` or profile URL, or assign, delegate or subscribe them. While a list is active, a write that could contain a mention is refused if the listed people can't be looked up. Edit it in **Settings > Outreach limits**; see [Working with your agent](./guide/working-with-your-agent.md). |
| `teams`              | array of `{ id, name, home }`             | unset   | Managed by Anima; don't edit by hand. The dashboard creates teams and changes their name and home, and agents refer to them by `id`. The default team is filled in on read and written only once a team is created or edited.                                                                                                                                                                                                 |
| `sidebarOrder`       | object                                    | unset   | Managed by Anima. Saved when you reorder the dashboard sidebar.                                                                                                                                                                                                                                                                                                                                                               |

## Environment variables

These come from the service's process environment, not from `config.json`. Restart the service
after changing one.

| Variable                     | Default    | What it does                                                                                                                                                                                                                            |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANIMA_HOME`                 | `~/.anima` | Selects the Anima home. Managed `animactl` commands use it or `~/.anima`. When it is unset, the runtime also uses a `.anima` directory in the current directory if one exists. Installed service definitions set it explicitly.         |
| `ANIMA_READ_ONLY`            | off        | The web service answers `403` to routes that change state outside the Anima home: provider runtime commands, context limits and sign-in, provider CLI installs, runtime updates, service restarts, folder creation, and agent creation. |
| `ANIMA_ALLOW_MACHINE_WRITES` | off        | Explicitly allows those routes. `ANIMA_READ_ONLY` wins when both are set. With neither set, the routes are allowed, and the web service logs a warning once per route that this default is planned to become a refusal.                 |

Without an explicit `ANIMA_HOME`, the runtime chooses between the local and user home
once per working directory in each process. Creating or deleting `.anima` later does not
change that choice. Set `ANIMA_HOME` or start a new process to select another home.

- `ANIMA_READ_ONLY` and `ANIMA_ALLOW_MACHINE_WRITES` accept `1`, `true`, `yes`, or `on` (any case).
  Any other value is off.
- Responses from those routes carry an `x-anima-machine-writes` header (`refused`, `explicit`, or
  `implicit-default`) once the request passes dashboard authentication.
- The detached supervisor passes the environment of the shell that runs `start` or `restart` to the
  services, for example `ANIMA_READ_ONLY=1 npx -y @meetquinn/animactl@latest restart`. Installed
  OS service definitions carry only `ANIMA_HOME`, `HOME`, `PATH`, `SHELL`, and, when set, `USER`,
  `LOGNAME`, and `TMPDIR`. They do not carry these flags.
