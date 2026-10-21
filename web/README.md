# Anima Web App

A React/Vite web app for a single Anima home. Shows each agent's activity, channels, files, profile and reminders, the Knowledge Base browser, and settings (server, providers, token usage, outreach limits). Built into `dist/web/` by `pnpm build:ui`; served by the Node server (`server/web/static.ts`).

## Stack

| Layer        | Library                                 |
| ------------ | --------------------------------------- |
| Framework    | React 19 + TypeScript                   |
| Build        | Vite 8                                  |
| Routing      | React Router v7 (`createBrowserRouter`) |
| Server state | TanStack Query v5                       |
| Styling      | Tailwind CSS v4                         |
| Icons        | lucide-react                            |
| Date/time    | date-fns v4                             |
| Tests        | Vitest + Testing Library (jsdom)        |

## Source layout

```
web/src/
├── main.tsx / router.tsx   — entry + route tree
├── query-client.ts         — the app's TanStack QueryClient
├── api/                    — API calls, one module per area (client.ts has apiRequest / jsonInit)
├── hooks/                  — hooks shared across views
├── lib/                    — pure utilities (formatters, query keys, provider availability, mrkdwn, url helpers, agent health wording)
├── components/             — genuinely shared UI (reused across multiple views); ui/ holds the shadcn primitives
├── handoff/                — the standalone secret-handoff page (own build: pnpm build:handoff → dist/handoff/)
├── test/                   — Vitest setup
└── views/                  — everything owned by a specific route
    ├── layout/             — root layout + all components it alone uses
    ├── agents/             — agent-detail views (activity, channels, files, profile, reminders)
    ├── kb/                 — Knowledge Base file browser
    ├── settings/           — settings pages
    ├── onboarding/         — first-run setup
    └── login.tsx           — sign-in page
```

**Layering rule:** `components/` is for UI that's reused across multiple routes. If a component is only ever used by one route's layout or views, it lives inside that route's folder in `views/`. The distinction keeps `components/` small and `views/` self-contained.

## Route tree

```
/login                           → views/login (standalone)
/onboarding                      → views/onboarding (standalone)
/                                → views/layout (providers + sidebar chrome)
  agents/:agentId                → views/agents/layout (agent header + tab bar)
    activity / files/* / channels / profile / reminders
  kb/:id/*                       → views/kb
  settings/:page?                → views/settings (standalone: no sidebar, no reconciler)
    server / providers / token-usage / outreach-limits
```

URL reconciliation (auto-select first agent, fill default tab, redirect not-connected agents to profile) runs in `Layout` via `reconcileLocation` from `shared/url-routes.ts`.

## Key patterns

**API calls** live in `api/`, one module per area, and all go through `apiRequest<T>()` in `api/client.ts`. Bodyless POSTs use `{ method: 'POST' }` directly; POSTs with a body go through `jsonInit('POST', body)`, which only sets `Content-Type: application/json` when a body is present.

**Server state** is managed with TanStack Query. Query keys live in `lib/query-keys.ts` for consistency. After a mutation, invalidate the queries it changed. `refreshDashboardData()` in `api/agents.ts` re-fetches the agent list and statuses; `refreshAgentData(agentId)` also re-fetches that agent and its sessions.

**Shared types** from `shared/` are imported directly in both server and web. Zod schemas in `shared/` are the source of truth for API contract types (e.g. `AgentConfig`, `ServerInfo`, `ProviderAvailability`); TypeScript types are derived with `z.infer<>`.

**Code splitting**: every view loads lazily via the route `lazy` property; no manual `React.lazy` / `<Suspense>` needed at the route level.

**Errors**: a top-level `ErrorBoundary` in `main.tsx` catches render errors that escape the router; route `errorElement`s (`RouteErrorBoundary`) reload once on a chunk-load failure after an upgrade, and otherwise show the error. An `ErrorBoundary` also wraps `<Outlet>` in Layout; its key resets on _surface_ change
(`outletErrorBoundaryKey`: KB id, agent tab — not deep file paths) so a crash
in one view doesn't trap the app, while KB / agent Files tree state survives
in-surface file navigation.

## Commands

From repo root:

```bash
pnpm install           # install server + web workspace dependencies
pnpm build:ui          # build web app into dist/web/
pnpm services:start    # start API + web app using the normal Anima home
pnpm services:status   # check service health
pnpm dev:services:start # start API + web app with repo-local ./.anima-dev
```

From `web/`:

```bash
pnpm install           # still uses the repo-root workspace lockfile
pnpm dev               # Vite dev server (proxies API at :14174)
pnpm build             # production build
pnpm test              # Vitest (root `pnpm test` runs server tests only)
pnpm type-check        # tsc -b
pnpm lint              # ESLint
pnpm format            # Prettier (writes in place)
```
