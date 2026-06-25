# Rollback Checklist

Use this when a TON indexer release causes a production-impacting issue.

## Trigger

- Roll back when health, OpenAPI compatibility, balance, asset, state, history,
  or payload endpoints fail production thresholds.
- Assign one incident owner and one communication owner.

## Immediate Actions

- Identify the last known-good `master` tag and deployment artifact.
- Capture failing endpoint, request IDs, upstream RPC status, cache state, and
  deployment ID.
- Revert configuration or traffic routing first when that removes the issue.
- If code rollback is required, redeploy the last known-good artifact or prepare
  a hotfix branch from `master`.

## Hotfix Path

- Create `hotfix/<version-or-slug>` from `master`.
- Apply the smallest safe fix or revert.
- Run tests, build, audit, and OpenAPI smoke for the changed surface.
- Open a PR to `master`, tag after merge, then merge or cherry-pick back to
  `develop`.

## After Recovery

- Document root cause, affected endpoints, user impact, and prevention work.
- Update release notes and the project tracker with the final disposition.
