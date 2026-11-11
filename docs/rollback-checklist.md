# Rollback checklist

The release window publishes this phase's web first and switches the indexer afterward. The previous web cannot consume the new indexer contract. Keep the prior compiled indexer, manifest, database/schema, snapshots and complete journals available throughout cutover. A retained older build may still require its original native worker package and environment pins; preserve those dependencies with that build.

## Trigger and evidence

Roll back when health/readiness, current balances/anchors, history or settlement evidence fail release thresholds. Record the exact build/release/manifest identities, request and chain boundary, typed failure, component health, disk capacity and pool metrics. Preserve evidence and assign one incident owner.

## Restore service

1. Switch the reviewed proxy upstream back to the retained prior indexer process and its own prior database. Keep the new web deployed; it works with both indexer contracts.
2. If capacity required a single-worker restart, stop the failing worker cleanly and restart the retained build with its original manifest, database, runtime dependencies and port. Never point the old build at the new schema.
3. Verify proxy syntax, exact manifest service identity, chain and ledger readiness, the restored build's required Perps checks, CORS, balances, original transaction evidence and representative ledger reads. Current PxStorage uses intake/funding reads; an older build may still need its retained native worker.
4. Keep the failed build/database and all signing/release journals intact for diagnosis. Do not reset journals, infer historical proof from hashes, delete publication generations or perform an in-place schema rollback.

## Recovery

Apply a focused source fix under its owning package, run owned checks and the required full/native gates, then repeat the same web-first release ordering. Record acceptance after both cutover steps; never announce or run release acceptance in the middle of the window. Host cleanup requires current process ownership and release/capture references, not an age or directory-name heuristic.
