# Docs Roadmap

This page tracks the shape of the documentation set. It is for maintainers deciding where a topic
belongs, not a required read for new users.

## Current Structure

**Guide** is the reader path for someone trying Anima for the first time.

- What Anima is.
- How to get it running.
- How to work with one agent.
- How a single agent works.

**Operations** is for running Anima on a real machine.

- Development, canary, and stable installs.
- Code root versus Anima home.
- Upgrade and restart behavior.
- Lower-level service operations.

**Architecture** is for contributors and coding agents changing the system.

- The one-page architecture map.
- Provider adapter boundaries.
- Activity and message display semantics.

**Maintainers** is for project process and product principles.

- Release process.
- Design model and vocabulary.
- This roadmap.

The landing page should not try to surface every document. It should keep a small set of entry
points: Get started, What is Anima, Architecture, and GitHub.

## Planned Additions

These are the highest-value gaps to fill next.

### How Your Agents Work As A Team

Where multi-agent behavior belongs: handoffs, shared Slack channels, who owns what, when an agent
should pull in another teammate, and how humans stay in charge. This should stay in Guide, not
Architecture.

### Knowledge Base

How agents write useful decisions and artifacts into the shared Knowledge Base, how humans review
and revise it, what "files are the source of truth" means, and where git is process versus runtime
behavior.

### Keep It Running

The operator-friendly version of local-first reality: host sleep, launch at login, restart, canary
versus stable, dashboard links, and how to tell whether the runtime is healthy.

### When An Agent Does Not Respond

A troubleshooting path for common failures: not invited to a channel, muted thread or channel,
host asleep, provider unavailable, Slack token or permission issue, and service not running.

### Skills And Integrations

The model for third-party capabilities such as email or GitHub. Anima should not need to build every
integration into core; it should expose a governed way for skills and tools to give agents new
capabilities without handing them raw credentials or bypassing audit boundaries.

### Architecture Deep Dives

Split the current architecture roadmap into focused pages as each area stabilizes:

- runtime and active-run follow-ups;
- routing, attention, mute, and audit;
- Knowledge Base registry and API;
- provider adapters and usage reporting;
- activity and message schemas;
- storage and data model.
