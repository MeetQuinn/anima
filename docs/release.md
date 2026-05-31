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

Anima uses npm versions plus npm dist-tags to separate canary builds from stable releases.

| Channel | npm dist-tag | Example version                 | Who should use it                   |
| ------- | ------------ | ------------------------------- | ----------------------------------- |
| Canary  | `canary`     | `0.2.0-canary.20260529.36fa5d8` | Anima's own canary environment      |
| Stable  | `latest`     | `0.1.3`                         | External users and default installs |

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
4. CI publishes an immutable `@meetquinn/animactl` canary package for that commit and updates the
   `canary` dist-tag.
5. Anima's canary environment upgrades to that canary and runs it with real usage.
6. Once the canary has behaved well enough, run the stable publish workflow for the same validated
   source with the next semver version.
7. CI publishes `@meetquinn/animactl` at that version, updates the `latest` dist-tag, creates the
   matching `vX.Y.Z` GitHub release, and uploads the pinned `install.sh` asset.

Stable releases should be cut from source that already ran in canary. Early on, use the manual
GitHub Actions workflow:

1. Open **Actions -> Publish npm -> Run workflow**.
2. Enter the stable version, for example `0.1.3`.
3. Run it from the validated branch or commit.
4. After it publishes successfully, verify npm `latest`, the `v0.1.3` GitHub release, and the
   release `install.sh` asset.

The stable workflow publishes `@meetquinn/animactl` to `latest`. It also creates the GitHub tag and
release for the same source commit. The canary path publishes `@meetquinn/animactl` to `canary`
automatically on future merges to `main` once `NPM_CANARY_PUBLISH_ENABLED=true` is set as a
repository variable.

## Version Rules

While Anima is pre-1.0:

- Patch version (`0.1.2` -> `0.1.3`): bug fixes, polish, docs, small compatible behavior changes.
- Minor version (`0.1.x` -> `0.2.0`): larger user-visible features or storage/runtime changes.
- Canary version: any merge to `main` that should be validated in canary before stable.

Canary versions are immutable. Never republish the same canary version with different contents.

## Publish Safety

Before publishing a stable release:

- Run the full release checks.
- Confirm the package contents with `npm pack --dry-run`.
- Confirm no local private data, credentials, `.anima/` homes, or personal paths are included.
- Confirm the package version and git tag match.
- Confirm the release installer points at the same stable version.

The npm runtime package, `@meetquinn/animactl`, should contain built artifacts (`dist/server`,
`dist/shared`, `dist/web`) so users do not need to build Anima to run it.

The public curl installer is a thin bootstrap layer, not a second distribution channel:

```bash
curl -fsSL https://github.com/MeetQuinn/anima/releases/latest/download/install.sh | sh
```

The release asset is generated from `scripts/install.sh` with `ANIMA_VERSION_DEFAULT` pinned to the
stable version being published. It checks for Node/npm locally and then runs the matching npm package.
It does not install Node, use `sudo`, install Homebrew, or change the user's `PATH`.

## GitHub Actions Setup

Workflows:

- `.github/workflows/ci.yml`: runs build and fast tests on pull requests and `main`.
- `.github/workflows/publish.yml`: publishes `@meetquinn/animactl`. `main` publishes `canary`;
  `workflow_dispatch` publishes `latest`.

Publishing uses npm Trusted Publishing, not a long-lived `NPM_TOKEN`. The npm trusted relationship
is tied to the `publish.yml` workflow:

```bash
npm trust github @meetquinn/animactl --repo MeetQuinn/anima --file publish.yml --allow-publish
```

Keep the workflow filename stable. If it changes, update the npm trusted publisher configuration
before relying on CI publish.

When moving the public package to a new npm scope, publish and verify the new package first. Then
deprecate the old scoped package with a clear redirect message, for example:

```bash
npm deprecate @totoday/animactl "Anima's runtime now ships as @meetquinn/animactl. Use: npx -y @meetquinn/animactl start"
```
