# Anima Web App

A React/Vite web app for a single Anima home. Shows agent activity, reminders, profile/session controls, Knowledge Base file browser, and service restart. Built into `dist/web/` by `pnpm build:ui`; served by the Node API in `server/api/`.

## Stack

| Layer        | Library                                 |
| ------------ | --------------------------------------- |
| Framework    | React 19 + TypeScript                   |
| Build        | Vite                                    |
| Routing      | React Router v7 (`createBrowserRouter`) |
| Server state | TanStack Query v5                       |
| Styling      | Tailwind CSS                            |
| Icons        | lucide-react                            |
| Date/time    | date-fns v4                             |

## Source layout

```
web/src/
├── main.tsx / router.tsx   — entry + route tree
├── api.ts                  — all API calls, centralized
├── contexts/               — global state (React Context)
├── lib/                    — pure utilities (formatters, query keys, provider availability, mrkdwn, url helpers)
├── components/             — genuinely shared UI (reused across multiple views)
└── views/                  — everything owned by a specific route
    ├── layout/             — root layout + all components it alone uses
    ├── agents/             — agent-detail views (activity, profile, reminders)
    └── kb/                 — Knowledge Base file browser
```

**Layering rule:** `components/` is for UI that's reused across multiple routes. If a component is only ever used by one route's layout or views, it lives inside that route's folder in `views/`. The distinction keeps `components/` small and `views/` self-contained.

## Route tree

```
/                                → views/layout (providers + sidebar chrome)
  agents/:agentId                → views/agents/layout (agent header + tab bar)
    activity / profile / reminders
  kb/:id/*                       → views/kb
```

URL reconciliation (auto-select first agent, fill default tab, redirect not-connected agents to profile) runs in `Layout` via `reconcileLocation` from `shared/url-routes.ts`.

## Key patterns

**All API calls** are centralized in `api.ts` via `apiRequest<T>()`. Bodyless POSTs use `{ method: 'POST' }` directly; POSTs with a body go through `jsonInit('POST', body)`, which only sets `Content-Type: application/json` when a body is present.

**Server state** is managed with TanStack Query. Query keys live in `lib/query-keys.ts` for consistency. When a mutation should refresh the web app, call `refreshDashboardData()` from `api.ts` — it invalidates all active queries so the UI re-fetches without a full page reload.

**Shared types** from `shared/` are imported directly in both server and web. Zod schemas in `shared/` are the source of truth for API contract types (e.g. `AgentConfig`, `ServerInfo`, `ProviderAvailability`); TypeScript types are derived with `z.infer<>`.

**Contexts are URL-derived**: `AgentTabContext` is read from `useLocation()` in Layout — no separate URL state store.

**Code splitting**: every view loads lazily via the route `lazy` property; no manual `React.lazy` / `<Suspense>` needed at the route level.

**`ErrorBoundary`** wraps `<Outlet>` in Layout; key resets on path change so a crash in one view doesn't trap the app.

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
pnpm lint              # ESLint
pnpm format            # Prettier (writes in place)
```
