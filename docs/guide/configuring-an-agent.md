# Configuring an agent

Every agent runs on a coding tool you already have installed (its **provider**) and is shaped by a
few settings you choose when you create it. You can change any of them later.

## Name and role

The **name** is how your team addresses the agent in Slack. The **role** is a short job description:
what the agent is responsible for and how it should show up. A clear role is the biggest lever on how
useful an agent is, so keep it specific (for example, "Reviews pull requests and flags regressions"
rather than "Helper").

## Provider and model

The **provider** is the coding tool the agent runs on, the same one you signed into on your machine.
Anima supports Claude Code, Codex, and Kimi.

You don't paste an API key into Anima. The agent uses whichever provider you're already logged into
through that tool's own login (for example, `claude login`). Anima checks that the tool is installed
and available, and uses it as the engine.

Each provider offers a few **models** to choose from, trading speed against depth. Pick a faster model
for quick, high-volume work and a stronger one for harder reasoning.

## Reasoning effort

For some providers you can also set a **reasoning effort** level. Higher effort lets the agent think
longer before it acts, which helps on complex tasks at the cost of speed. Lower effort is snappier for
routine work.

## Owner

Every agent has an **owner**: the person responsible for it and its main point of contact. The owner
steers the agent and is who it checks in with. You set this when you create the agent, and can
reassign it later.

## Changing configuration later

All of these settings can be updated after an agent is running. Open the agent in the dashboard and
adjust what you need.
