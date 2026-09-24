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
- `src/ledger/` and `sql/ledger.sql`: PostgreSQL account ledger with independent chain-verified backfill, immutable cursor snapshots, and explicit decoding gaps. Configure `INDEXER_DATABASE_URL`; run `npm run bootstrap:ledger` and `npm run test:ledger`. T3 settlement uses registry T3Hub/T3Root identities and exact receipt/credit evidence, including deterministic controller-owned receiver custody. A queued redemption receipt is never final delivery. Lost-ACK recovery additionally requires `LEDGER_T3_REDEMPTION_BINDING_JSON`, the unchanged qualified manifest `T3Redemption` subobject, and exact historical wallet/root/hub state transitions. Unconfigured or conflicting release code and missing archives remain unresolved; acceptance does not prove payout or journal cleanup. Perps requires explicit `LEDGER_PERPS_ENGINE_CODE_HASH` bound to the current registry engine; exact historical code/state and typed payout evidence are mandatory. Booked collateral/funding are contract claims, while position margin is a subset and must not be counted twice. Financial amounts are atomic strings. Never infer a product settlement from a transfer request or claim portfolio/tax completeness from account history alone.

## What This Repo Is (and Isn’t)

Option lifecycle qualification uses `LEDGER_OPTIONS_CODE_HASHES_JSON` with exactly the current factory, vault, Shout, Outperformance and wallet Cell hashes. Registry identities and historical state must match. Exercise right retirement, actual holder payout and RiskVault reimbursement are separate facts. `ReleaseCollateral` never supplies a cash refund. An early OCRC receipt never proves a completed claim. Preserve raw fees and explicit archive/related-history gaps; owner-OBAR unwind requires original funding, historical cancellation and exact independent factory/vault cash finalizers. Initial BOYR/BBUY bounce recovery additionally requires the actual qualified failed product transaction, exact standard VM bounce, historical series/index unwind and independent physical factory return. Other automatic abort/retry recovery and expiry-only paths remain unsupported and must not fabricate payouts.
- **Is**: a runnable indexer service with in-memory storage and background workers, plus registry data.
- **Isn’t**: a production-hardened indexer yet (liteserver pool adapter and full swap/LP decoding remain partial).

## Registry Conventions
- JSON keys are stable contract roles (e.g., `DexRouter`, `DlmmPoolFactory`).
- Keep key names consistent across networks.
- `registry/mainnet.json` is intentionally a placeholder; it should be replaced with real addresses before any mainnet usage.
- `registry/testnet.json` should be refreshed whenever testnet deployments change.
- When a canonical release manifest is configured, its network and complete
  contract map must exactly match the selected registry. The service exposes the
  resulting registry and manifest hashes from `/contracts` and `/service-info`.
- First-release perps instruments bind `perpsPool`, `contractRoles.perpsPool`
  and `codeHashes.perpsPool` explicitly. Oracle pool candles use the canonical
  `perps-oracle:{marketId}` key; never substitute a spot pool by symbol. Current
  engine state requires the exact bounded 128-record oracle journal and eligibility index in the
  second market-stats reference. Older layouts are unsupported, including when
  their archived code can be replayed. Historical replay verifies commitments;
  it never authorizes an obsolete business-state decoder.
  Every receipt has the mandatory current order reference. Paid linear OPEN/CLOS
  stores the original request, full OPEN notification or empty CLOSE notification,
  native budget, terminal outcome/reason and originally requested pool. Intake
  queues the order; only an exact PRPC/PRFA, actual PRPQ bounce, or PREX continuation
  and its independent engine state boundary can prove execution. Preserve intake
  position separately from callback position, price and funding from the callback
  market, and physical payout finalization independently. Debt conservation starts
  at the callback before-market deficit, never at the refreshed after-market value. Every market requires
  the third stats reference containing the mandatory int64 funding
  accrual remainder in [0, 3600) and oraclePriceHealthy bool; never default omitted
  fields. Accepted linear execution requires a healthy callback market price,
  independently of an overlay that halts opening new risk. Funding
  index and position units remain unchanged. Derived-market economics
  require their own qualification; linear formulas never certify them. Run the real
  oracle execution fixtures via `npm run test:ledger` after perps changes.

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
Current sale roots require their exact SLF1, SLB1 or SLA1 model tag, nested
configuration/metric cells and the bonding entry's bounded fill count. Older
untagged or inline layouts are rejected. Bonding entitlements use exact cumulative
linear-curve rounding and the maximal quantity for the physical payment, never
spot-price division.
Original contribution, historical entitlement and reserve changes, independent
wallet delivery and sale finalization are required. A terminal journal status
can also mean retired failure; never infer cash from it. Keep original purchase
movements at their original time, creator insurance returns separate, unsupported
models/retries explicitly unresolved, and recorded factory provenance distinct
from verified authority. Run `npm run test:ledger:launchpad` after changes.

Historical DLMM execution observations use `LEDGER_MARKET_BINDINGS_JSON`: an
array of exact `network`, `pool`, `poolCodeHash`, `walletCodeHash`, `tokenT`, and
`tokenX`, `tokenTCodeHash`, `tokenXCodeHash`, and mandatory paired `router` /
`routerCodeHash` deployment bindings (both null for direct-only markets). The pool-seeded graph reads durable physical account
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

Public testnet report regression checks: run `npm run test:report`. Registry sync
requires one canonical release manifest and replaces the complete map. Never infer
jetton decimal precision from symbols or expose swap minimum output as received.
Metrics require admin authentication; proxy-generated errors must preserve CORS.

Perps bounded-range retries use the sole canonical range schema with generation
ordering, persisted backoff and retry timestamps. Uncursored polls after retryAfter
may admit a new generation for identical bounds; failed rows and published cursor
snapshots remain immutable. Backoff is 5–300 seconds, one active generation per
exact scope, and 128 active jobs per network. Never add old-schema defaults or
mutate a published range to recover unavailable archive evidence. Run
`src/scripts/ledger-perps-retry-test.ts`, `src/scripts/ledger-perps-recovery-test.ts`
and the full ledger suite after changes. Startup and five-second sweeps resume
durable due pending/crashed-running work without clients. The queue is bounded at
64 jobs and two workers per service; all processes share generation locks. Head
waits persist exponential backoff; active generations expire after 15 minutes from
admission under the same lock, including abandoned bindings. Never decode another
binding, retire a live locked collector, or alter failed/published generations.

Current DLMM paired adds require both vault and notification-commitment references.
An occupied side stores H(DLRF, pool, source pool wallet, incoming created_lt,
original notification body hash); an absent side stores zero. Verify the exact
first contribution against that commitment before qualifying a mint. The sole
DLRF refund layout also carries this commitment and its replacement predecessor,
then owner and token root. Bind those fields to the typed settlement record and
pool side. Never accept the old receipt/pending layout or infer physical refunds
from their business query alone. Run `npm run test:ledger:liquidity`, the market
suite and the full ledger suite after these decoder changes.

The current DSJ1 fourth reference is the products cell: mandatory uint16
`stableAmp`, then farming, router-operation and direct-swap receipt references. Direct deployment
provenance includes its mandatory router-address reference. Canonical wallet
state/address derivation includes both mint-receipt and referral-notification
dictionaries after the burn/mint journals. Omitted products or dictionaries are
unsupported; refresh fixtures with their source bindings rather than introducing
old-layout readers. Fee-bearing swaps use the strict configured router proof. Direct swaps are
zero-fee and reserve their explicit 0.3 TON processing allowance before funding
output/refund journals. Verify the original routed request, independent pool
completion, separate fee allocation and final trader cash; no acknowledgement
alone proves wallet delivery.
Run `src/scripts/ledger-dlmm-swap-test.ts` for the frozen current-source cases.

The current oracle journal stores count:uint16, nextWireQueryId:uint64, an eligibility dictionary keyed by uint128 (eligibleAt<<64|wireQueryId), and owner receipts. Protected paid outcome1 records have no index entry. Terminal records have eligibleAt0; unpaid pending records have requestedAt+300. Reject count, unique nonce or index/receipt mismatches and obsolete ring layouts; no scan fallback.

Registered testnet perps engines require the reviewed macOS arm64 admission runtime.
Configure all four `PERPS_ADMISSION_BINARY_PATH`, `PERPS_ADMISSION_BINARY_SHA256`,
`PERPS_ADMISSION_CONFIG_PATH`, and `PERPS_ADMISSION_CONFIG_SHA256` values together.
Startup authenticates the chain, fresh exact-block engine state and configured code
before readiness. OPEN/CLOSE admission uses only the bounded native workers, with
authenticated account/configuration/context, a hard gas maximum, and no generic
remote-getter fallback or response cache. Preserve actual economic denial, VM exit
and gas usage separately from typed infrastructure errors. Run `npm run test:admission`
and the complete `npm test`; the ordinary build must retain owned clean-dist cleanup.
The native package is qualified and installed separately; the Linux Docker image
does not provide it or support a registered perps engine.

Current routed DLMM observations require strict RTR1/extras5/RSJ8 historical router
state and the sole RSWI/RPSX/RPSC/RPCA ordinary single-pool wire. Payer funding,
router input finalization, pool output and fee custody, pool completion ACK and
final beneficiary wallet settlement remain independent facts. The protocol fee
is not a second owner payment; intermediate router wallets are not the user's
received output. Preserve explicit incomplete owner swaps and market candidates
when any binding, historical state, callback or physical leg is unavailable. Run
`src/scripts/ledger-dlmm-routed-swap-test.ts` and the full market suite.

Current Router historical storage includes the mandatory fourth TWAP extras reference:
a creation journal with exact receipt and immutable automation-owner dictionaries.
The owner keys are domain-separated limit/TWAP business IDs; records retain the
original owner, atomic query ID and fixed queue (nullable only for manual plans).
Missing journal/owner dictionaries, mismatched receipt identities and trailing
fields are not accepted as older layouts. Native TWAP browser completion uses the
strict contract receipt plus physical wallet evidence; generic missing-plan reads
are never settlement evidence.
