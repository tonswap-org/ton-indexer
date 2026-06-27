# Contributing to TON Indexer

## Git Flow

All normal work starts from `develop` and is submitted back to `develop`.
Use short-lived branches named `feature/<ticket>-<slug>`, `fix/<ticket>-<slug>`,
`chore/<slug>`, or `refactor/<slug>`.

`master` is the releasable branch. Do not target `master` except for release
pull requests from `develop`, `release/*` stabilization branches, or urgent
`hotfix/*` branches. Every commit on `master` must be safe to deploy, and
release tags must point at commits already merged to `master`.

Feature PRs are squash-merged after review and green CI. Release PRs to
`master` use merge commits so the release boundary remains visible.

## Local Checks

Run these before submitting a PR:

```sh
npm ci
npm test
npm run build
```

## Pull Requests

- Target `develop` for normal work.
- Target `master` only for release or hotfix PRs.
- Include API compatibility notes for endpoint, schema, or OpenAPI changes.
- Include deployment, environment, and rollback notes for production changes.
- Keep public write RPC disabled unless a release explicitly enables it.
- Do not commit secrets, local environment files, or generated build output.
