# Concepts

This page owns Anima's public vocabulary. Other pages explain these concepts in context and link here instead of giving them a second definition. If a term means something different elsewhere in the docs, one of the pages has drifted.

## People and structure

**Agent.** A durable teammate identity with a name, role, provider, agent home, and memory. An agent appears in each connected chat system as its own account. Product copy sometimes says “AI teammate”; it means this agent.

**Team.** A named group of agents with a shared team home and one or more knowledge bases. Roles divide responsibility, but a team is not a permission system. An agent can still act with the operating-system and connected-tool access available to its process.

**Owner.** The human responsible for steering one agent and serving as its main point of contact. The owner is not a security boundary and does not make the agent private to that person.

**Operator.** The human responsible for the Anima installation: its machine, runtime, dashboard, configuration, updates, and recovery. The operator and an agent's owner are often the same person, but the responsibilities are different.

**Team home.** The folder where a team keeps shared files. The default team home is `~/anima-team`. New agents normally get homes under that team's `agents/` directory. Changing a team's home changes the default for future agents; it does not silently move existing agent files.

**Agent home.** The folder that holds one agent's `MEMORY.md`, notes, skills, and working files. By default it is `~/anima-team/agents/<agent-id>`. It is deliberately separate from the Anima home.

**Knowledge base (KB).** A folder of plain files, usually Markdown in git, that a team uses for shared decisions, context, and durable artifacts. Agents can author it; humans govern it through the same file and repository controls they use for other team knowledge.

## Runtime and operation

**Anima home.** The runtime authority selected by `ANIMA_HOME`, a local `.anima` directory when one exists, or `~/.anima` by default. It holds runtime configuration and records such as queues, message ledgers, sessions, subscriptions, reminders, asks, activity, health, and logs. It does not own the agent home merely because both live on the same machine.

**Host.** One running Anima installation and the machine account that owns it. A host can manage multiple agents. Some resources, including installed provider binaries and provider credential stores, may be shared at host or operating-system user scope.

**Runtime plane.** The services that receive chat events, decide attention, persist work, run agent turns, manage provider sessions, and record activity.

**Operator plane.** The local dashboard, API, and CLI used to configure and inspect the runtime. It controls the runtime plane but is not a relay through which every agent turn must pass.

**Runtime.** The managed Anima code installed under the selected Anima home and executed by the host services. A source checkout can run a separate development runtime against a separate Anima home.

**Release track.** The update stream followed by a managed runtime: `stable` or `canary`. A `dev` runtime runs from source and is not an update track.

**Dashboard.** The local operator UI for creating and configuring agents, inspecting activity and health, managing providers, and stepping in. It binds to `127.0.0.1` by default.

**Provider.** The coding-agent CLI that runs an agent's model work, currently Claude Code, Codex, or Kimi. Anima starts the installed provider under the host user account and uses that provider's own authentication and data boundary.

**Transport.** A connected team-messaging system, currently Slack or Feishu. Each transport receives platform events and carries explicit outbound actions back to the team.

**Skill.** A packaged capability with instructions and optional supporting files that an agent checks before specialized work. Skills are for reusable capability; notes are for local knowledge and history.

## Work and attention

**Wake.** An event that gives an agent work. A qualifying chat message, reminder, answered ask, onboarding event, or memory pass can create a wake.

**Inbox item.** The durable work record created from a wake. It carries the source context and moves through queued, running, and terminal states.

**Turn.** One pass through the provider for an inbox item. A turn can use tools and can receive compatible follow-up messages while it is active.

**Subscription.** A durable record that an agent follows a channel or thread on a transport. DMs and direct mentions reach the agent regardless. Channel membership and thread involvement create the normal follow behavior; a mute stops background wakes until the agent is addressed directly again.

**Follow.** The state in which later messages in a channel or thread can wake the agent without another mention.

**Mute.** The agent action that stops following a channel or thread. Anima does not silently mute a conversation on an agent's behalf, and a DM or direct mention still reaches it.

**Primary session.** The agent's continuous provider context across DMs, channels, and threads. It is not one provider session per conversation. A session may compact, resume after restart, or be archived and replaced when recovery requires a clean context.

**Follow-up.** A later inbox item that belongs to an agent's active work and can be appended to the current provider turn instead of waiting as unrelated primary work.

## Actions and audit

**Anima action.** An explicit action an agent takes through Anima, such as sending or updating a message, sending a file, reacting, asking a bounded question, scheduling a reminder, or changing a subscription. Plain provider output is not itself a chat reply.

**Ask.** A bounded decision sent to a human: yes/no, approve/reject, or one choice from a short list. It is for a decision, not an open-ended discussion.

**Reminder.** A persisted future wake with instructions and a schedule. A reminder wakes the agent privately; it is not an instruction for Anima to post a message by itself.

**Activity.** The append-only local record of Anima-mediated runtime and tool events shown in the dashboard. It is useful for diagnosis and review, but it is not a complete recording of every provider thought or every side effect in external systems.

## Memory

**`MEMORY.md`.** The recovery index in an agent home: role, preferences, key knowledge, active context, and open obligations. It is authoritative over provider-native memory after a context reset.

**Memory pass.** A scheduled private wake in which an agent reviews and maintains its own `MEMORY.md`. Long-lived detail moves into notes; current obligations remain sharp. A pass does not post to the team unless the agent explicitly takes an outward action.

## Delivery language for agents

**Delivery prompt.** The complete input Anima hands to an agent for one wake.

**Envelope.** The bracketed machine facts in a delivered chat message, such as channel, thread, message timestamp, sender, and local time.

**Body.** The human or system content that caused the wake.

**Anima note.** Runtime guidance prefixed with `Anima note:`. It informs the agent about delivery or coordination state; it does not act on the agent's behalf.

## Retired terms

Use one current name in new docs and code comments:

- “memory-coherence pass”, “memory tidy”, or “Dream pass” → **memory pass**
- “Attention suggestion”, “Anima system message”, or “Anima system note” → **Anima note**
- “prerelease” as an update track → **canary**
- “workspace” as a product-level storage concept → use **team home**, **agent home**, **Slack workspace**, or **repository**, whichever fact is meant
