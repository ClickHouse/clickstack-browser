# Contributing

Read the [code of conduct](CODE_OF_CONDUCT.md) and the [ClickHouse AI policy](AI_POLICY.md) first.

## Setup

1. Install the Node version in `.nvmrc` (`nvm use`).
2. `npm ci`
3. `npx playwright install chromium` (on Linux, add `--with-deps`).
4. Start Docker for the end-to-end test.

## Checks

`npm run check` runs what CI runs: spelling, formatting, lint, type checks, unit tests in Chromium,
the build, size limits, package checks, and an end-to-end test of the script-tag build against a
collector in Docker. `npm run format` fixes formatting. Add new words for the spell check to
`cspell.config.yaml`.

## Releasing

Each pull request that changes what users get adds a line under `## Unreleased` in `CHANGELOG.md`.

1. In a pull request, set the version (`npm version 1.1.0 --no-git-tag-version`) and rename
   `## Unreleased` to the version.
2. After it merges, run the Release workflow from the Actions tab and approve the deployment.

The workflow runs every check, publishes to npm with provenance (a version with a `-` suffix goes
to the `next` tag), and creates the GitHub release with the script-tag URL and its `integrity`
hash. It needs the `npm-publish` environment, limited to `main` with required reviewers, and an
npm trusted publisher for `release.yml` in that environment.
