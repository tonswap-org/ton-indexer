# AGENTS

## Overview
This repository contains a **TypeScript TONSWAP indexer service** plus the design/roadmap reference. The authoritative design and API contract still live in `roadmap.md`, but there is now runnable code in `src/`.

## Repo Structure
- `README.md`: setup, run, and API overview.
- `roadmap.md`: detailed architecture, API shape, storage model, and phased roadmap.
- `INDEXER_RELEASE_MANIFEST`: required native-deployer `tonswap-release-v1` file path or HTTPS URL (loopback HTTP allowed); no static registries or manual ledger pin inputs.
- `src/`: TypeScript implementation (server, store, data source, workers, API).
- Snapshots: `SNAPSHOT_PATH` is a prefix for manifest-hash-scoped JSON snapshots; old releases retain separate files. PostgreSQL ledger schemas also isolate releases.
- `src/ledger/` and `sql/ledger.sql`: PostgreSQL account ledger with independent chain-verified backfill, immutable cursor snapshots, and explicit decoding gaps. Configure `INDEXER_DATABASE_URL`; run `npm run bootstrap:ledger` and `npm run test:ledger`. Fresh T3 uses the manifest T3Hub as both hub/master, T3Wallet and T3RecoveryProof templates, per-reserve master/wallet code pins and immutable profiles. Authenticate exact historical code/data and physical wallet balance changes; receipt membership and SENT/FAILED status are not cash. Hub and wallet recovery witness reconstruction requires complete linked initialization-to-head history and every current tree root. Missing original evidence is explicit unavailable. Perps requires the exact current-network PerpsEngine identity/code hash supplied by the manifest; exact historical code/state and typed payout evidence are mandatory. Booked collateral/funding are contract claims, while position margin is a subset and must not be counted twice. Financial amounts are atomic strings. Never infer a product settlement from a transfer request or claim portfolio/tax completeness from account history alone.

## What This Repo Is (and Isn’t)

T3 discovery authenticates current hub storage and per-reserve canonical TEP-74
wallet getters at one head. The hub is the token master; no separate root or
receiver ABI is supported. An optional undiscovered KUSD slot does not block the
core pair. Observed code never enrolls a new decoder. Current receipt candidates
are not physical payout evidence. Keep the runtime qualification fence until the
fresh capture and original-source closure checks pass.

Current Options ledger qualification uses the exact current factory/vault/manager,
Shout/Outperformance, T3Wallet and T3RecoveryProof release pins. Infer owner
requests from original dispatches, then authenticate historical controller and
canonical child state independently from physical T3 transfers. Premium/fee and
writer backing are accounting components, never additional cash. Right retirement
can precede payout; failed transfers retain pending cash and retry never debits
twice. Aggregate owed claims do not invent the original income source. Original
archive, cash projection and related-history gaps remain incomplete. The current
native suite replaces old Options ABI positive tests in the ordinary gate; retain
old evidence without admitting it as current. Run ledger-current-options-test.ts,
including native default/x6 economics, graph, refusal and missing-evidence cases.
- **Is**: a runnable indexer service with in-memory storage and background workers, plus release-manifest bindings.
- Product settlement support is deliberately bounded by the exact historical proof rules below; unqualified or missing evidence stays unresolved.

## Release Manifest

Fresh-consumer integration uses the current native `T3Hub` identity and explicit
per-token `masterCodeHash` and `walletCodeHash`; no global wallet template, legacy
role alias or obsolete storage fallback is allowed. Validate the entire current
manifest before deriving instruments or advertising fresh reads. The keeper is a
mandatory, unique `orderKeeper: { address }` identity; obsolete tuning fields and
null are invalid. Public indexer
mounts are exactly `/api/indexer`; responses and optional request fences bind
`x-tonswap-release` to that manifest hash. Historical product qualification notes
below do not authorize old decoders for the fresh native release. Keep the runtime
qualification fence until each current product has its own accepted evidence.

Current open-order discovery uses original authenticated factory and child
transaction boundaries plus exact same-head account envelopes. Durable snapshots
and bounded cursors preserve one release and masterchain boundary; only
genesis-linked factory history with no gaps can be complete. Current state does
not establish physical cash delivery or keeper admission. Preserve immutable
evidence across release changes and restarts, use the separate bounded orders
pool, and never replace newer publications with late work. Configuration-price
reads authenticate the original config dictionary at the exact requested current
head and select storage prices active at chain time. Do not substitute public RPC
prices, hardcoded defaults or a different head. Run `test:current-release` and
`test:current-orders` plus the retained-capture collector/discovery checks after
these changes; transport proof tests remain independent.

The current wallet-claim endpoint accepts the exact saved T3 redemption request.
Reconstruct complete original wallet history and both current sparse trees before
returning request-selected witnesses. Bind origin LT to the original owner body,
and match failure evidence only to the current attempt cell hash. The burn
WalletTerms recipient is the wallet owner; the payout recipient belongs to its
custom intent. Keep the 32-claim/32-failure and shared work limits, with explicit
incomplete coverage on overflow. Account-storage reads expose original active
ShardAccount and full configuration BOCs at the exact requested current head;
never replace storage-price history with today's price or synthesize StorageInfo.
Run the current release/API, native T3 collector and account-storage checks.

Order-wallet claim evidence uses its own exact order-settlement request and
only the current T3 input-wallet protocol. Authenticate the closed derived order,
original initialization/terms and actual funding credit before selecting failed
non-burn attempts. Preserve original transferTransaction at the first origin LT,
including across retry generations. Full order/input-wallet history and current
claim/failure roots are mandatory; unmarked failure membership requires a
separate resolved mark before retry. One aggregate 10,000-row history budget,
64 new archive boundaries and 32/32 witness limits share the evidence gate.

Current Spot operation evidence accepts the reviewed direct body, original
order-create terms or whole-order terms with an exact resolved funding dispatch.
Derive all wallet and pool identities from the current
manifest and same-head getters. Return original transaction/before/after account
cells, bounded current envelopes and explicit gaps. Normalize only legal TL-B
message placement while preserving every message field; query/body matches alone
do not link physical deliveries. The browser must separately bind the original
wallet dispatch. Factory-time startAt clamping requires the original request,
actual factory execution and exact child StateInit/initialization; mutable order
state or events alone never prove token receipt. Whole-order evidence requires
complete original order/input-wallet histories and exact funding LT/hash/body/value.
Only authenticated dictionary absence enters `absentAccounts`; missing or merely
uninitialized state never does. The narrow never-funded, zero-execution withdrawal
exception requires that absence and the original order bounce, and never invents
a wallet transaction or token credit. Historical permissionless keepers require
successful pinned order transitions. Clients retain unresolved action locks and
independently prove conservation and each physical output/refund. Spot and T3 share the live
request cap and immutable release store. Keep explicit work/size bounds and never
publish truncated-complete evidence. Run the focused Spot request, API and
retained-capture tests after changing this seam, including the current whole-order
capture matrix. Normal ten-slice captures fit the bounds; repeated failures and
larger histories remain incomplete rather than truncated-complete.

- The sole release/deployment identity input is required `INDEXER_RELEASE_MANIFEST`, using schema `tonswap-release-v1`. Singleton entries are exact address/codeHash objects; reserves use USDT/USDC/KUSD token roles and the hub role is T3Hub. Network/globalId and manifestHash must validate. No registry files, ledger pin environment variables, opcode file loading or parity checks are supported.
- Poll every five seconds. Stop the old child worker before starting a changed manifest in a fresh process. Snapshots and PostgreSQL schemas are scoped to manifestHash; never resume old jobs under new bindings or delete retained release state.
- `/contracts` and `/service-info` expose `release: { releaseId, manifestHash }`. Opcode definitions are bundled. Runtime ledger limits use `INDEXER_MAX_WATCHED_ACCOUNTS`, `INDEXER_MAX_PAGES_PER_SYNC` and `INDEXER_MAX_RELATED_ACCOUNTS`.
- Service metadata derives its public URL and service ID solely from the current manifest's `services.indexer`. There are no standalone identity/URL inputs. Advertise fresh reads only with exact current native network/release/hash bindings. Never default metadata to an unrelated public deployment. Public discovery, OpenAPI paths and docs use that exact manifest mount. Backend routes remain `/api/indexer`; an externally reviewed proxy maps a distinct public mount to them without redirecting to another release. Production smoke derives the mount and public identity from its pinned manifest, and rejects a conflicting explicit mount. Run `npm run test:public-mount` and `npx tsx src/scripts/production-smoke-adversarial-test.ts` after mount changes.
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
The HTTP listener opens before native authentication. Readiness requires the chain,
fresh exact-block engine state and configured code to authenticate; failed native
startup retries with bounded backoff without replaying an admission request. OPEN/CLOSE admission uses only the bounded native workers, with
authenticated account/configuration/context, a hard gas maximum, and no generic
remote-getter fallback or response cache. Preserve actual economic denial, VM exit
and gas usage separately from typed infrastructure errors. Run `npm run test:admission`
and the complete `npm test`; the ordinary build must retain owned clean-dist cleanup.
The native package is qualified and installed separately on its supported host.
There is no generic container deployment for this release.

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
import closures, not a union of producer sources. `src/scripts/capture-build.ts`
retains the old verifier; `current-capture-build.ts` independently qualifies 1.5
virtual opcode/vendor closures, original manifests/artifacts and completion receipts.
Never route a current capture through an old manifest or reconstruct missing producer
history.
Authenticate every executed/embedded compiled identity and its original bytes;
keep transaction BOCs, state commitments and historical rejection fixtures intact.
Never import removed native scripts/release helpers, trust transient build output,
claim historical producer-source locks absent from the receipt, or add a provisional
bypass. Capture evidence and runtime admission are separate: this migration does
not relax the macOS arm64 admission binary/configuration requirements. Run
`npm run test:capture-build`, all ledger checks, the full suite and the ordinary
clean-dist build after capture verifier changes.


## Current chain, API and ledger contract

The sole chain source is the reviewed local liteserver pool. The selected network requires an absolute local global-config file or an explicit inline peer list. No HTTP source, remote pool URL, public endpoint default, discovery service or alternate RPC proxy is supported. Configuration and admission artifacts validate before listen; chain, database and admission initialization start after listen. Listener availability never establishes ledger or native readiness. Namespace/catalog/release conflicts remain unavailable without resetting operational data.

One monotonic network-authenticated head pins each current batch. Current block time must be within 30 seconds of local time, at most five seconds ahead, with a consistent peer clock; the one-second process-head reuse window cannot extend block freshness. Unpinned preflight batches recheck block age at completion. An already pinned concurrent batch retains its original boundary without lowering the process head. Failed batches cancel active siblings and stop queued reads. Accounts carry real shard-block anchors and chain creation times; server time never supplies a chain anchor. Completed getters and balances are not cached. Snapshot reuse must be explicit and retain its original asOfSeqno; farms and volatility snapshots cannot reuse time-dependent values. Cancellation and bounded deadlines apply to callers and underlying shared work. Typed REST failures use flat `{error,code}` with honest 400/404/415/429/500/503/504 statuses and no-store; retryable 429/503/504 responses include Retry-After. JSON-RPC uses the same source and authentic anchors. Enabled BOC submission is single-attempt and never retried or hedged.

Balance rows always include GRAM and every manifest root in manifest order, with manifest decimals, atomic strings, exact head sequence/time and complete. Verified values are ok, qualified undeployed wallets are not_deployed with zero, and failed or unqualified reads are unavailable with null amounts. SSE shares one HeadFeed and at most eight simultaneous owner reads; unavailable transitions never fabricate balance changes. Display metadata is never accounting precision.

The in-process limiter accepts a visitor IP only with a valid X-TONSwap-Edge-Key and X-TONSwap-Client-IP. Otherwise it keys on the raw socket address. X-Forwarded-For is never trusted. INDEXER_EDGE_KEY requires at least 32 characters. The proxy template forwards the two headers, blocks operational endpoints, preserves application errors and streams, and supplies the exact static JSON 503 only for an unavailable backend. It does not run a second limiter.

Stored historyComplete means genesis-linked physical history, separately from current-boundary coverage. Every owner cycle pins one head; coverage.boundary uses chain time while checkedAt, headObservedAt and publishedAt are server observations. Every previously published physical graph account must remain at an equal-or-later head with exact hash at equal LT, and every prior resolved binding must stay resolved. An unresolved refresh retains the immutable publication. Positive evidence needs its concrete transactions; negative conclusions require current-boundary coverage. Current root pages merge only the completed owner check for that publication; cursor generations never change. Related generation IDs, timestamps and mutable refresh-pending diagnostics never change the exact-ledger-v21 economic fingerprint.

The priority scheduler reserves one foreground slot, uses independent per-account page allowances and retries after 2–60 seconds. A thirty-second sweep schedules recent or unresolved owner watches. Singleton prewarm does not consume watch capacity. INDEXER_LEDGER_WORKERS is 2–8 (default 3), worker-pool capacity is workers × 5 + 4 and the separate read pool has 10 connections; budget both pools across every worker process. Perps bounded-range read/admission work uses the read pool while collection and sweeps use workers, retaining the independent bounded-range schema and locks.

Cross-repository qualification relies on unchanged createReleaseLedgerPool(url,hash,options?), PostgresLedgerStore constructor/initialize/begin/append/project/complete/page surfaces, exact readiness success keys and build identity inputs, canonical schema and immutable cursor behavior. Use a fresh canonical database for this first-release schema; do not migrate, reset or weaken the native qualification contract. Qualification reads stored physical history independently from owner publication and orders logical times numerically.

Only gate packages start an isolated native PostgreSQL test server. Native sections use the sole INDEXER_TEST_DATABASE_URL and create their own random loopback schema. npm run test:ledger passes with only PATH and LANG; server-dependent sections stay optional. Package acceptance runs only owned scripts and a scoped typecheck. The phase does not read the npm registry or modify worktree node_modules. Dependency edits are manual and proved by an offline install/test in a separate scratch copy, with the documented fallback if the local cache cannot complete it.

Disk monitoring never deletes operational data. Unknown capacity is critical; low/critical capacity skips snapshot saves and critical health returns 503. Snapshots serialize through the asynchronous writer, use one owned temporary file per target and are awaited during shutdown. Logs and metric series are bounded and expose dropped counts. Runtime metrics include source/database/phase timing, scheduler depth, foreground age, pool wait, first-publication latency and database size; additive concurrent I/O totals need not equal wall-clock phases.

Publish this phase's web first, then switch the indexer within one release window. Keep the old indexer/database available for proxy rollback; the new web stays. No acceptance run or release announcement belongs between those two cutover steps.


Current Options/faucet evidence starts at the exact original owner TON wallet
transaction, never a target first-hop cursor. Verify full outgoing-to-incoming
message identity, current release pins and complete bounded product/token-wallet
histories. Retain original transaction and before/after account cells unchanged.
Current Options permits OVBY/OVFD funding, OSWW, FEXC/OFEX and slot0 CLMJ only;
CLMJ uses seriesId0 and null series/sourceWallet/notionalRaw/tokenId. Faucet FCLM
grant amount and allocated wire are facts of the original faucet boundary.
No event/receipt or current-balance comparison proves payout. These collectors
share the live gate and aggregate work/byte bounds, preserve explicit incomplete
coverage and never create a truncated-complete response. Exact manifest-pinned
library-reference executable code is valid; pruned/Merkle cells are not code
identity. Run current product parser/API/graph checks and original native capture
checks; synthetic source/head adapters never qualify a public deployment.

Options wallet-claim discovery reuses the exact saved Options operation request.
Only original causal vault commands and actual original source debits select
non-burn failures. Reconstruct complete current claim/failure roots, preserve
original recipient/WalletDetails, and return exact original transferTransaction.
Do not select unrelated history by query ID or count a current sparse witness as
payment. Faucet recovery reconstructs every holder receipt transition from full
original faucet history and binds release supplyBase; direct refusal targets its
same positive source transaction, while a lost bounce targets the later holder
transaction. Raw transaction cells alone do not authenticate proof-session chain
anchors. Run current release routes, native product/claim/recovery captures and
missing/wrong-history negatives after modifying these seams.
