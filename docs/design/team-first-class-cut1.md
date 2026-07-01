# Team as a First-Class Concept — Cut-1 Contract (vendored, version-pinned)

This is the **verbatim** "v1 Cut-1 — build-to-see" section of the strategic PRD
`anima-team/prds/team-first-class.md`, committed at `26e3f83` so it does not drift under
implementation. It is vendored here so the code PR, Milo's runtime/config gate, and Iris's
product gate all target one version-pinned acceptance contract.

Greenlit 2026-07-01 (totoday). Owner: Nora (full vertical). Review: Milo (runtime/config).
Product / verification gate: Iris.

---

## v1 Cut-1 — build-to-see (greenlit 2026-07-01)

totoday moved this from 先不急 to build-a-thin-cut-and-iterate over a 2026-07-01 DM design
pass. This section captures the decisions locked in that pass, then the bounded first cut,
lanes, and acceptance. The strategic model in the full PRD still holds; this is the
execution layer.

### Locked decisions (2026-07-01 DM pass)

- **Default team + progressive disclosure.** "team" is a use-it-when-you-need-it concept,
  not an onboarding concept. At 1 team the UI shows zero team chrome (no switcher, no
  grouping, no team-name field) — identical to today's flat agent list. The default team's
  name + home are auto-assigned, so creating the first agent asks nothing about teams. Team
  UI appears only when a 2nd team is created (it should feel like an upgrade, not a config
  chore).
- **Migration = one default team.** On upgrade, all existing agents on the server go into a
  single default team. The Anima/Quinn split is done manually later, NOT auto-seeded.
- **team binds to its KB, not to a Slack workspace.** A team's only hard binding is its KB
  (`$TEAM_HOME`, the inhabited tree; root = shared docs, `agents/*` = member subtrees). The
  Slack workspace is per-agent connection config (each agent's bot token decides which
  workspace); one Slack workspace hosts N teams. Team definition = "a set of member agents +
  a KB." Which Slack channels a team's agents live in is an emergent result of the member
  agents' Slack config, not a team property.
- **Create-team entry = top-left team switcher menu** (Slack / Linear / Notion / Discord
  pattern). Discoverable even at N=1 as the graduation entry into teams. Kept separate from
  "+ New agent" (high-frequency, in the agent-list header) to avoid two-plus confusion and
  reinforce agent = daily / team = scale.
- **Dashboard: visibility != switching.** The sidebar shows ALL teams as collapsible groups
  with their agents visible by default (fold what you don't care about). The top-left team
  switch sets the current WORKING CONTEXT (main-panel focus + where "+ New agent" lands); it
  is NOT a visibility gate. You never switch teams just to SEE another team's agents. Mantra:
  look != switch; switch = focus + where the new agent goes.
- **Day-to-day separation** between teams in one Slack workspace comes from normal Slack
  channel membership (an agent only receives messages from channels it belongs to); no extra
  isolation layer is built.
- **Reference KB** (cross-team read-only consultation) = a manual, user-added feature, not
  v1-core.

### Cut-1 scope (build first, to see the shape)

1. **team as a config attribute**; all current agents backfilled into one default team
   (zero-cost migration, single team).
2. **Top-left "+ New team"** + **add-existing-agent-to-team** + **create-agent-in-team**
   (new agent home = `$TEAM_HOME/agents/$AGENT_NAME`, matching the current layout).
3. **Collapsible grouped sidebar** (N=1 flat, no group headers; N≥2 grouped) + **team switch
   that sets working context, not visibility**.

### Deferred past cut-1

- **Scoped injection** (team KB → member-agent context) — runtime work, heavier, invisible
  in the shell → phase 2.
- **Query dependency-graph** (which agents depend on which docs/conventions) — later.
- **Reference KB** — later / manual.
- **Cross-workspace agent bus** — deferred.

### Lanes (greenlit 2026-07-01, totoday's staffing call)

- **Nora** — owns the full vertical cut-1: runtime team-attribute + membership +
  one-default-team migration, plus the dashboard grouping / switcher / create-flow. She is
  full-stack; single owner = a coherent slice with no cross-lane handoff.
- **Milo** — reviewer, with real runtime-domain scrutiny (not a rubber stamp): how the team
  attribute enters the config schema, the one-default-team backfill on upgrade, and no
  restart / migration regressions.
- **Iris** — this spec + product / verification gate.

### Runtime contract (locked with Milo, 2026-07-01)

- Team registry in root/server config as stable ids: `{ id, name, home }`.
- Agent config stores only `teamId`, not team name/home. Name/home can change without
  touching every agent config.
- Default team id is deterministic (`default`), not generated per install — so legacy
  backfill and tests are stable.
- `home` is normalized/resolved at the config boundary, then validated before create-agent
  writes anything under `$TEAM_HOME/agents/$AGENT_NAME`.
- If an agent config references a missing/dangling `teamId`, the read path degrades to the
  default team and surfaces a repairable config warning — it must not crash the dashboard or
  runtime.
- Zero-touch upgrade: old configs with no team field load cleanly; no forced agent restart
  just because a team field appears. Existing agent homes are never moved (team = a label at
  migration).

### Acceptance (cut-1)

- At N=1, the dashboard is visually identical to today (no team chrome); all existing agents
  belong to the auto-created default team.
- Can create a 2nd team from the top-left; can add an existing agent to it and create a new
  agent inside it (home lands at `$TEAM_HOME/agents/$AGENT_NAME`).
- At N≥2, the sidebar groups agents by team, groups collapse/expand, and all teams' agents
  are visible without switching.
- Switching teams changes working context (main-panel focus + default target for
  "+ New agent") but never hides another team's agents, and never breaks direct
  `/agents/<id>` routes or bookmarks.
- Upgrade path: an existing install backfills to one default team with no data loss and no
  forced-restart surprise. Legacy agent configs with no team field load cleanly.
- Deliberately left to tune after it is clickable: fold-default (expanded vs collapsed) and
  exact per-team main-panel content.
