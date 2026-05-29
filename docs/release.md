# Release Process

This document defines how changes move from development to public releases once Anima is published
as an npm package.

## Branch Policy

`main` is protected. Do not push directly to it.

Required branch protection:

- Pull requests are required before merge.
- Required checks must pass before merge.
- At least one review is required.
- Force pushes to `main` are disabled.
- Deleting `main` is disabled.

Emergency fixes should still go through a small pull request. The process can be fast, but the
merge point stays reviewable and reproducible.

## Version Channels

Anima uses npm versions plus npm dist-tags to separate dogfood builds from stable releases.

| Channel | npm dist-tag | Example version | Who should use it |
| --- | --- | --- | --- |
| Canary | `canary` | `0.2.0-canary.20260529.36fa5d8` | Anima's own dogfood/staging installs |
| Stable | `latest` | `0.1.3` | External users and default installs |

Optional later channels:

- `next`: beta or release-candidate builds that are less volatile than canary but not yet stable.
- Release branches such as `release/0.1`: only when we need to maintain an older stable line while
  `main` continues toward a larger release.

Do not publish external users onto `canary` by default. Canary is for running real Anima team usage
against the latest `main` snapshot.

## Normal Flow

1. Open a pull request.
2. Review and pass required checks.
3. Merge to `main`.
4. CI publishes an immutable `@totoday/animactl` canary package for that commit and updates the
   `canary` dist-tag.
5. Anima dogfood/staging upgrades to that canary and runs it with real usage.
6. Once the canary has behaved well enough, run the stable publish workflow for the same dogfooded
   source with the next semver version.
7. CI publishes `@totoday/animactl` at that version and updates the `latest` dist-tag.

Stable releases should be cut from source that already ran in dogfood. Early on, use the manual
GitHub Actions workflow:

1. Open **Actions -> Publish npm -> Run workflow**.
2. Enter the stable version, for example `0.1.3`.
3. Run it from the dogfooded branch or commit.
4. After it publishes successfully, tag the same source as `v0.1.3`.

The stable workflow publishes `@totoday/animactl` to `latest`. The canary path publishes
`@totoday/animactl` to `canary` automatically on future merges to `main` once
`NPM_CANARY_PUBLISH_ENABLED=true` is set as a repository variable.

## Version Rules

While Anima is pre-1.0:

- Patch version (`0.1.2` -> `0.1.3`): bug fixes, polish, docs, small compatible behavior changes.
- Minor version (`0.1.x` -> `0.2.0`): larger user-visible features or storage/runtime changes.
- Canary version: any merge to `main` that should be dogfooded before stable.

Canary versions are immutable. Never republish the same canary version with different contents.

## Publish Safety

Before publishing a stable release:

- Run the full release checks.
- Confirm the package contents with `npm pack --dry-run`.
- Confirm no local private data, credentials, `.anima/` homes, or personal paths are included.
- Confirm the package version and git tag match.

The npm runtime package, `@totoday/animactl`, should contain built artifacts (`dist/server`,
`dist/shared`, `dist/web`) so users do not need to build Anima to run it.

## GitHub Actions Setup

Workflows:

- `.github/workflows/ci.yml`: runs build and fast tests on pull requests and `main`.
- `.github/workflows/publish.yml`: publishes `@totoday/animactl`. `main` publishes `canary`;
  `workflow_dispatch` publishes `latest`.

Publishing uses npm Trusted Publishing, not a long-lived `NPM_TOKEN`. The npm trusted relationship
is tied to the `publish.yml` workflow:

```bash
npm trust github @totoday/animactl --repo totoday/anima --file publish.yml --allow-publish
```

Keep the workflow filename stable. If it changes, update the npm trusted publisher configuration
before relying on CI publish.
