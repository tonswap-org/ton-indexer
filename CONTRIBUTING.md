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

Use Node 22. For this audit/release phase, set `npm_config_offline=true`, edit only the package's assigned paths and run its named scripts plus scoped TypeScript check. Do not install, uninstall, audit or fetch packages in the shared worktree; retain node_modules unchanged. Dependency cleanup edits package files by hand and verifies an offline install in an isolated scratch copy. Capture verification requires a canonical physical sibling contract root: copy its frozen contracts and opcode configuration into the scratch area and verify their bytes. A symlinked root does not satisfy capture verification. The original contract repository stays read-only.

Whole-suite and native-database checks belong to stage gates:

```sh
npm test
env -i PATH="$PATH" LANG=C npm run test:ledger
npm run build
```

Only a gate starts/stops the owned isolated PostgreSQL 16 server. Each native script uses `INDEXER_TEST_DATABASE_URL` pointing to that loopback database and owns its random schema. Keep native sections optional so the ordinary ledger suite needs only PATH and LANG. Preserve the cluster, release state and all evidence; no generic output-tree cleanup.

After package acceptance, stage and commit only explicit owned paths on the existing branch. Do not stage other agents' edits or generated files. Read the native cross-repository store/readiness contract before changing SQL, build identity inputs or public exports. CI installs and audits on its own host; that does not authorize a local registry read.

## Pull Requests

- Target `develop` for normal work.
- Target `master` only for release or hotfix PRs.
- Include API compatibility notes for endpoint, schema, or OpenAPI changes.
- Include deployment, environment, and rollback notes for production changes.
- Keep public write RPC disabled unless a release explicitly enables it.
- Do not commit secrets, local environment files, or generated build output.
