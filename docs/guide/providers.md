---
title: Provider setup and identity
description: Install and authenticate Claude Code, Codex CLI, or Kimi CLI for use by Anima agents.
---

# Provider setup and identity

Anima supplies the durable agent identity, chat routing, queue, memory, and activity trail. Claude Code, Codex CLI, or Kimi CLI supplies the model work and developer tools.

The provider CLI is a machine-level dependency. Anima launches the executable found on the host's `PATH` and uses that provider's existing local authentication. Provider login state is not copied into an agent home or stored by Anima.

## Choose one provider

Install and authenticate at least one before creating the first agent.

| Provider    | Official setup                                                                                                                   | Verify on the Anima host |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Claude Code | [Install and authenticate Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)                           | `claude --version`       |
| Codex CLI   | [Install Codex CLI](https://developers.openai.com/codex/cli/) and sign in with your ChatGPT account or configured API access     | `codex --version`        |
| Kimi CLI    | [Install Kimi Code CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started) and use `/login` on first launch | `kimi --version`         |

Run the verification command from the same host user and service environment that runs Anima. A CLI installed only inside another shell profile or user account may work interactively while remaining invisible to the Anima services.

## How onboarding detects readiness

The create-agent flow checks whether `claude`, `codex`, and `kimi` resolve on `PATH`.

- Missing providers are disabled.
- If one available provider exists, onboarding can select it automatically.
- If none are found, creation stops with **Install a provider first**.

Detection proves that an executable exists. The first real turn proves that its authentication and provider account are usable.

## Authentication ownership

Sign in through the provider's own CLI. Do not paste provider login tokens into an Anima agent, Slack, Feishu, or an agent env entry.

All Anima agents launched under the same host user can reach the same provider credential store unless the provider itself is configured differently. Choosing a different provider for an agent does not create a separate machine account boundary.

The **Providers** panel shows the account label or identifier when the provider exposes one safely. It never stores or displays access tokens. An unavailable usage check can still show the last account Anima identified from local credentials.

## Pick the provider for an agent

During agent creation, select the provider, model, and reasoning level. The available model choices come from Anima's supported provider catalog, not from an arbitrary model-name field.

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

## Troubleshooting

### The CLI works in a terminal but onboarding says it is missing

Compare the service environment with your interactive shell. Confirm the executable is on the service `PATH`, then restart the Anima services only after existing work is idle or drained.

### The provider is present but the first turn fails authentication

Open the provider CLI directly under the same host user and complete its login flow. Do not use Anima Restart as a remedy for quota, billing, or authentication errors.

### The account shown is not the one you expected

The label reflects the provider credential store available to the Anima host user. Resolve the account choice inside the provider CLI. Logging out can clear shared credentials, configuration, MCP servers, plugins, skills, or history, so review the provider's behavior before changing a shared machine login.

For data and credential boundaries, see [Security and data](../security-and-data.md). For adapter implementation details, see [Provider layer](../runtime-providers.md).
