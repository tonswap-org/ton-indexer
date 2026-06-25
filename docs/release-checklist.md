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
- Run `docker build -t ton-indexer:release .` and confirm the production image
  builds from the checked-in container contract.
- Run `npm run test:deployment-evidence-audit` and
  `npm run audit:deployment-evidence`. Before declaring the deployment
  production-ready, record the deployed image digest, deployment ID, tagged
  commit, operator, UTC smoke timestamp, and exact
  `TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production`
  result in `scripts/production-deployment-evidence.json`, set
  `status: ready` and `releaseEnabled: true`, and rerun
  `npm run audit:deployment-evidence -- --require-ready`.
- Run or confirm green CI for branch-flow audit, public artifact audit,
  TODO-debt audit, install, production dependency audit, tests, build, Docker
  image build, and OpenAPI smoke.
- Confirm `https://ti.soramitsu.io` deployment target and read-only public write
  RPC posture.
- Run `TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production`
  against the deployed service and confirm health, service-info, OpenAPI, and
  required wallet routes pass before declaring the release production-ready.
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
- Re-run `TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production`
  and confirm health, service-info, OpenAPI, balance, assets, state, and history
  endpoint coverage.
- Monitor latency, RPC error rates, cache hit rates, and response-shape errors.
