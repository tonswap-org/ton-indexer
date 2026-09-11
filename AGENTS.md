# AGENTS

## Overview
This repository contains a **TypeScript TONSWAP indexer service** plus the design/roadmap reference. The authoritative design and API contract still live in `roadmap.md`, but there is now runnable code in `src/`.

## Repo Structure
- `README.md`: setup, run, and API overview.
- `roadmap.md`: detailed architecture, API shape, storage model, and phased roadmap.
- `registry/mainnet.json`: **placeholder** addresses for mainnet contracts (must be replaced).
- `registry/testnet.json`: known testnet contract addresses.
- `registry/localnet.json`: empty bootstrap registry; local release runs should point
  `INDEXER_REGISTRY_PATH` at a generated registry and
  `INDEXER_RELEASE_MANIFEST_PATH` at the matching canonical manifest.
- `src/`: TypeScript implementation (server, store, data source, workers, API).
- Snapshots: optional JSON snapshots for in-memory state are supported via `SNAPSHOT_PATH` + `SNAPSHOT_ON_EXIT`.
- `src/ledger/` and `sql/ledger.sql`: PostgreSQL account ledger with independent chain-verified backfill, immutable cursor snapshots, and explicit decoding gaps. Configure `INDEXER_DATABASE_URL`; run `npm run bootstrap:ledger` and `npm run test:ledger`. SCCP identity bindings use `LEDGER_SCCP_ASSETS_JSON`; TON-local bridge stages never certify remote receipt or reverse-route support. T3 settlement uses registry T3Hub/T3Root identities and exact receipt/credit evidence, including deterministic controller-owned receiver custody. A queued redemption receipt is never final delivery. Lost-ACK recovery additionally requires `LEDGER_T3_REDEMPTION_BINDING_JSON`, the unchanged qualified manifest `T3Redemption` subobject, and exact historical wallet/root/hub state transitions. Unconfigured or conflicting release code and missing archives remain unresolved; acceptance does not prove payout or journal cleanup. Perps requires explicit `LEDGER_PERPS_ENGINE_CODE_HASH` bound to the current registry engine; exact historical code/state and typed payout evidence are mandatory. Booked collateral/funding are contract claims, while position margin is a subset and must not be counted twice. Financial amounts are atomic strings. Never infer a product settlement from a transfer request or claim portfolio/tax completeness from account history alone.

## What This Repo Is (and Isn’t)

Option lifecycle qualification uses `LEDGER_OPTIONS_CODE_HASHES_JSON` with exactly the current factory, vault, Shout, Outperformance and wallet Cell hashes. Registry identities and historical state must match. Exercise right retirement, actual holder payout and RiskVault reimbursement are separate facts. `ReleaseCollateral` never supplies a cash refund. An early OCRC receipt never proves a completed claim. Preserve raw fees and explicit archive/related-history gaps; owner-OBAR unwind requires original funding, historical cancellation and exact independent factory/vault cash finalizers. Initial BOYR/BBUY bounce recovery additionally requires the actual qualified failed product transaction, exact standard VM bounce, historical series/index unwind and independent physical factory return. Other automatic abort/retry recovery and expiry-only paths remain unsupported and must not fabricate payouts.
- **Is**: a runnable indexer service with in-memory storage and background workers, plus registry data.
- **Isn’t**: a production-hardened indexer yet (liteserver pool adapter and full swap/LP decoding remain partial).

## Registry Conventions
- JSON keys are stable contract roles (e.g., `ClmmRouter`, `ClmmPoolFactory`).
- Keep key names consistent across networks.
- `registry/mainnet.json` is intentionally a placeholder; it should be replaced with real addresses before any mainnet usage.
- `registry/testnet.json` should be refreshed whenever testnet deployments change.
- When a canonical release manifest is configured, its network and complete
  contract map must exactly match the selected registry. The service exposes the
  resulting registry and manifest hashes from `/contracts` and `/service-info`.

## Related Context (External Repos)
The roadmap references sibling repos for contract definitions and UI alignment:
- `../tonswap_tolk`: source of opcodes and contract addresses.
- `../tonswap_web`: UI expectations for tx history fields.

## Editing Guidance
- If you add implementation code, update `README.md` with build/run instructions.
- If you add new registries or configuration, document their purpose and update this file.
- Keep `roadmap.md` as the canonical design reference unless an implementation doc supersedes it.


Launchpad participation and fixed-sale refund qualification uses `LEDGER_LAUNCHPAD_CODE_HASHES_JSON`
with exactly the deployment-qualified `fixedCodeHash`, `bondingCodeHash`,
`auctionCodeHash` and `walletCodeHash`. Model identity is explicit; never try a
different layout when the qualified model parser rejects a state. Participation
requires the exact original owner message, physical payment debit/credit and
historical participant-entry change. Repeated query IDs are not deduplication
identities; distinct original transactions can be accepted independently.
Original contribution, historical entitlement and reserve changes, independent
wallet delivery and sale finalization are required. A terminal journal status
can also mean retired failure; never infer cash from it. Keep original purchase
movements at their original time, creator insurance returns separate, unsupported
models/retries explicitly unresolved, and recorded factory provenance distinct
from verified authority. Run `npm run test:ledger:launchpad` after changes.

Historical DLMM execution observations use `LEDGER_MARKET_BINDINGS_JSON`: an
array of exact `network`, `pool`, `poolCodeHash`, `walletCodeHash`, `tokenT`, and
`tokenX`, `tokenTCodeHash`, and `tokenXCodeHash` deployment bindings. The pool-seeded graph reads durable physical account
chains and qualified historical state; it never reuses an owner projection or
float candles. Keep actual input consumption, unused-input refunds, output
credits and finalization separate. A pool acknowledgement is not wallet receipt.
The current wallet's transfer state is separate from its burn journal. Preserve
immutable market generations, source coverage, exact atomic ratios and explicit
unresolved candidates. Do not assume token decimals, a stablecoin peg, or a
country-approved valuation from an execution observation. Run
`npm run test:ledger:market` after changes.

Historical market precision is separate from atomic settlement. Use the strict
current JTRS/TEP-64 reader and pinned before/containing-masterchain root archives,
never the display metadata parser or today's remote URI document. Resolve only
explicit on-chain decimals or the formally applicable fully on-chain omission
default. Preserve unresolved metadata and raw economic observations together.
Qualified root code must match the reviewed immutable-content current contract;
cross-account logical times alone do not prove historical state. Root precision
archives are immutable database rows, not inferred owner scopes or root history
coverage. Keep original fixture metadata unchanged; use the dedicated explicit
6/9 fixture for resolved precision tests.
