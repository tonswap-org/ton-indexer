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
are not physical payout evidence. Current native capture and original-source
closure checks qualify only the implemented current decoders.

The portable current T3 hub/recovery cases retain their exact original 1.5
manifest and source/artifact closure. `currentT3Fixture` must authenticate both
original producer receipts and passing logs through `current-capture-build`.
Keep the original manifest authoritative; matching newer target hashes never
replace producer provenance. Historical TypeScript producer/compiler-binary
locks are not claimed. Synthetic sandbox anchors and injected account boundaries
remain outside public-consensus and continuous-history qualification.

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
below do not authorize old decoders for the fresh native release. Current product
bindings are qualified by their accepted original-source and native evidence.

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

Current two-pool Spot transport uses the exact saved SWP3→RCT3→SWP3 body and
resolved source-wallet first hop. Bind both installed pools, the manifest
SwapCoordinator, positive first/final minima, one deadline and owner destinations.
Return the original owner dispatch and full-message-linked A/T3/B transactions
under `tonswap-spot-route-evidence-v1`. Canonical identity-only getters permit
frozen or unused recipient wallets; missing actual delivery stays incomplete.
No event, coordinator dispatch or intermediate T3 refund proves final B credit.
Run the focused Spot parser/API and source-bound native route collector checks.

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

One monotonic network-authenticated head pins each current batch. Current block time must be within 30 seconds of local time, at most five seconds ahead, with a consistent peer clock; the one-second process-head reuse window cannot extend block freshness. Unpinned preflight batches recheck block age at completion. An already pinned concurrent batch retains its original boundary without lowering the process head. Failed batches cancel active siblings and stop queued reads. Accounts carry real shard-block anchors and chain creation times; server time never supplies a chain anchor. Completed getters and balances are not cached. Snapshot reuse must be explicit and retain its original asOfSeqno; time-dependent values cannot enable completed reuse. Cancellation and bounded deadlines apply to callers and underlying shared work. Typed REST failures use flat `{error,code}` with honest 400/404/415/429/500/503/504 statuses and no-store; retryable 429/503/504 responses include Retry-After. JSON-RPC uses the same source and authentic anchors. Enabled BOC submission is single-attempt and never retried or hedged.

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


Current public project tokens require the explicit JettonV21Minter/JettonV21Wallet
pair or the separate vendor stablecoin minter/wallet pair. Known manifest roots
retain their own paired code pins and precision. The TS master must match the V21
minter template. Authenticate original same-head master storage and exact current
getters, with explicit bounded on-chain decimals; no observed-code enrollment,
remote metadata or implicit precision. Retained old manifest bytes are evidence,
not an accepted current schema. Run current project-token and release checks.

Current Launchpad operation transport uses canonical factory-derived sale, LP and
vesting children, exact saved owner TON dispatch and reviewed assets. Every
physical leg still needs original linked account transactions. Sales discovery is
a bounded original factory page: complete means this page is gap-free, and null
nextCursor requires a verified zero predecessor. Pool operations use listed
release pools or exact current factory-derived public PoolId with approved token
families; current sparse T3 claims must link to the saved operation's causal
original debit. Native captures qualify these seams independently of the old
business decoders. Run current Launchpad/Pool request,
API and complete native capture checks before declaring them qualified.

Current Perps transport decodes only PxStorage and current RiskVault layouts,
with the exact installed peers, bucket1 controller/hook and market pool pins.
The original owner request fixes generation, deposit and collateral-wallet
authority. Shared sparse selection requires complete wallet history and links
the original first debit to the exact causal emitter; retries preserve recipient
and WalletDetails. Multi-wallet limits are aggregate, and any missing root or
limit stays explicitly incomplete. Recipient interval seeds preserve every
current-to-dispatch boundary while avoiding unrelated lifetime history.

Current Launchpad archived owed discovery is Sale-only. Authenticate canonical factory-derived child identity and paired slot token/wallet, then reconstruct complete original history. Owed live leaves use inline domain1, consumed leaves domain2, and pairs domain3; T3 receipt leaf encoding is incompatible. Bind JARC hints to every original archive count/root/total/frontier transition, and consume only successful exact CLMA with its original witness. Missing logs/history or overflow stays incomplete; no current-root/list approximation or invented payout. Run independent archive tree/API checks and native append/consume/append-after-consumption capture checks.

Generic owed recovery binds the manifest's Governance, MerkleClaim,
SwapCoordinator, PerpsEngine, RiskVault, OptionVault, FeeRouter,
BuybackExecutor, EmissionsSplitter, CoverVault and DLMM holder layouts to exact
native code/storage and same-head canonical token wallets. Unlisted pools require
the current pinned factory's canonical identity. The three `/v1/owed/` routes
share the existing 20-second evidence gate; keep 192 KiB requests, 8 MiB responses,
256 returned original transactions, 10,000 aggregate history rows, 64 new archive
boundaries and 32/32 wallet witnesses. Direct/archive books and sparse membership
never prove cash: require the original owner CLMJ/CLMA, its actual debit and
separately authenticated recipient credit, including zero-extra-debit retries.
Frozen provenance may require complete history without returning unrelated rows;
`completeAccounts` keeps its existing all-history response semantics. An active
current T3 source may contain original skipped-execution frozen intervals only
with unchanged full StateInit commitments and exact original thaw init. Require
its final original active account to equal the current anchor; missing or changed
history remains unavailable. Run `npm run test:current-owed`, the shared product
and archive-checkpoint checks, typecheck and the ordinary suite after changes.
The portable default/x6 corpus preserves original source closure and sandbox
journals; it does not qualify public consensus or deployed release admission.


Large Sale archive histories use request-driven durable verified boundary
checkpoints. Scope them by exact release, decoder version, canonical holder/slot
and code identity. Each slice fully verifies original transaction and account
commitments; each request follows its exact current anchor through predecessor
and before/after account hashes. Preserve the shared20-second limit and bounded
64-boundary/8-second slices. Return retryable503 until genesis and every current
root/count/total/frontier transition agree; never publish a partial tree or cache
a ready current answer. Immutable SQL checkpoints retain their original evidence
foreign key. No unowned background loops, reset or deletion of retained progress.
Run archive SQL restart/concurrency/cancellation/fork checks and retained native
append/consume/append-after-consumption with the unchanged shared deadline.

Current Perps business projection accepts only the PxStorage six-operation wire,
exact manifest engine/RiskVault/pool/T3 pins, original owner dispatch and
authenticated before/after cells. Independent integer arithmetic checks margin,
entry principal, 2N reserve, remaining entitlement, signed funding, fees and
unpaid loss; overlapping position facts never create spendable cash. Original
source debit and recipient credit separately prove T3 cash, including sparse
retry and whole owed recovery. Bounded range uses the same decoder; frozen
identities require complete original StateInit-linked history. Missing originals,
payout or coverage remain incomplete. Run `npm run test:ledger:perps` for
`ledger-current-perps-test.ts`, `current-perps-economics-test.ts`,
`ledger-current-perps-range-test.ts` and the retained generic range/retry/recovery
tests. The fresh source-locked native producer passed 18 tests with 66 default/x6
captures; the portable originals and receipt remain unchanged. Sandbox heads do
not qualify public deployment. The accepted current business-decoder gates
authorize only their exact original-evidence rules. The earlier
Perps ABI positive tests remain historical evidence, outside the ordinary gate.


Current Launchpad business projection binds the original owner command to exact
factory-derived Sale, LP and Vesting children and independent historical account
boundaries. Empty-forward supply discovery authenticates the canonical child;
current discovery hints never replace original financial evidence. Missing child
originals preserve an unresolved current intent with unknown identity fields.
Project token master boundaries participate in coverage, so incomplete master
history cannot confirm settlement. Failed-sale claims use the original paid
amount and separately proved T3 cash to classify refunds. Holder and archived
owed recovery require their exact original command, witness and physical payout;
archive accounting does not fabricate complete ordinary ledger history.

Run `npm run test:ledger:launchpad` for the current native business, discovery,
holder, recovery and archive suites. The portable v2 corpus retains 44 unchanged
native capture files, all 180 source files and the passing producer receipt.
All eight worlds qualify the actual discovery graph from exact same-head current
account envelopes and canonical getters, including explicit original cold-wallet
states. Sandbox heads do not qualify a public deployment; canonical storage,
current live identities and native admission remain separate gates.


Fresh market observations use `dlmm-market-ledger-v2` and the current Pool/T3/X
bindings derived from the release manifest. Each token keeps its own reviewed
master/wallet family. The current service dispatches only the current graph and
projector and refuses historical v1 publications. The store requires an explicit schema at construction and rejects mismatched
publication, head and page metadata before invoking a decoder. Archived evidence
tests explicitly select v1; no current request falls back to that decoder.

A v2 observation independently verifies original owner dispatch, physical input
and recipient credit, exact pool reserve/fee changes and historical token
precision. `settlementMode: physical-credit` makes `finalizedUtime` the actual
recipient credit time; it does not invent a retired acknowledgement/finalizer.
Missing original cash or precision remains incomplete. Publication and page reads
reverify original economics and exact dependency coverage. Immutable generation,
scoped cursor, compare-and-publish and transactional rollback rules remain intact.
Run `src/scripts/ledger-current-dlmm-market-test.ts` and
`src/scripts/current-market-store-test.ts` for native economics and embedded
PostgreSQL persistence; synthetic archive/head adapters are not public consensus
qualification. Run the full current suite and separately require native release
qualification before public activation.

Current runtime excludes the retired Cover, volatility-index and old farm tuple
snapshot endpoints and decoders. These routes return 404. Current pool farming
uses `get_farm`, `get_farm_pending` and `get_next_farm_id` through the maintained
exact-head getter transport, with separate original evidence for physical cash.
Do not restore obsolete positive fixtures as current API coverage; retain their
raw historical evidence and test retired routes for refusal.


Current DLMM business qualification uses exact current Pool/SpotOrderFactory/SpotOrder
storage and per-token T3, V21 or vendor-stablecoin families. Original owner
dispatches, factory/child initialization, pool state changes and separate wallet
debit/credit boundaries authorize economics. Pool LP shares and fee allocations
are accounting components, never additional cash; ordinary projections check
all token movements for duplication. Order funding, consumed input, physical
outputs and returned custody remain separate. Discovery retains the full owner
chain while selecting only exact OCRT dispatches as child-creation authority.

Run `npm run test:ledger:market`, `npm run test:ledger:liquidity` and
`npm run test:ledger:orders`. Current native positives replace old DLMM ABI
positives in these ordinary aliases. The portable originals and limitations are
documented in `src/scripts/fixtures/current-dlmm-native/README.md` and
`src/scripts/fixtures/current-order-recovery-native/README.md`. Never-funded
cancel/expiry requires original close/withdrawal/bounce evidence and authenticated
same-head absence or an exact empty account envelope retaining its actual cursor.
Protected Order-input recovery requires original debit, failed recipient/rich
bounce, exact MARK witnesses, closed-order owner dispatch, zero-delta RETRY and
actual later owner credit. The original debit is never counted twice.
Certificate-only or missing-original recovery remains unresolved; a certificate
or SENT status is not cash. The source-locked production-Hub corpus tests both
fee profiles and ordinary projection/discovery without claiming public consensus.

Market precision retains the configured source's original `sourceMasterchain`
context and the exact execution account envelope plus independent shard anchor.
The persisted after-root context must equal the execution masterchain identity;
the before-root context must be the explicitly requested preceding masterchain
sequence. Use canonical signed-decimal shard IDs and verify tagged-shard account
membership; shard and masterchain sequence numbers are independent. Original
root LT/hash must remain unchanged across the bracket. Old cached states lacking
source context are refreshed from the configured source, never repaired locally.
Missing context stays unresolved. This retained source binding is not a standalone
consensus proof. Current native test brackets remain explicitly synthetic.

Bound identity reads before RPC, original graphs to 10,000 transactions/64 MiB,
and each execution proof including its account envelope to 256 transactions/8 MiB.
Each token's retained precision archive has a separate 8 MiB pre-parse budget.
Limits and missing boundaries yield explicit incomplete coverage.

Current runtime qualification is exercised by `src/scripts/current-ledger-bootstrap-test.ts`
through the actual derived binding, canonical SQL/catalog, separate worker/read
pools, current v2 market construction and drained shutdown. Its explicit false
binding allocates no pool. PGlite and synthetic fixture transport do not establish
public consensus, PostgreSQL restart isolation or deployed native admission. Run
`npm test` after changing these boundaries; final ledger qualification and web
activation remain separate release receipts.

The process head accepts valid network-bound monotonic blocks regardless of wall
clock age. Only unpinned current read batches require a block at most 30 seconds
old and at most five seconds ahead with a consistent peer clock, checked both
before dispatch and at completion. A valid stale answer may try another peer
within the existing bounds but never opens that peer's circuit. Explicit-block
reads retain their original boundary during a chain stall or host clock skew.

Current Perps generic warning removal recognizes only its current PX/oracle/risk
and T3 custody vocabulary within a decoded operation. It never replaces original
transaction, historical state or cash verification; unknown grouped messages
retain their warnings. Run the current Perps suite and full ledger suite after
changing this rule. The bounded-range retry test must explicitly complete and
release held collectors before pool shutdown; early event-loop drain is failure.

Current Governance snapshots admit only the manifest Governance singleton and exact code hash. Authenticate complete original active ShardAccount storage and current class parameters in one pinned-head batch; locks and proposals use the current Governance dictionaries, never retired Voting tuples. Keep uint32 allocation bounds and at most 64 IDs per page, with no completed-response cache for time-derived status. Absent allocated IDs are pruned with unknown terminal outcome; queueing/dispatch never proves target execution. Retain original default/x6 capture producer/source/artifact closure and native timing comparisons. Run `npm run test:governance`, API/OpenAPI/deadline tests and typecheck after changes.

Current lifecycle observations are additive non-cash facts. Select owner-connected
candidates before original archive reads; never expand all shared-contract history
into an owner's dependency graph. Authenticate exact current role/code pins,
original before/after account cells and unique full committed-message ancestry.
Keep limits of 64 original boundaries, 16 ancestor hops and 256 observations. Events and
successful calls never confirm physical delivery, target execution or supply totals.
Run `test:ledger:protocol` after this boundary changes; retained filtered native
rows qualify event decoding, not public consensus or complete route settlement.

Current T3 basket transport adds paired mint and reserve swap only. Paired requests retain both exact deposits, opposite core reserve slots, matching owner/minimum intents and separately resolved source-wallet first hops. Bind each non-null hop to its original owner message. Null dispatch is no evidence of non-delivery; browser wallet closure and physical refunds remain separate. Preserve aggregate bounds and full hub receipt reconstruction at one head. Native source-bound default/x6 cases qualify only exact current originals; current claims never establish cash. Run the basket collector/API/parser and browser physical-proof/journal gates.

A manifest-bound optional slot2 canonical wallet may be proved undeployed only
when the hub has zero backing, zero pending credits and zero total/direct/archive
owed liabilities for that slot, with admission/frozen bits clear. This is current
cold-wallet identity, not an unknown-state fallback. Require exactly three slots,
the slot2 optional flag and master-selected address; unknown, frozen, noncanonical
or indebted wallets remain unavailable. Run the source-bound basket collector's
positive/negative binding cases and `runtime-t3-binding-test.ts` after changes.

Current whole-order settlement and Order-wallet claim requests must retain every
resolved factory creation attempt in `creations` (exact OCRT body/value/LT/hash,
1–256 unique cursors). A successful later initialization does not erase an
earlier rejected creation or a duplicate first hop. Collect original factory
history through the winner and every selected cursor, plus full pre-init child
history; keep missing evidence incomplete under the existing aggregate bounds.
Run the native expired-order collector, strict request/API and OpenAPI gates.
