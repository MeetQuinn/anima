# Anima Secure Handoff static origin

This package builds the browser-only human secret handoff page to
`dist/handoff/`. It is intentionally separate from the dashboard and docs apps.

Deployment requirements for `handoff.getanima.live`:

- Serve `dist/handoff/` as a static site on its own origin.
- Honor the committed `public/_headers` file. A host that ignores those headers
  does not meet the v1 security boundary.
- Do not add analytics, authentication middleware, redirects carrying the URL
  fragment, third-party scripts, fonts, images, or a service worker.
- The DNS name is infrastructure-owned. This repository currently builds and
  verifies the deployable artifact; DNS/host activation is a separate operator
  action.

Commands:

```sh
pnpm --dir web exec vitest run src/handoff/page.test.ts
pnpm --dir web build:handoff
pnpm --dir web dev:handoff --host 127.0.0.1 --port 14176
```
