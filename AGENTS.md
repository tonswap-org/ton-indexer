# AGENTS

## Overview
This repository contains a **TypeScript TONSWAP indexer service** plus the design/roadmap reference. The authoritative design and API contract still live in `roadmap.md`, but there is now runnable code in `src/`.

## Repo Structure
- `README.md`: setup, run, and API overview.
- `roadmap.md`: detailed architecture, API shape, storage model, and phased roadmap.
- `INDEXER_RELEASE_MANIFEST`: required native-deployer `tonswap-release-v1` file path or HTTPS URL (loopback HTTP allowed); no static registries or manual ledger pin inputs.
- `src/`: TypeScript implementation (server, store, data source, workers, API).
- Snapshots: `SNAPSHOT_PATH` is a prefix for manifest-hash-scoped JSON snapshots; old releases retain separate files. PostgreSQL ledger schemas also isolate releases.
- `src/ledger/` and `sql/ledger.sql`: PostgreSQL account ledger with independent chain-verified backfill, immutable cursor snapshots, and explicit decoding gaps. Configure `INDEXER_DATABASE_URL`; run `npm run bootstrap:ledger` and `npm run test:ledger`. T3 settlement uses manifest T3/T3Root identities and exact receipt/credit evidence, including deterministic controller-owned receiver custody. A queued redemption receipt is never final delivery. Lost-ACK recovery uses manifest-approved hub/root/wallet/receiver hashes and reserve roots, independently authenticated root/emitter and deterministic vault identities, plus exact historical wallet/root/hub state transitions. Unconfigured or conflicting release code and missing archives remain unresolved; acceptance does not prove payout or journal cleanup. Perps requires the exact current-network PerpsEngine identity/code hash supplied by the manifest; exact historical code/state and typed payout evidence are mandatory. Booked collateral/funding are contract claims, while position margin is a subset and must not be counted twice. Financial amounts are atomic strings. Never infer a product settlement from a transfer request or claim portfolio/tax completeness from account history alone.

## What This Repo Is (and Isn’t)

T3 discovery requires the sole current 18-field `vault_routes` getter: epoch,
receiver code, wallet code, then the three five-field reserve routes. Root slots
are 3, 8 and 13. Recovery bindings authenticate both code cells; the old 17-field
layout is unsupported. Receiver discovery failures remain custody gaps without
hiding independently verified mint hub/root identities.

Option lifecycle qualification uses manifest-approved factory, vault, Shout, Outperformance and wallet Cell hashes. Deployment identities and historical state must match. Exercise right retirement, actual holder payout and RiskVault reimbursement are separate facts. `ReleaseCollateral` never supplies a cash refund. An early OCRC receipt never proves a completed claim. Preserve raw fees and explicit archive/related-history gaps; owner-OBAR unwind requires original funding, historical cancellation and exact independent factory/vault cash finalizers. Initial BOYR/BBUY bounce recovery additionally requires the actual qualified failed product transaction, exact standard VM bounce, historical series/index unwind and independent physical factory return. Other automatic abort/retry recovery and expiry-only paths remain unsupported and must not fabricate payouts.
- **Is**: a runnable indexer service with in-memory storage and background workers, plus release-manifest bindings.
- **Isn’t**: a production-hardened indexer yet (liteserver pool adapter and full swap/LP decoding remain partial).

## Release Manifest
- The sole runtime input is required `INDEXER_RELEASE_MANIFEST`, using schema `tonswap-release-v1`. Singleton entries are exact address/codeHash objects; reserves use USDT/USDC/KUSD token roles and the hub role is T3. Network/globalId and manifestHash must validate. No registry files, ledger pin environment variables, opcode file loading or parity checks are supported.
- Poll every five seconds. Stop the old child worker before starting a changed manifest in a fresh process. Snapshots and PostgreSQL schemas are scoped to manifestHash; never resume old jobs under new bindings or delete retained release state.
- `/contracts` and `/service-info` expose `release: { releaseId, manifestHash }`. Opcode definitions are bundled. Runtime ledger limits use `INDEXER_MAX_WATCHED_ACCOUNTS`, `INDEXER_MAX_PAGES_PER_SYNC` and `INDEXER_MAX_RELATED_ACCOUNTS`.
- Native service metadata derives its public URL and service ID from the current manifest's `services.indexer`; config identity/URL only describes standalone services. Advertise fresh reads only with exact current native network/release/hash bindings. Never default metadata to an unrelated public deployment. Public discovery, OpenAPI paths and docs use that exact manifest mount. Backend routes remain `/api/indexer`; an externally reviewed proxy maps a distinct public mount to them without redirecting to another release. Production smoke derives the mount and public identity from its pinned manifest, and rejects a conflicting explicit mount. Run `npm run test:public-mount` and `npx tsx src/scripts/production-smoke-adversarial-test.ts` after mount changes.
- First-release perps instruments bind the declared market ID and symbol to
  the explicit spot pool and `templates.DlmmPool` code hash. Oracle pool candles use the canonical
  `perps-oracle:{marketId}` key; never substitute a spot pool by symbol. Current
  engine state requires the exact bounded 128-record oracle journal and eligibility index in the
  second market-stats reference. Older layouts are unsupported, including when
  their archived code can be replayed. Historical replay verifies commitments;
  it never authorizes an obsolete business-state decoder.
  Every position counterparty reference contains exactly four coins in order:
  reserved, pendingFunding, collectedLoss, remainingEntitlement. No three-coin
  fallback is supported. Physical LP backing is 2N and cumulative gross positive
  price/funding entitlement starts at actual fill N; funding cancellation consumes
  entitlement, partial exits retire its closed share, and only actual new gross
  fills add it. Bind the fourth coin into oracle position commitments and expose
  mandatory remainingEntitlementRaw. Margin deposits cannot reset it and withdrawals
  retain entry principal N. Pure synthetic vectors never replace current native
  fixture provenance or establish a universal LP zero-loss guarantee.
  Engine extras retain the exact uint32-to-referenced-cell pending risk-policy
  dictionary after collectors and T3. Only absent market slots 2-4 may retain
  exact unissued, blocked commitments; registered markets consume them. Reject
  pruned/malformed dictionaries, trailing fields, nonempty lease credit and
  registered-market overlap. Pending commitments are not executable leases.
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
- If you change manifest bindings or configuration, document their purpose and update this file.
- Keep `roadmap.md` as the canonical design reference unless an implementation doc supersedes it.


Launchpad participation and fixed-sale refund qualification uses the manifest's
deployment-qualified `SaleFixed`, `SaleBonding`, `SaleAuction` and
`JettonWallet` template hashes. Model identity is explicit; never try a
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

Historical DLMM execution observations use manifest spot-market identities,
explicit token-root code pins, pool/wallet templates and the router singleton.
Missing root code pins leave the market unqualified. The pool-seeded graph reads durable physical account
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

Public testnet report regression checks: run `npm run test:report`. The running
worker's release identity must match its canonical manifest. Never infer
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

Current Pool metadata is exactly 653 bits with the mandatory two-bit protected
wallet acknowledgement mask after feeClaimedX; constructor mask is zero.
Router durable storage includes the mandatory nullable canary owner, and each
settlement group includes its mandatory refund owner. Direct-fee routed swaps
allocate both the beneficiary and the exact zero-reward RFFL FeeRouter transfer.
When both use the T3 wallet, beneficiary dispatch follows the fee's authenticated
finalization through the source queue. Preserve both physical fee legs and that
queue transition; never count two allocations as a second user payment or accept
an old one-record/immediate-dispatch layout.

Capture qualification uses retained pure-build manifests and per-target Tolk
import closures (`src/scripts/capture-build.ts`), not a union of producer sources.
Authenticate every executed/embedded compiled identity and its original bytes;
keep transaction BOCs, state commitments and historical rejection fixtures intact.
Never import removed native scripts/release helpers, trust transient build output,
claim historical producer-source locks absent from the receipt, or add a provisional
bypass. Capture evidence and runtime admission are separate: this migration does
not relax the macOS arm64 admission binary/configuration requirements. Run
`npm run test:capture-build`, all ledger checks, the full suite and the ordinary
clean-dist build after capture verifier changes.
