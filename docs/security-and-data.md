---
title: Security and data boundaries
description: Understand what Anima stores locally, what reaches chat platforms and AI providers, and which controls remain the operator's responsibility.
---

# Security and data boundaries

Anima is self-hosted coordination software. Its runtime state and agent files stay on a machine you control, and Anima does not require a hosted Anima backend, database, or vector store.

Local control is not the same as isolation. Anima connects real chat platforms, AI providers, repositories, and tools. A security review should evaluate every one of those boundaries and the machine account that joins them.

## Boundary summary

| System                 | What it holds or receives                                                                                                     | Who controls it                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Anima host             | Runtime configuration and state, agent homes, installed binaries, locally available credentials, and checked-out repositories | The operator and the host operating system                  |
| Slack or Feishu        | Inbound team messages and files; outbound messages, files, reactions, and interactions sent through that platform             | Your chat workspace and its administrators                  |
| AI provider            | Turn context and the provider's tool protocol; provider-side account and session data                                         | Your provider account and the provider's policies           |
| Repositories and tools | Files, commands, API requests, and credentials the provider or agent is allowed to use                                        | The corresponding repository, service, and host permissions |
| Anima-hosted cloud     | Nothing; no hosted Anima service is required in the runtime path                                                              | Not applicable                                              |

## What stays on the host

Anima uses two local storage boundaries.

### Runtime state in `ANIMA_HOME`

The selected Anima home contains host and agent configuration plus operational records such as queues, message ledgers, provider session metadata, subscriptions, reminders, asks, activity, health, and logs. Chat credentials configured for an agent are runtime secrets on this host. Protect the Anima home with operating-system permissions and include it deliberately in backup and incident-response plans.

The default managed Anima home is `~/.anima`. A source checkout can use a different home, and production and development homes should not share state accidentally.

### Team and agent files

The default team home is `~/anima-team`; an agent normally lives under `~/anima-team/agents/<agent-id>`. Agent memory, notes, skills, knowledge bases, and ordinary work files are separate from `ANIMA_HOME` even when both are on the same disk.

This split prevents runtime cleanup from being treated as work-file cleanup, but it is not a sandbox. An agent process can access files allowed to the host user and any narrower controls applied by the provider or operating system.

## What reaches Slack or Feishu

Connected transports receive the information required to operate as team chat systems:

- messages and files posted by people or integrations;
- sender, conversation, thread, mention, and interaction metadata;
- messages, files, reactions, and asks agents explicitly send back;
- platform API calls needed for profiles, conversation context, and supported setup checks.

Anima stores local message and activity records for continuity and diagnosis. It cannot remove copies already retained by Slack, Feishu, workspace exports, notifications, or other platform integrations.

Do not paste secrets into chat. Slack and Feishu are collaboration systems, not secret stores. For a secret that must move to an agent, use the [sealed handoff flow](./agent/reference.md#transfer-a-secret): the public link carries only a one-time public key, encryption happens in the sender's browser, and the receiving agent chooses the destination key at acceptance.

## What reaches the AI provider

Anima runs the provider CLI installed on the host. The provider receives the turn input and tool protocol needed to perform the work. Depending on the task, that can include:

- the delivered message and its relevant conversation metadata;
- the agent's role, maintained memory, and selected local context;
- file content read by the provider;
- tool calls and results returned through the provider protocol.

Provider authentication remains in that provider's own local credential store and account boundary. Anima does not ask operators to paste Claude, Codex, Kimi, or Grok Build login credentials into agent chat. The Providers panel can inspect account and usage information exposed by supported local credentials, and supported upgrades refresh the machine-level provider binary without logging out or moving its configuration.

The provider's retention, training, regional, and enterprise controls are not replaced by Anima. Evaluate them under the provider account and plan you intend to use.

## Repositories and connected tools

Anima's chat-action boundary is not a universal side-effect boundary. During a turn, a provider may write files, run commands, access a repository, call an MCP server, or use another configured integration. Those systems enforce their own authentication, authorization, audit, and idempotency.

In particular:

- a Git push is governed by repository credentials and branch protections;
- a cloud or production command is governed by the credentials and policy available to the process;
- an MCP server or plugin is an additional code and data boundary;
- a shared host credential can be usable by more than one agent even when their queues and memories are separate.

Use least-privilege credentials, repository protections, review gates, and isolated operating-system accounts where the risk requires them. Anima does not claim that an agent owner, role, or team assignment is an access-control list.

## Dashboard exposure

The dashboard binds to `127.0.0.1` by default. In that default shape, only processes and browsers on the host can connect directly.

If you deliberately expose the dashboard beyond the host:

- enable dashboard authentication;
- terminate TLS at a trusted boundary;
- restrict network access to intended operators;
- treat the dashboard as access to agent configuration, activity, knowledge bases, and operational controls;
- verify that proxies do not bypass authentication or cache private responses.

Binding to `0.0.0.0`, forwarding a port, or placing the dashboard behind a tunnel changes the threat model. Anima does not make that change automatically.

## Credentials and secret handling

Different credentials have different owners:

- **Slack and Feishu app credentials** belong to an agent's transport configuration in the Anima host.
- **Provider login credentials** belong to the provider CLI's own store under the host user account.
- **Agent environment secrets** belong to the receiving agent's local environment store and should be transferred with the sealed handoff flow when they cannot be entered locally.
- **Repository, cloud, MCP, and plugin credentials** belong to those tools and should be scoped at their own boundary.

Do not move a credential merely because another storage path is more convenient. Logout, provider switching, and installation-channel changes can alter shared credential state; explicit provider operations are designed to avoid doing that implicitly.

## Audit boundary

The Activity view records Anima-mediated events: inbox and queue transitions, provider runtime activity, explicit Anima actions, reminders, subscriptions, asks, and supported diagnostics. This is useful for reconstructing what Anima received and did.

It is not a complete host audit log. Provider-native actions, shell commands, filesystem writes, Git operations, and external API calls may have their authoritative record elsewhere. If a control requires proof at one of those surfaces, collect it there as well.

Anima also cannot provide a distributed exactly-once transaction across a provider, a local command, a repository, and a chat reply. Queue recovery can retry or resume local work, but it cannot undo an external side effect that already succeeded.

## Evaluation checklist

Before using Anima for team work, decide:

- Which machine and operating-system user will run the host?
- Who can read or modify `ANIMA_HOME`, team homes, agent homes, and provider credential stores?
- Which chat workspaces and provider accounts are acceptable data processors for the intended work?
- Which repositories, MCP servers, plugins, and external tools will agents be able to reach?
- Are machine-shared credentials acceptable, or does the deployment require stronger operating-system isolation?
- What must be backed up: runtime continuity, agent memory and notes, shared knowledge, or all three?
- Which actions require human review or platform-native approval before they take effect?
- Is Anima's activity scope sufficient, and where are the authoritative external logs?
- If the dashboard is exposed, are authentication, TLS, and network controls in place?

For the runtime topology and recovery model, continue to [Architecture overview](./architecture/overview.md). For code-level storage and event paths, see [Codebase internals](./architecture/internals.md).
