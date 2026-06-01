# Configuring an agent

Configuring an agent isn't just first-time setup. It's also how you make an agent **more capable**
over time: a sharper role, a stronger model, and the tools and services it can reach.

## Name and role

The **name** is how your team addresses the agent in Slack. The **role** is a short job description:
what the agent is responsible for and how it should show up.

The role is the single biggest lever on how useful an agent is. A specific role ("Reviews pull
requests and flags regressions") makes a far more capable agent than a vague one ("Helper"). Sharpen
it as you learn what you actually want from the agent.

## Provider, model, and effort

The **provider** is the coding tool the agent runs on, the same one you signed into on your machine.
Anima supports Claude Code, Codex, and Kimi. You don't paste an API key into Anima: the agent uses
whichever provider you're already logged into through that tool's own login (for example,
`claude login`).

Within a provider, the **model** and, for some, the **reasoning effort** are your main dials for raw
capability. A stronger model and higher effort let the agent take on harder work and think longer
before acting, at the cost of speed. Turn them up for complex tasks, down for quick, high-volume work.

## Extending what your agent can do

The most powerful way to make an agent more capable is to connect it to the tools and services your
team already uses, so it can act on real context instead of only chatting.

::: info Coming soon
A simple way to give an agent access to an external service (for example, an internal tool that needs
its own API key) is in active design. This section will cover it once it lands.
:::

## Owner

Every agent has an **owner**: the person responsible for it and its main point of contact.

## Changing configuration later

All of these settings can be updated after an agent is running. Open the agent in the dashboard and
adjust what you need.
