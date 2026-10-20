# Release Checklist

Use this checklist for every TON indexer release PR from `develop` to `master`.

## Before The Release PR

- Confirm all release work has landed on `develop`.
- Confirm API contract, OpenAPI docs, and production environment notes are final.
- Confirm no private tokens, RPC credentials, deployment keys, or local
  environment files are committed.
- Run `bash ./scripts/test-branch-flow-audit.sh && bash ./scripts/audit-branch-flow.sh`
  and confirm the release branch flow rules still pass.
- Run `./scripts/audit-public-artifacts.sh` and confirm it passes.
- Run `bash ./scripts/test-todo-debt-audit.sh && bash ./scripts/audit-todo-debt.sh`
  and confirm no new TODO/FIXME/STOPSHIP debt was introduced.
- Run `npm audit --omit=dev` and confirm there are no production dependency
  audit findings.
- Confirm public builds work without private overlays.
- Provide the reviewed native-deployer `tonswap-release-v1` manifest through
  required `INDEXER_RELEASE_MANIFEST` (file path or HTTPS URL; loopback HTTP
  allowed). Confirm its network/globalId, addresses, approved code pins and
  canonical manifest hash validate. Do not generate a separate registry.
- Confirm the five-second manifest poll stops the old child worker before
  starting a changed release, and snapshots/PostgreSQL schemas isolate
  manifest hashes without resuming old ledger jobs under new bindings.
- Verify current Perps PxStorage and intake/funding getters in one fresh
  manifest-bound liteserver batch. Retired OPEN/CLOSE getters must fail before
  any source request. Require current native capture/ledger qualification and
  deployed execution checks; retained old worker packages are historical evidence.
- Run or confirm green CI for branch-flow audit, public artifact audit,
  TODO-debt audit, install, production dependency audit, tests, build, and
  release-bound OpenAPI smoke.
- Confirm the canonical manifest `services.indexer` public mount and the
  intended `INDEXER_ENABLE_WRITE_RPC` posture.
- For every release, pin `TON_INDEXER_EXPECTED_NETWORK`,
  `TON_INDEXER_EXPECTED_RELEASE_ID`,
  `TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH`, the canonical single-link absolute
  `TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH`, and
  `TON_INDEXER_EXPECTED_CORS_ORIGIN` to the canonical release evidence. Confirm
  both public `/contracts` and `/service-info` report
  `release: { releaseId, manifestHash }` without obsolete hash aliases.
- Run `npm run smoke:production`
  against the manifest-derived target and confirm health, service-info, OpenAPI,
  and required wallet routes pass before declaring the release production-ready.
  Preserve the complete manifest, build identity, admission and activation receipts,
  smoke output, timestamps and operator record in the durable release evidence root.
  An explicit transport target must preserve the manifest mount.
- Confirm rollback owner, monitoring owner, and release communication channel.

## Release PR To `master`

- Open the PR from `develop` or `release/<version>` to `master`.
- Include test evidence, schema compatibility notes, deployment notes, and
  rollback notes.
- Require review and green CI before merge.
- Merge with a merge commit so the release boundary is visible.
- Create the release tag only after the merge commit is on `master`.

## After Release

- Verify the deployed service is serving the tagged commit.
- Re-run `npm run smoke:production`
  with the same pinned release inputs and confirm health, service-info, OpenAPI,
  balances, state, history and candle endpoint coverage.
- Monitor latency, RPC error rates, cache hit rates, and response-shape errors.
