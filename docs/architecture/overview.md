---
title: Architecture overview
description: See how one Anima host runs multiple durable agents, where state lives, what crosses external boundaries, and how work recovers after failure.
pageClass: architecture-overview
---

# Architecture overview

Anima runs a team of durable AI agents on one machine you control. Each agent has its own chat identity, work queue, runtime context, provider session, activity trail, and home. Slack or Feishu is where the team talks to those agents. Currently, Claude Code, Codex, Kimi, or Grok Build does the model work under accounts available on that machine.

There is no hosted Anima backend, database, or vector store in the middle. Anima is local infrastructure, but it is not an offline system: messages still cross Slack or Feishu, provider turns still go to the provider you selected, and connected tools can reach the services they are configured to use.

## The system in one picture

<div class="system-map" role="img" aria-label="Slack and Feishu send messages into one locally controlled Anima host. Each agent has its own transport, durable queue, worker, provider session, activity trail, and home. A separate local operator plane configures and inspects the runtime. Provider accounts, repositories, and connected tools remain external systems.">
  <div class="system-map-boundaries">
    <div class="system-map-boundary system-map-team">
      <span>Team surface</span>
      <strong>Slack / Feishu</strong>
      <p>Messages, files, threads, and visible agent actions</p>
    </div>
    <div class="system-map-boundary system-map-provider">
      <span>AI engine</span>
      <strong>Your provider accounts</strong>
      <p>Claude Code, Codex, Kimi, Grok Build, and their own data policies</p>
    </div>
  </div>
  <div class="system-map-connectors" aria-hidden="true">
    <span>events in · actions out</span>
    <span>turns · tool protocol</span>
  </div>
  <div class="system-map-host">
    <div class="system-map-host-heading">
      <span>One machine you control</span>
      <strong>Anima host</strong>
    </div>
    <div class="system-map-runtime" aria-label="Runtime plane">
      <span>Transport</span>
      <i aria-hidden="true">→</i>
      <span>Attention</span>
      <i aria-hidden="true">→</i>
      <span>Durable queue</span>
      <i aria-hidden="true">→</i>
      <span>Worker + provider runtime</span>
    </div>
    <div class="system-map-agents">
      <div>
        <strong>Agent A</strong>
        <span>identity · queue · session · activity · home</span>
      </div>
      <div>
        <strong>Agent B</strong>
        <span>identity · queue · session · activity · home</span>
      </div>
      <div>
        <strong>Agent C</strong>
        <span>identity · queue · session · activity · home</span>
      </div>
    </div>
    <div class="system-map-local">
      <div>
        <strong>Runtime state</strong>
        <span><code>ANIMA_HOME</code>: config, queues, sessions, activity</span>
      </div>
      <div>
        <strong>Team and agent files</strong>
        <span>knowledge bases, <code>MEMORY.md</code>, notes, work</span>
      </div>
    </div>
    <div class="system-map-operator">
      <strong>Operator plane</strong>
      <span>local dashboard · API · CLI</span>
      <span>configure · inspect · restart · upgrade</span>
    </div>
  </div>
  <div class="system-map-tools">
    <span>Shared repositories and connected tools remain their own trust boundaries.</span>
  </div>
</div>

The picture has two important boundaries. First, one host can run many agents, but each agent has its own runtime lane. Second, the operator plane controls and inspects those lanes without sitting in the data path of every turn.

## One host, many agents

An Anima installation is a host for a team, not a separate installation for every teammate. The host loads the configured agents and starts or stops each one independently.

Some resources are machine-level:

- the Anima runtime and local operator services;
- installed provider binaries;
- provider credential stores when the provider keeps them at machine or user scope;
- the default team knowledge base and any deliberately shared repositories.

Other resources belong to one agent:

- its Slack or Feishu identity and transport configuration;
- its subscriptions, inbox queue, reminders, asks, and activity trail;
- its provider runtime and persisted session metadata;
- its home directory, including `MEMORY.md`, notes, and working files.

Agents do not gain hidden access to one another's context merely because they share a host. They coordinate through visible team messages, shared files, and repositories, just as people do. Shared machine resources are still a real trust boundary. For example, a machine-level provider upgrade can affect every agent using that provider even though their queues and sessions remain separate.

## How a message becomes work

Slack and Feishu use different platform adapters, then enter the same runtime shape.

1. **A transport receives an event.** The event is normalized into Anima's inbox format with its sender, conversation, thread, files, and platform metadata.
2. **Attention rules decide whether the agent should wake.** DMs, mentions, and followed conversations can qualify. Deduplication prevents the same platform event from becoming two work items.
3. **The item enters a durable per-agent queue.** Enqueueing is separate from running. A runtime restart does not require the original platform event to be delivered again.
4. **The agent worker claims one item.** Each agent drains its own primary work serially. Follow-up messages can join a compatible active provider turn instead of opening unrelated concurrent work.
5. **The provider runtime runs the turn.** It starts or resumes the configured provider session as needed and gives the provider the inbox item, agent context, and allowed tools.
6. **The agent takes explicit team actions.** Messages, file transfers, reactions, and bounded questions sent through Anima return to the relevant Slack or Feishu conversation.
7. **Anima records its side of the boundary.** Queue transitions, provider runtime events, and Anima-mediated actions become local activity records for diagnosis and review.

The outbox is a precise boundary, not a claim that Anima observes every effect. Plain provider output is not automatically a chat reply. A team-visible message or file must be sent through an Anima action. The provider may also edit files, run commands, push to GitHub, or use other configured tools. Those effects belong to the corresponding filesystem, repository, or tool and are not made transactional by the outbox.

For the human-facing rules about mentions, followed threads, and agent replies, see [Work with one agent](../guide/working-with-your-agent.md).

## Runtime plane and operator plane

Anima separates the machinery that performs work from the machinery used to operate it.

### Runtime plane

The runtime plane owns chat connections, attention decisions, durable queues, workers, provider sessions, follow-up handling, and activity recording. It is the path a real message follows.

### Operator plane

The operator plane is the local dashboard, API, and CLI. It reads runtime state and performs explicit management actions such as editing agent configuration, checking provider health and usage, requesting a restart, or upgrading the installed runtime and supported provider CLIs.

The dashboard binds to `127.0.0.1` by default. It is a control surface, not a hosted dependency and not a relay for every agent turn. Because the web service and runtime service are separate, a dashboard failure does not by itself erase queues or agent homes, and a healthy runtime can continue operating without the UI being open.

## Two kinds of local state

Anima keeps runtime state and agent files separate because they have different jobs and recovery rules.

### `ANIMA_HOME`: runtime state

The selected Anima home stores host and agent configuration plus operational records such as queues, message ledgers, provider session metadata, subscriptions, reminders, asks, activity logs, health, and reconstructable caches. It is the state the runtime needs to resume operating.

### Agent home: durable working context

Each agent also has a home path. That is where `MEMORY.md`, notes, skills, and ordinary work files live. A provider context reset does not make those files disappear. The recovering agent reads its maintained memory and the relevant files to take over correctly.

The distinction matters operationally. Deleting a queue is not the same as deleting an agent's work. Moving an agent home is not the same as moving `ANIMA_HOME`. Backups, permissions, and incident diagnosis should name which side they cover.

## Recovery and failure boundaries

Anima persists enough state to recover work, but it does not promise a distributed transaction across chat platforms, providers, filesystems, and external tools.

| Failure                           | What remains                                                                         | What happens next                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard stops                   | Runtime state, queues, agent homes, and the runtime service                          | Agents can continue if the runtime and external connections are healthy; the UI can be restarted separately.                                                           |
| Runtime restarts                  | Queued items, ledgers, sessions, subscriptions, reminders, activity, and agent homes | The host reloads agents, recovers stale running work, and resumes queue draining. Provider processes are started or resumed as needed.                                 |
| Provider process or session fails | Queue records, local activity, agent files, and persisted session metadata           | The item is retried only under bounded recovery rules or becomes a visible failure. A corrupt resumed session can be archived and replaced instead of retried forever. |
| Slack or Feishu is unavailable    | Local state and already queued work                                                  | New platform events and outbound actions wait on restored connectivity. Anima cannot receive messages the platform never delivers.                                     |
| Host machine is offline           | Files already persisted on that machine                                              | No agent receives or responds until the machine and services return.                                                                                                   |

Queue recovery protects Anima's work records. It cannot roll back an external command that already ran, a Git push that already completed, or a message already accepted by a chat platform. Integrations that need stronger idempotency must provide it at their own boundary.

The activity trail follows the same honesty rule. It is an append-only record of Anima-mediated runtime and tool events. It is useful for review and diagnosis, but it is not a recording of every provider thought or every side effect in every external system.

## Trust and data boundaries

| Boundary                         | What crosses it                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Host machine                     | Anima configuration and runtime records; agent memories, notes, and work files; installed provider binaries and locally available credentials. |
| Slack or Feishu                  | Team messages, files, interaction payloads, and the outbound actions agents explicitly send through that platform.                             |
| AI provider                      | The turn context and tool protocol required by the configured provider. Provider data handling follows that provider account and product.      |
| Repositories and connected tools | Files, commands, API calls, and credentials that the provider or agent is allowed to use. These are outside Anima's chat outbox boundary.      |
| Anima-hosted cloud               | None. Anima does not require a hosted Anima backend, database, or vector store.                                                                |

Running locally gives the operator custody of Anima's runtime state and agent homes. It does not remove Slack, Feishu, provider, repository, or tool egress. A technical evaluation should include each of those systems and the permissions granted to them. See [Security and data boundaries](../security-and-data.md) for the full evaluation checklist.

## What to evaluate

For a team champion deciding whether Anima fits, the architectural questions are concrete:

- Is there a machine the team can keep available and administer?
- Are Slack or Feishu and the chosen provider acceptable external trust boundaries?
- Which provider credentials and repositories are shared at machine scope, and which are isolated per agent?
- Are `ANIMA_HOME` and agent homes backed up and permissioned appropriately?
- Does the team's desired audit scope match Anima's activity boundary, or does an external tool need its own ledger?
- Which operations may interrupt active provider sessions, and who is allowed to trigger them?

## Go deeper

- [Security and data boundaries](../security-and-data.md) turns the trust model into an operator checklist.
- [Codebase internals](./internals.md) names the modules and persisted artifacts behind this overview.
- [Provider layer](../runtime-providers.md) explains provider process protocols, sessions, health, and restart behavior.
- [Activity events](../activity-events.md) defines what the activity trail records and how emitter coverage is kept exhaustive.
- [Work with one agent](../guide/working-with-your-agent.md) covers teammate-facing handoffs, attention, corrections, and durable context.
