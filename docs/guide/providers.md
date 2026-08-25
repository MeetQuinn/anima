---
title: Provider setup and identity
description: Install and authenticate Claude Code, Codex CLI, Kimi CLI, Grok Build, OpenCode, or pi for use by Anima agents.
---

# Provider setup and identity

Anima supplies the durable agent identity, chat routing, queue, memory, and activity trail. Claude Code, Codex CLI, Kimi CLI, Grok Build, OpenCode, or pi supplies the model work and developer tools.

The provider CLI is a machine-level dependency. Anima launches the executable found on the host's `PATH` and uses that provider's existing local authentication. Provider login state is not copied into an agent home or stored by Anima.

## Choose one provider

Install and authenticate at least one before creating the first agent.

| Provider    | Official setup                                                                                                                         | Verify on the Anima host          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Claude Code | [Install and authenticate Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)                                 | `claude --version`                |
| Codex CLI   | [Install Codex CLI](https://developers.openai.com/codex/cli/) and sign in with your ChatGPT account or configured API access           | `codex --version`                 |
| Kimi CLI    | [Install Kimi Code CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started) and use `/login` on first launch       | `kimi --version`                  |
| Grok Build  | [Install Grok Build](https://docs.x.ai/build/overview) and sign in with `grok login` or configure its supported API-key authentication | `grok --no-auto-update --version` |
| OpenCode    | [Install OpenCode](https://opencode.ai/docs/) and add a DeepSeek API key with `opencode auth login --provider deepseek`                | `opencode --version`              |
| pi          | `npm install -g @earendil-works/pi-coding-agent`, then run `pi` and `/login` (or add the provider API key to `~/.pi/agent/auth.json`)  | `pi --version`                    |

Run the verification command from the same host user and service environment that runs Anima. A CLI installed only inside another shell profile or user account may work interactively while remaining invisible to the Anima services.

## How onboarding detects readiness

The create-agent flow checks whether `claude`, `codex`, `kimi`, `grok`, `opencode`, and `pi` resolve on `PATH`.

- Missing providers are disabled.
- If one available provider exists, onboarding can select it automatically.
- If none are found, creation stops with **Install a provider first**.

Detection proves that an executable exists. The first real turn proves that its authentication and provider account are usable.

## Customize the runtime launch

Each provider has machine-wide **Runtime command** and **Arguments** fields under
**Providers → Settings**. Leave the command blank to use the default shown in the placeholder:
`claude`, `codex`, `kimi`, `grok`, `opencode`, or `pi`. Set it to another executable name or an absolute
executable path when every Anima agent using that provider should launch through a compatible
wrapper, for example `mcodex` for Codex.

The command is one executable name or absolute path, not a shell command. Put optional CLI arguments
in **Arguments**, one exact argv entry per line. Spaces within a line are preserved; Anima does not
invoke a shell or split quotes, pipes, redirects, or environment assignments. For example, add
`--chrome` as one line for Claude Code when that machine has a paired Claude in Chrome extension.

Arguments are inserted before Anima's managed transport and subcommand arguments. Anima validates
the executable before saving it. A command or argument change applies only to agents using that
provider, after their active turn and provider background work reach a safe boundary.

The same setting can be written directly in `config.json`:

```json
{
  "providerArgs": {
    "claude-code": ["--chrome"]
  }
}
```

These settings change runtime launch only. Provider detection, version reporting, installation, and
updates continue to use the official CLI named in the table above. Any wrapper or added arguments
remain operator-owned and must preserve the provider protocol that Anima expects.

## Authentication ownership

Sign in through the provider's own CLI. Do not paste provider login tokens into an Anima agent, Slack, Feishu, or an agent env entry.

All Anima agents launched under the same host user can reach the same provider credential store unless the provider itself is configured differently. Choosing a different provider for an agent does not create a separate machine account boundary.

The **Providers** panel shows the account label or identifier when the provider exposes one safely. It never stores or displays access tokens. An unavailable usage check can still show the last account Anima identified from local credentials.

Claude accounts are managed outside Anima (native Claude Code login or your own switcher).
Anima does not add, switch, or pin Claude accounts in the dashboard. Usage and quota for the
active native `~/.claude` credential appear in **Providers**. Agents share that host credential;
there is no per-agent credential isolation in Anima.

## Pick the provider for an agent

During agent creation, select the provider, model, and reasoning level. The effort menu follows the
selected model exactly:

| Provider    | Models                                                                                | Reasoning effort                                                                                       |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Claude Code | Opus, Sonnet, Fable; Opus 4.8                                                         | `low`, `medium`, `high`, `xhigh`, `max`                                                                |
| Claude Code | Opus 4.6, Sonnet 4.6                                                                  | `low`, `medium`, `high`, `max`                                                                         |
| Claude Code | Haiku                                                                                 | Provider default; no adjustable effort                                                                 |
| Codex CLI   | GPT-5.6 Sol, GPT-5.6 Terra                                                            | `low`, `medium`, `high`, `xhigh`, `max`, `ultra`                                                       |
| Codex CLI   | GPT-5.6 Luna                                                                          | `low`, `medium`, `high`, `xhigh`, `max`                                                                |
| Codex CLI   | GPT-5.5                                                                               | `low`, `medium`, `high`, `xhigh`                                                                       |
| Kimi CLI    | K3                                                                                    | `low`, `high`, `max`                                                                                   |
| Kimi CLI    | Kimi for Coding, Kimi for Coding Highspeed                                            | Always thinking; no adjustable level                                                                   |
| OpenCode    | DeepSeek V4 Pro, DeepSeek V4 Flash                                                    | `high`, `max`                                                                                          |
| pi          | Gemini 2.5 Pro/Flash, Gemini 3.1 Pro Preview, Gemini 3.7 Flash, DeepSeek V4 Pro/Flash | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (pi `--thinking`; the model decides what it honors) |
| Grok Build  | Live model catalog                                                                    | Whatever the selected model advertises                                                                 |

OpenCode agents can use DeepSeek V4 Pro or DeepSeek V4 Flash. Their DeepSeek API key stays in
OpenCode's machine-level credential store; Anima does not copy it into the agent's Launch
environment.

pi agents address models as `provider/id` (for example `google/gemini-2.5-pro` or
`deepseek/deepseek-v4-pro`). The dashboard offers a curated list of those ids; reading pi's
live model catalog is not implemented yet. Provider credentials stay in pi's machine-level store
(`~/.pi/agent/auth.json`) or the Anima service environment; per-agent `*_API_KEY` values are not
passed to pi.

For Grok Build, Anima reads the current model catalog from the installed CLI (for example `grok-4.5` and `grok-composer-2.5-fast`) and records the actual model ID returned by the runtime. Reasoning effort is **per model**: only models that advertise effort support show an effort control (Composer does not). The `grok-build` marketing alias is never stored as model authority.

You can change the provider later from the agent's Profile tab. A provider change starts a fresh provider session after the current work reaches a safe boundary. The agent's `MEMORY.md`, notes, files, Anima activity, and chat identity remain intact; the previous provider session is archived.

## Manage provider versions

Open **Providers** in the dashboard navigation to inspect the machine-wide CLI that Anima actually
resolves. Each provider row reports its path, installed version, detected installation source,
latest check, update state, affected agents, and usage information when those sources expose it.

Anima offers an **Update** action only when it can prove that the active installation channel can be
updated in place without changing PATH ownership or requiring elevated privileges. Other rows show a
manual command and the reason automation is unavailable.

A provider update:

- changes the shared binary for the host user
- does not log out or edit provider credentials, configuration, MCP servers, plugins, skills, or
  history
- does not interrupt provider children already running
- takes effect for each agent when its provider session next restarts

Only one machine-wide provider update runs at a time, and new provider children wait until the
install and self-check finish. Use the row's running-version state to distinguish the installed
binary from a child that is still using the previous version.

## Limit Kimi and Grok context cost

The **Providers** panel includes one machine-wide **Context limit** control for Kimi CLI and Grok
Build. It is global for every Anima agent using that provider; it is not copied into each agent's
Launch environment.

Anima writes the provider's supported model setting in the host user's CLI configuration:

- Kimi: `max_context_size` in the model table;
- Grok: `auto_compact_threshold_percent` in the session table, calculated from the installed
  model catalog so the automatic compaction threshold is at or below the selected token count.

The recommended choices are 256k for Kimi and 200k for Grok. A smaller window makes the provider
compact a long session earlier; **No Anima limit** removes Anima's managed cap. The change applies
when each provider session next starts, so saving it does not interrupt current work.

Anima marks the exact lines it owns and preserves the rest of each TOML file. The first explicit
save adopts an existing value for the setting it manages; choosing **No Anima limit** later removes
that adopted key. Older Anima-managed Grok `context_window` lines are removed when the setting is
next saved or applied at launch.

## Troubleshooting

### The CLI works in a terminal but onboarding says it is missing

Compare the service environment with your interactive shell. Confirm the executable is on the service `PATH`, then restart the Anima services only after existing work is idle or drained.

### The provider is present but the first turn fails authentication

Open the provider CLI directly under the same host user and complete its login flow. Do not use Anima Restart as a remedy for quota, billing, or authentication errors.

### The account shown is not the one you expected

The label reflects the provider credential store available to the Anima host user. For Claude Code,
check both the machine default in **Providers** and the optional account pin on the agent's Profile
tab. For other providers, resolve the account choice inside the provider CLI. Logging out can clear
shared credentials, configuration, MCP servers, plugins, skills, or history, so review the
provider's behavior before changing a shared machine login.

For data and credential boundaries, see [Security and data](../security-and-data.md). For adapter implementation details, see [Provider layer](../runtime-providers.md).
