## Summary

Describe the change and why it is needed.

## Related Issue

Closes #<issue-number> (or) Relates to #<issue-number>

## Target Branch

- [ ] This PR targets `develop`
- [ ] This PR targets `master` and is a release or hotfix PR

## API Impact

- [ ] No public API change
- [ ] Backward-compatible API addition
- [ ] Breaking API change with migration notes

## Test Plan

Commands run locally:

```
npm ci
npm test
npm run build
```

Additional checks and scenarios covered:
-

## Release / Rollback Notes

Deployment impact, env changes, data compatibility, or rollback steps.

## Checklist

- [ ] Linked an issue and added a clear description
- [ ] Updated OpenAPI/docs when API behavior changed
- [ ] Added/updated tests for changed behavior
- [ ] Verified public write RPC remains intentionally configured
- [ ] No secrets or local environment files committed
- [ ] `./scripts/audit-public-artifacts.sh` passes when public artifacts or env defaults change
- [ ] No direct-to-`master` workflow is introduced
