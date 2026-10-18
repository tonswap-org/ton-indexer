# ton-indexer
Indexer for faster/more reliable data from TON.

This TypeScript service provides pinned TON chain reads, current balances, bounded activity history and durable product settlement evidence. The runtime requires one reviewed release manifest and a locally configured liteserver pool.

The fresh native manifest uses `T3Hub`, per-token master and wallet code pins,
current spot wallet profiles, a mandatory unique `orderKeeper: { address }`,
and the stable `services.indexer` mount
`https://test.tonswap.org/api/indexer` for public testnet. The localnet fixture is
sandbox evidence and never a public deployment identity. Every API response,
including errors and readiness, carries `x-tonswap-release` when the manifest is
valid. Clients may send that header to reject a stale release with HTTP 409 before
route work. CORS permits and exposes it.

`GET /api/indexer/v1/orders/open` returns a release-bound immutable snapshot of
current `ACTIVE` and `EXECUTING` orders. Omit the first cursor; `limit` is 1–100
(default 50) and must remain unchanged across pages. A cursor retains its original
head and rows, expires when that chain boundary becomes older than 30 seconds,
and returns HTTP 409 if it is stale or mismatched. Missing fresh evidence returns
503. `coverage.complete` requires genesis-linked factory history, authenticated
current account boundaries and no discovery gaps; an incomplete page remains
explicitly incomplete. An order state is neither a cash settlement nor keeper
admission proof. Current capture coverage lacks factory genesis and live
masterchain boundaries, and still needs INPUT_OWED/JCLR, expiry and cancellation
during execution qualification.

The orders collector starts after the HTTP listener, reads through the configured
liteserver source, and retains original verified transaction boundaries in the
release-scoped PostgreSQL schema. Its separate pool has three connections and a
five-second statement timeout. Collection is bounded to 64 new transaction
boundaries, 10,000 history rows and 256 child accounts per cycle; unmet bounds
produce coverage gaps. Immutable snapshots survive restarts, and late workers
cannot replace a newer publication. No current account or getter result is cached.
Use `INDEXER_DATABASE_URL` and the ordinary `npm run build`; the canonical database
catalog includes the orders tables. This adds no readiness success keys and does
not bypass native admission or canonical storage and live-identity checks.

`GET /api/indexer/v1/config-prices?masterchainSeqno=N&blockRootHash=HEX` authenticates
config parameters 18, 21 and 25 at the same current masterchain boundary used by
the account read. The response includes release identity, `asOf`, and exact
`basechain.gas`, `basechain.forward` and `basechain.storage` prices as unsigned
decimal strings. Storage prices use the schedule active at chain time. A changed
head returns HTTP 409 `head_mismatch`; the client must refresh its current read.
These GET endpoints use `Cache-Control: no-store`.

`GET /api/indexer/v1/account-storage?address=RAW&masterchainSeqno=N&blockRootHash=HEX`
returns the original active `ShardAccount` and complete authenticated configuration
dictionary BOCs at the exact requested head. The browser independently decodes
`StorageInfo`, balance and the whole configuration-18 storage price schedule,
then compares code/data to its same-head contract snapshot before funding a
recovery. No rounded storage summaries, defaults or current-price-only history
are substituted. Missing, uninitialized or pruned data is unavailable; changed
heads return `409 head_mismatch`. Responses are release-bound, uncached and
limited to 8 MiB. Run `tsx src/scripts/current-account-storage-test.ts` after changes.

`POST /api/indexer/v1/t3/wallet-claim-evidence` accepts only the exact saved
redemption variant of the T3 request. It reconstructs the current wallet claim
and failure trees from complete linked original wallet history, then returns at
most 32 matching burn claims and 32 failures for their current attempt hashes.
The original owner-to-wallet body and origin LT, exact custom intent, owner and
amount bind each result. Burn `WalletTerms.recipient` is the wallet owner; the
payout beneficiary is inside the custom intent. Roots/counts describe the whole
tree even though records select one operation. Missing history and overflow
produce explicit incomplete coverage. The endpoint shares the live evidence gate,
10,000-history/64-new-boundary work limits, and 8 MiB response bound. A membership
witness never proves cash delivery; clients revalidate current wallet identity and
roots before submitting mark, retry or cancellation.

`POST /api/indexer/v1/t3/operation-evidence` is read-only and accepts the exact
current mint, paired mint, reserve swap or redemption request, including the original `bodyBoc` and
`bodyHash`. It returns the requested release and body identity, one authenticated
`asOf` head, current pinned hub code/data, owner/request receipt witnesses and
original transaction plus before/after ShardAccount BOCs. Receipt candidates
establish membership only; the browser independently checks physical delivery.
The service reconstructs complete hub receipt history at each current boundary
using retained original transaction facts, never cached current roots. Missing
history produces explicit `coverage.gaps` and `complete: false`.

T3 and Spot evidence share a maximum of two concurrent requests and a 20-second
collection deadline. T3 permits
64 new historical boundaries per request, 10,000 internal hub-history rows,
256 scanned related transactions, 16 related accounts, 32 selected receipt
candidates, 256 returned physical boundaries and an 8 MiB response limit. Hitting
a limit never produces a truncated complete response. Requests exceeding 192 KiB
are rejected. Original immutable boundaries and their authenticated containing
sequence numbers share the release-scoped physical store with order discovery;
current hub, wallet and configuration reads remain fresh. These runtime limits
do not certify native captures or public deployment readiness.

`POST /api/indexer/v1/spot/order-wallet-claim-evidence` accepts the exact
`order-settlement` request for an order whose input is T3. It authenticates the
closed deterministic order, original initialization and immutable terms, resolved
funding and actual input credit, plus complete original order and input-wallet
histories. Each returned non-burn record includes `transferTransaction`, the
original wallet transaction and before/after account cells at its first
`originLt`, linked to the pinned order's exact outgoing message. Later retries
retain that origin while incrementing the attempt. Current failure membership may
precede marking; the browser must resolve its mark action and refresh before
submitting `OWDR`. This endpoint has one 10,000-row aggregate history budget,
64 newly replayed boundaries, 32 claim/32 failure witness limits and an 8 MiB
response limit, using the shared evidence gate. Incomplete original evidence or
limit overflow never returns a complete partial witness set. Other token wallet
protocols are not interpreted as T3 sparse trees.

`POST /api/indexer/v1/spot/operation-evidence` accepts the exact current
`direct` transfer body, `order-create` reviewed terms, or `order-settlement`
terms with an optional resolved funding dispatch. Direct requests qualify
both token masters, four canonical wallets and the current pool at one head;
responses include those wallet addresses, current original account envelopes,
and original linked transaction boundaries. Full message comparison preserves
all headers, amounts, StateInit and body while normalizing legal TL-B
inline/reference placement. The client must bind its retained wallet dispatch to
the source-wallet LT/hash before interpreting those facts as its own outcome.
The endpoint never treats a pool event or closed order as delivered tokens.

Order creation retains the original owner-to-factory request and actual factory
execution, exact child StateInit and first initialization. The only allowed
change to reviewed terms is the native `startAt = max(startAt, factory.tx.now)`
clamp. The current child terms must still match that actual initialization.
Creation responses contain only the pinned factory/order/pool, their current
account envelopes and original factory/child transactions.

Whole-order evidence binds a supplied funding dispatch to its exact source-wallet
LT, transaction hash, value and body. It retains the complete original order and
input-wallet histories, five canonical wallet identities and their related
physical message graph. Historical permissionless keepers enter that bounded
graph only through successful pinned order transitions. `absentAccounts` derives
only from authenticated dictionary absence, never missing or uninitialized state.
A never-funded closed order with zero executed slices may account for its failed
withdrawal through that proven wallet absence and the original order bounce; no
wallet transaction or token credit is fabricated. Clients independently verify
input conservation and every output/refund, and resolve every saved wallet action
before treating an order as terminal. A null funding request does not clear an
unresolved local wallet action.

Two-pool requests use `kind: route` with the exact saved A→T3→B body, distinct
installed pools, the manifest coordinator and the resolved pay-wallet first-hop
LT/hash. The parser binds both positive minima, one deadline and the owner refund
and final-output destinations. `tonswap-spot-route-evidence-v1` returns both
current pools, the coordinator, canonical A/T3/B wallet identities and original
linked transactions, including the original owner dispatch. Missing originals
remain incomplete. Consumers independently verify both reserve transitions and
actual final B credit; a coordinator continuation or intermediate T3 refund is
never final-output delivery. This endpoint does not sign or retry a route.

Spot evidence shares the release pool, immutable physical store and live request
limit with T3. Per request it bounds current accounts to 16, scanned and returned
transactions to 256, new archive boundaries to 64, message edges to 1,024 and the
response to 8 MiB. Missing history, unmatched delivery or any exhausted limit
remains explicit incomplete coverage. Current observations are never cached.
Requests exceeding 192 KiB are rejected; responses use `Cache-Control: no-store`
and the manifest-bound release header. Run `npm run test:current-spot-evidence`
for strict request/route cases and `npm run test:current-spot-evidence:capture --
/absolute/direct-capture.json /absolute/retained/orders` for the original captured
boundary adapter. Sandbox consensus labels and test issuing authority never
qualify a live release. Run `npm run test:current-order-settlement:capture --
/absolute/native-order-capture.json` for whole-order evidence. The retained native
matrix covers both directions, three-slice completion, cancellation, partial
execution, refusal/refund, unfunded cancellation, expiry and ten-slice completion.
The ten-slice graphs fit the bounds; longer histories or repeated failures may
remain explicitly incomplete. This does not qualify unbounded recovery or
public deployment readiness.

Run `npm run test:current-release` for manifest, wallet, header and API checks and
`npm run test:current-orders` for durable publication and endpoint checks. Run
`npx tsx src/scripts/current-order-chain-test.ts /absolute/path/to/retained/orders`
and `npx tsx src/scripts/current-order-discovery-test.ts /absolute/path/to/retained/orders`
against the retained producer evidence; their synthetic masterchain labels do not
qualify a live chain. Transport proof tests separately verify exact authenticated
config and account bindings. Run `npm run test:current-t3-evidence` for strict
request and API cases, and `npm run test:current-t3-evidence:capture --
/absolute/path/to/retained/t3Recovery` for original native mint/redemption
collection under an explicitly synthetic chain/getter adapter. This bounded
operation graph test does not qualify a live release or full account histories.

The first-release chain schema requires TVM12 or newer. Raw internal messages expose
`extraFlagsRaw`; the upstream SDK/toncenter compatibility wire key `ihrFee`/`ihr_fee`
contains those flags and is never added to native fees. Fee evidence consists of
actual transaction fees plus outgoing forwarding fees from original BOCs. Original
historical fixture capture files retain their recorded provider field names;
production evidence re-decodes their BOCs using the current raw schema.

The diagnostic pool count includes configured pools and pools whose current
typed deployment acknowledgement succeeded at the registered DLMM Factory.
It verifies the original Factory transaction, including its receiver, execution
status and complete DPDA or launch callback body. Create requests, outgoing
deployment attempts, bounces and summary-only observations do not increase the
count. The count does not certify Registry activation, market admission or
settlement. Run `npx tsx src/scripts/history-integrity-test.ts` after changing
this boundary; `npm test` includes that check.

The retained Factory fixture authenticates nine compiler BOCs against the reviewed
pure build manifest and their individual current Tolk import closures. Its capture
binding separately records the three targets actually observed in the producer.
Original transaction/account boundaries and callback messages remain mandatory.
Verification reads retained target declarations as data, independently renders
virtual opcode inputs, and never imports native build or release helpers. The
history test rejects missing or changed sources, omitted compiler roles, altered
code, traversal and symlinks; unrelated native modules cannot supply authority.

System-health snapshots decode the current 21-field RiskController getter with
separate atomic `configuredGrossBudget` and `committedGrossBudget` values, and
the complete 37-field ControlMesh getter for four Perps markets. Retired or
malformed tuples remain unavailable. Run `npm test` to check these API decoders;
the retained native account fixtures are ABI regressions, not release qualification.

## Requirements
- Node.js 22

## Setup
```bash
npm ci
```

## Run (dev)
Dev runs on testnet with the lite client enabled. Every startup requires the native deployer's reviewed release manifest through `INDEXER_RELEASE_MANIFEST`.
```bash
LITESERVER_POOL_TESTNET=/absolute/path/to/reviewed-global.config.json \
INDEXER_RELEASE_MANIFEST=/absolute/path/to/testnet.manifest.json npm run dev
```

Run dev on mainnet (lite client):
```bash
LITESERVER_POOL_MAINNET=/absolute/path/to/reviewed-mainnet.config.json \
INDEXER_RELEASE_MANIFEST=/absolute/path/to/mainnet.manifest.json npm run dev:mainnet
```

Run against a local TON network:
```bash
LITESERVER_POOL_LOCALNET=/absolute/path/to/reviewed-localnet.config.json \
INDEXER_RELEASE_MANIFEST=/absolute/path/to/localnet.manifest.json \
npm run dev:localnet
```
Each network requires its own reviewed local pool. The service does not fetch pool configuration, discover peers or use an HTTP chain provider.

## Build + Run
```bash
npm run build
npm run test:historical-replay
LITESERVER_POOL_TESTNET=/absolute/path/to/reviewed-global.config.json \
INDEXER_RELEASE_MANIFEST=/absolute/path/to/release-manifest.json npm run start
```

The ordinary build also executes `sql/ledger.sql` and the release-identity DDL in
a fresh in-memory PostgreSQL fixture, writing the canonical catalog to
`dist/ledger/canonicalSchema.generated.js` and the compiled identity to
`dist/build-id.json`. The build SHA-256 covers the JSON object of sorted
root-relative paths to raw-file SHA-256 hashes for every regular `dist/**/*.js`
and `sql/ledger.sql`; the generated ID excludes itself. The compiled worker pins
this identity when it imports the readiness module and rechecks the files on
every readiness request. Replacing an ID cannot change that running pin.

`GET /api/indexer/v1/ledger/readiness` returns the
`tonswap-native-ledger-readiness-v1` document only for the exact native testnet
manifest, authenticated compiled build and configured durable ledger. Its
`release`, `build: { sha256, sqlSha256 }`, `database: { schema, manifestHash }`,
manifest-derived service identity and canonical ISO `checkedAt` support the
native deployment guard. A repeatable-read, read-only transaction checks the
exact search path, full singleton release hash, canonical relations, columns,
constraints, indexes, sequence configuration, row-security policies, triggers
and table access. It never initializes a namespace, enrolls
an account or collects history. Missing storage, source-only workers, altered
compiled files or schema drift return HTTP 503; all responses use `no-store`.
NOT NULL is authenticated through each exact column's `attnotnull` flag. The
build fixture's PostgreSQL 18 named NOT NULL records are validated against their
single mandatory column and projected away because the sole native PostgreSQL
16 target represents this same SQL enforcement through the column flag. Primary,
unique, check and foreign-key constraints retain their exact definitions and
enforcement; unknown constraint kinds are rejected. This does not admit a
different SQL schema or provide a storage fallback.
Run `npm run test:ledger:readiness` for the compiled-file, route and actual catalog
regressions. Production qualification still runs the installed compiled store
against its separately owned native PostgreSQL runtime.

## Test
```bash
npm test
npm run build
```

The regression suite covers transaction-chain continuity, reorg replacement,
snapshot integrity, bounded liteserver retries, classifier decoding, and public API
validation/streaming behavior.

The source uses one monotonic, network-authenticated process head with a one-second reuse window. Account and getter reads pin that head, share only identical in-flight work and propagate cancellation. Peers retain health, failure and circuit state; bounded retries and delayed hedges never extend the caller deadline. Only one delayed hedge may belong to a read, with at most eight globally. Message submission is a single attempt and is never hedged or replayed after a disconnect. Run `npx tsx src/scripts/chain-source-test.ts` and `npx tsx src/scripts/lite-engine-test.ts` for source lifecycle checks.

Ledger wire checks retain only immutable body hash/opcode facts keyed by exact
original bytes, bounded to 1,024 entries and 4 MiB of key storage. Full code/data
BOC validation retains only immutable structural certificates, bounded to 64
entries and 4 MiB of keys. Neither cache retains Cell graphs, account observations,
getter results, settlement qualification or financial state. Run
`npm run test:ledger:wire` and `npm run test:fresh-read` for their content, mutation
isolation and eviction regressions.

## Current chain reads

`POST /api/indexer/v1/readFresh` accepts 1–32 account/getter calls and executes them at one exact masterchain boundary. Its `readContext` contains `source: "lite"`, the complete head including `utime`, and the server query-start timestamp `queriedAt`. Account results contain the authenticated shard block and its creation time in `anchor`. The response also carries the current native release ID and manifest hash. No persisted account projection supplies a current chain read. Partial, wrong-network and wrong-block batches fail; actual getter VM exits remain outcomes. Perps admission stays on its separately authenticated native executor.

Current metadata must have a canonical block time within 30 seconds of local
time, at most five seconds ahead, and a consistent peer clock. Stale or lagging
heads consume the same bounded peer budget; dependent head queries carry the
last authenticated sequence floor. An already pinned concurrent batch keeps its
original boundary and cannot lower the process head. Unpinned preflight batches
must still be fresh when they finish. The one-second head reuse window remains.
Failed or cancelled batches abort active siblings and stop queued dispatch;
transport cancellation removes their owned pending queries. No HTTP fallback is
present. A failed `readFresh` logs one warning whose diagnostic keeps bounded
source causes and attempts without request bodies or stacks; the response
keeps the fixed public message. The SDK account-loader safeguard caps retention at 64 block keys,
8 MiB of raw buffers and 65,536 cells; current account reads bypass that loader.
Other SDK block/header/shard caches are bounded to 256 entries. Run
`npm run test:fresh-read`, `npx tsx src/scripts/lite-account-cache-test.ts` and
`npx tsx src/scripts/chain-source-test.ts` for these boundaries.

The source does not retain completed getters. `SnapshotReader` shares active loads and permits completed reuse only when a caller explicitly supplies an age limit, optionally also requiring an unchanged exact account transaction pointer read at the current head. A reused value retains its original `asOfSeqno`. Time-dependent values must not enable completed reuse. Timed-out or abandoned work cannot publish into a later request, and there is no stale-success response mode.

REST request errors use the flat body: `{ "error": "safe explanation", "code": "machine_code" }`. Validation uses 400, unknown or removed paths use 404, unsupported content types use 415, limiting uses 429, unavailable reads use 503/`upstream_unavailable`, timed-out reads use 504/`upstream_timeout`, and unknown internal errors use 500. Native admission keeps its separate typed errors. All errors are `no-store`; 429, 503 and 504 include `Retry-After`, exposed through CORS. Operational `/health` retains its component-status document even when its HTTP status is 503. Request disconnects cancel remaining work. Route budgets are five seconds for getters, balances and JSON-RPC, eighteen seconds for `readFresh`, and ten seconds for product snapshots.

`/jsonRPC` and `/api/v2/jsonRPC` use the same configured chain source. Masterchain responses use real head hashes; account responses use the actual shard anchor and chain creation time. Missing anchors never become wall-clock timestamps or fabricated blocks. Only explicit unused accounts receive a zero transaction cursor. `sendBoc` and `sendBocReturnHash` send one validated BOC through that source when `INDEXER_ENABLE_WRITE_RPC=true`; other writes and external JSON-RPC forwarding are unavailable.

Run `npm run test:fresh-read`, `npx tsx src/scripts/service-deadline-test.ts`, `npx tsx src/scripts/error-contract-test.ts` and `npx tsx src/scripts/jsonrpc-anchor-test.ts` for these boundaries.

## Durable account ledger

Each raw-history append must match its generation's network and physical account.
Every normalized event must also match the paired original transaction's logical
time, hash, timestamp and terminal outcome. A mismatched batch is rejected in full;
grouping related accounts belongs to the separate owner projection. The native
PostgreSQL qualification in `../tonswap_web/tests/nativeLedgerQualification.test.ts`
checks exact large amounts, retrieval beyond a 500-event page, reconnects, immutable
cursors, discovery deduplication and rejection of mixed-account or altered-source
batches. Run it from `tonswap_web` with `TONSWAP_TEST_NATIVE_LEDGER=1 npx vitest
--configLoader runner run tests/nativeLedgerQualification.test.ts`; it owns and
removes an isolated local PostgreSQL 16.15 instance.

Set `INDEXER_DATABASE_URL` to a PostgreSQL connection URL in the service secret
configuration, or set `INDEXER_DATABASE_URL_FILE` to an absolute runtime path
containing that URL. Configure exactly one source. Unreadable, empty, or invalid
secret files fail startup without logging the secret. The indexer uses a separate durable ledger; the existing memory
cache and JSON snapshots are never used to certify exports. Bootstrap the schema
with `npm run bootstrap:ledger` (SQL: `sql/ledger.sql`). Startup also runs this
idempotent bootstrap under a PostgreSQL advisory lock. First-release deployments
require a fresh database initialized from this canonical schema. Bootstrap rejects
an existing ledger schema without `ledger_projection_coverage.projection_scope`;
it does not infer scope, migrate old formats, or reset an existing database. The database role needs
schema/table creation rights for bootstrap and normal DML rights at runtime.
Do not publish the connection URL in the frontend bundle. The compiled deployment must retain
the SQL schema. PostgreSQL persistence, backups, and TLS are deployment concerns;
a filesystem snapshot is not a substitute for this database.

`GET /api/indexer/v1/accounts/{addr}/ledger` accepts `from_utime` (inclusive UTC
seconds), `to_utime` (exclusive), `limit` (1–500), and `cursor`. Root reads admit an
owner watch and schedule an independent backfill. Each account chain links its
observed head to genesis through exact predecessor hashes. Raw account history
and owner projections use PostgreSQL, independently of the 1,500-row memory cap.
Cursors pin immutable published generations with unchanged account/network/date
bounds. Unpublished backfills return no event pages and explicit incomplete
coverage. The API never publishes a partially changing cursor snapshot.

Every page has `coverage.projectionScope`: a published owner projection contains
`{ kind: "owner", owner, physicalAccounts }`, with canonical raw TON addresses and
a sorted, unique list of the physical accounts represented by that projection,
including the owner. The scope is persisted with the generation, included in its
decoder `exact-ledger-v21` fingerprint, and preserved by older cursors. A scope
change creates a new generation even when both generations have no events.
This describes represented accounts; it does not certify discovery of every
owned asset or complete history. Published projections with explicit history or
decoding gaps retain their actual scope and available events. Unpublished runs
return a null scope and no events. Missing or invalid published scope metadata
also suppresses events and cursors, sets completeness flags false, and reports
`owner_projection_metadata_invalid`; consumers must not substitute the owner as
an inferred scope.

`INDEXER_LEDGER_WORKERS` defaults to three and accepts 2–8. Foreground ledger requests precede background work, which may occupy at most workers−1 slots. Running requests coalesce into one follow-up; failures retry after 2, 4, 8, 16, 32 and then 60 seconds. A thirty-second sweep revisits watches requested within fifteen minutes or marked unresolved. Startup prewarms physical history for the manifest T3 hub/root, Perps engine, Options factory/vault, router and spot pools without consuming wallet-watch capacity.

`INDEXER_MAX_WATCHED_ACCOUNTS` defaults to 1,000 (maximum 100,000); overflow reports `watch_capacity_reached` and creates no watch/account row. `INDEXER_MAX_PAGES_PER_SYNC` defaults to 20 (maximum 100) **per physical account** per cycle, each page at most 100 transactions. Resumable backfills retain their exact cursor, and an old completed head never certifies a newer boundary. `INDEXER_MAX_RELATED_ACCOUNTS` defaults to 256 (maximum 1,024). Related refresh uses four concurrent account operations and one account-scoped lock shared across processes.

The worker PostgreSQL pool has workers×5+4 connections (19 by default); API pages, admission and readiness have a separate ten-connection read pool. Use a dedicated database role for each release or project and budget both pools for that role. The host connection budget must also cover any side-by-side release workers with their separate roles. Keep these capacities distinct from the bounded perps-range collectors.

Configured jetton roots and observed transfers/notifications identify controlled
wallets. Root/wallet getters, owner identity, and active wallet code are verified.
A never-deployed wallet is empty only when the root getter and an explicit
uninitialized, history-free account state agree. Observed counterpart wallets and
registered DLMM pools are crawled too. `coverage.relatedAccounts` records each
account, physical generation, role and chain coverage. This discovery scope does
not enumerate arbitrary unconfigured tokens that never notify the owner.

Every owner cycle captures one head and qualifies all current dependencies at that boundary. An eligible quiet check reads the stored head vector once and advances only the mutable owner check when every pointer is unchanged. Stored `historyComplete` means that physical history is linked to genesis; it does not mean the account was refreshed at the latest boundary. `coverage.boundary` identifies the masterchain observation, and `refreshPending` lists canonical accounts needing refresh. Positive settlement evidence needs coverage through its exact transactions; a conclusion relying on absence needs coverage at the current boundary.

Publication requires every prior physical graph account at an equal-or-later head (equal LT also requires equal hash) and every previously resolved binding still resolved. Failure preserves the old immutable publication. Changes in related generation IDs or observation timestamps alone do not change the economic fingerprint; exact evidence, scope, address/role/history completeness and stable issues do. `exact-ledger-v21` excludes mutable refresh-pending diagnostics. Confirmed regression counts are diagnostics, never a replacement publication rule.

`generation`, `publishedAt` and `headObservedAt` identify an immutable snapshot. `checkedAt` is the server time of the completed owner check; `boundary.utime` is chain time. Current root pages and first discovery pages merge the latest completed check only when its publication generation matches. Cursor pages preserve their original generation, observations and boundary. Neither publication timestamps nor server check timestamps are chain watermarks. Raw evidence, old generations and incomplete resumable work are retained.

All amounts are unsigned atomic decimal **strings** with an explicit `in`, `out`
or `fee` direction. Native assets use `<network>:native`, the `GRAM` ticker, and nine decimals;
jettons use network plus canonical master address. Metadata is a current chain
observation, not a historical price. Exact message identity includes canonical
endpoints, `created_lt`, and body hash. Verified transfers require successful
source/debit and recipient transactions, canonical wallet identities, an exact
owner transfer request, and complete related histories. Owner notifications and
custody credits are deduplicated. Typed settlement replay never credits principal
twice; its actual processing fees remain. Unknown receipt amounts are retained
with unresolved identity, not dropped or converted to zero.

Native transfers between the owner's controlled accounts cancel within the owner
projection. Each physical owned-account transaction fee remains, together with
outgoing forwarding fees. `totalFeesRaw` aggregates transaction fees already
represented by `transaction_fee` movements; **never add it again**. Forwarding
fees are separate `message_forward_fee` movements. Each movement retains its
physical account, LT, hash, timestamp and, where applicable, message/body evidence.

`event.settlement` is the product proof boundary; `actions` remain classifier
hints. DLMM swaps require both canonical token legs and exact settlement-tuple
evidence: the current authenticated JSUC transaction must emit its sole matching
JSFN directly. A successful zero-output JSUC followed by a later DSRY finalizer
is not accepted. Current DSRY recovery remains unqualified until its distinct
physical proof is supported; retries cannot supply a candle output either.
`minOut` is never execution output. Run `npx tsx src/scripts/ledger-settlement-test.ts`
and `npx tsx src/scripts/market-candles-test.ts` for these boundaries; `npm test`
includes both suites. This does not make candles exact historical tax valuations.
The `exact-ledger-v21` projection fingerprint forces fresh decoder generations
on recheck, while preserving previous cursor snapshots.
Run `npx tsx src/scripts/ledger-test.ts` for persisted decoder invalidation.

### Exact 24-hour pool history dependency

`src/ledger/activePoolCutoffHistory.ts` selects the inclusive state transaction at
an exact chain observation minus 24 hours. It re-decodes original transaction
BOCs, binds the supplied current account pointer and retains every intervening
pool transaction, including failed transactions. A transaction on the cutoff
second is included at the highest applicable account logical time; an unchanged
current pointer establishes an idle interval. Missing original cells, broken
links, future or nonmonotonic times remain explicit unavailable results. Returned
evidence owns frozen copies and a deterministic content identity.

This is a history dependency, not an authenticated block archive or a price
quote. The price producer must independently authenticate the current observation
at its exact masterchain head and the selected historical account boundary,
retain masterchain/shard provenance, and qualify the same manifest, Pool/root
code, decimal precision, bin spacing and T3 quote orientation. This helper does not fetch or
certify that provenance. No percentage-alert API or capability is enabled by this
dependency. The retained native regression
fixture contains original local VM transactions and account commitments; its
adapter observation times are test inputs, not live masterchain proofs.

Run `npm run test:ledger:cutoff-history`; `npm run test:ledger:market` and `npm test`
include it. The check performs no network read, signing or deployment.

### Historical market execution ledger

The release manifest's `spotMarkets`, token root code pins, DLMM wallet/pool
templates and router singleton configure the separate durable DLMM market
projection and qualify routed swaps in owner history. Markets whose required
root code pins are absent remain unqualified. Code hashes must come from the
reviewed deployment manifest; never enroll a live RPC code hash merely because
an address appears in discovery.
Use `INDEXER_DATABASE_URL` and the existing ledger database initialization. The
canonical `sql/ledger.sql` also creates independent `market_heads`,
`market_generations`, `market_observations`, `market_candidates`, and
`market_root_archive_states` tables.
Current single-pool RSWI swaps require the original payer transfer into the router,
Router-to-pool wallet settlement and finalization, exact RPSX pool allocation,
physical pool output and T3 protocol-fee delivery to the router, RPSC/RPCA
completion, and the independent router-to-beneficiary wallet finalizer. The
`routing` evidence keeps those intermediate custody legs separate from the user's
payment and received output. Missing callbacks, archives, qualified router code,
or incomplete chains leave explicit unresolved candidates. Limit orders, TWAP,
and multihop routes are not inferred from the ordinary swap decoder. Run
`npx tsx src/scripts/ledger-dlmm-routed-swap-test.ts` for real current-contract
execution and adversarial evidence tests.

Configured pools refresh through the durable account backfill every 30 seconds;
work is serialized locally, coordinated by a PostgreSQL advisory lock, and
published with an expected-generation fence. `INDEXER_MAX_RELATED_ACCOUNTS` and
`INDEXER_MAX_PAGES_PER_SYNC` bound each pass. Missing archives, incomplete backfill,
or an account cap remain explicit coverage issues. Auxiliary reads never submit
wallet transactions. Worker shutdown completes market work before closing the
shared account ledger.

Read `GET /api/indexer/v1/markets/:pool/observations` for settled executions and
`GET /api/indexer/v1/markets/:pool/candidates` for settled, fully refunded, and
unresolved acceptance candidates. Both support `from_utime`, `to_utime`, `limit`
(1–500), `cursor`, and `generation`. Time filtering is the half-open execution
interval `[from_utime,to_utime)`. Cursors bind the network, pool, list, interval,
and immutable generation; keep those parameters unchanged when following them.
Each page contains generation coverage, dependency head hashes and checked-through
times, candidate counts, and the refresh state. A quiet verified account refresh
advances coverage without changing historical execution values. Earlier
generations remain retrievable after later publications. An unconfigured store
returns 503; a pool without a qualified binding returns 404. Unavailable evidence
never falls back to current quotes or candles.

The projector qualifies the original payer message, exact physical input debit
and credit, pool state allocation, unused-input liability, actual output/refund
wallet credits, pool acknowledgement, wallet transfer-state finalization and
pool liability retirement. It supports distinct payer/beneficiary, repeated
business query IDs, partial fills, full returns, initially underfunded delivery
followed by a real funded retry, and next-head dispatch during prior settlement
finalization. Allocation follows the current contract's skipped-ID rules.
Authenticated uninitialized recipient accounts can receive a first credit even
when previously funded with TON. Pruned/exotic pool state, ambiguous physical
messages, missing notification bodies and incomplete state boundaries cannot
establish complete history. Failed or pending delivery never becomes an
execution observation merely because a request or pool acknowledgement exists.

Amounts remain integer atomic strings. `ratio` is a reduced exact fraction of
output atomic units per consumed input atomic unit, including trading fees.
`paidInputRaw = returnedInputRaw + consumedInputRaw`; submitted input alone is
not the price denominator for a partial fill. Execution, wallet delivery and
finalization times are separate. Native transaction fees retain their original
physical identities; unavailable fee amounts remain null.

Every observation carries separate `assetPrecision.input` and `.output` evidence.
Historical precision requires both roots' explicitly qualified current code hashes,
the matching wallet code, and archived root states immediately before and at the
masterchain block containing the pool acceptance. The current JTRS root writer
preserves its content and has no content-update or code-upgrade handler. Both
archived states must have identical content. This does not order cross-account
logical times; conflicting within-block metadata, deployment in that block,
unavailable archives, pruned cells, or an unqualified root remain unresolved.
Archive sequence numbers, original code/data BOCs, transaction identities,
retrieval time and the configured data-source attribution remain in the evidence.
The source API does not expose a transport endpoint or signed block proof, so the
indexer does not claim those were independently verified here.

The strict [TEP-64](https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md)
reader supports prefixed snake/chunked on-chain values and explicit decimals
0–255. A valid entirely on-chain dictionary with no decimals or URI uses the
standard's documented default of 9. Missing or malformed content cannot establish
that omission. Explicit on-chain decimals take precedence over a URI; URI-only
or semi-chain metadata without explicit decimals stays unresolved. The decoder
never fetches today's remote metadata. It retains raw content/field BOCs, hashes,
method and the standard URL. Metadata values are bounded to 65,536 bytes and
archive BOCs to 4 MiB; oversized data is unresolved, never rounded.

Precision failures do not erase physical executions, change atomic ratios, or
claim that chain history is incomplete. They prevent monetary composition until
resolved. Root archive queries are immutable, cached separately by network/root/
masterchain sequence, and do not recursively import the roots' account histories.
Concurrent cache publications use the one stored snapshot. The store recomputes
precision from retained cells and binds its block to the allocation boundary.

These observations are execution evidence, not a fiat price or a tax valuation.
They do not assert any T3 peg, sufficient market liquidity, a country policy's
acceptable sampling method, or complete coverage of every TONSwap market.
Joining an external historical anchor, selecting a documented country valuation
policy, and exposing that result in browser reports remain separate release work.
Replacement after a definite bounced transfer and unsupported control branches
remain unresolved rather than reusing an obsolete settlement shape.

Run `npm run test:ledger:market`, `npm test`, and `npm run build`. The market suite
uses original unmodified-contract Sandbox transactions and state boundaries for
full, partial, refund, queued and recovered delivery, prefunded first credit and
skipped allocation IDs. It also checks durable pagination, publication races,
exact amounts, missing evidence, quiet-chain freshness and route behavior.
`market-precision-test.ts` additionally uses a separate authentic deployment with
explicit 6/9 decimal content; the older fixtures remain unchanged and their
malformed metadata remains unresolved. Its archive adapter uses simulated block
sequence labels over original executor cells, not live masterchain proof.
The owner decoder fingerprint is `exact-ledger-v21`; the separate market schema
is `dlmm-market-ledger-v1`. Neither adds a backwards-compatibility decoder.
LP deposits require both matched funding legs and an exact positive
position delta at the applying pool transaction. LP withdrawals require the exact
negative share delta, delivered completion receipt, and terminal withdrawal
journal binding both payouts to their actual settlement nonces and wallet pairs.
Equal amounts or timestamps alone do not establish a withdrawal relationship.
Internal DLMM shares use `kind: lp_position`, ID
`<network>:dlmm-position:<pool>:<bin>`, owner, pool, bin ID and zero decimals;
they are not represented as a fictitious LP jetton.

LP state evidence records before/after data hashes and masterchain sequence
numbers. Archived account states must match the exact transaction and predecessor
LT **and hash**, and the registered pool's code and token roots. Several pool
transactions in one block may have no exposed intermediate account state. The
lite source can reconstruct a bounded internal-transaction segment using the
authenticated replay described below; missing archive inputs or unsupported execution remain
explicit `lp_*_state_unavailable` issues. No current position getter or requested
minimum is substituted. This requires an archive-capable configured liteserver and
does not claim every historic LP event can be resolved by all providers.

Current Options ledger operations use the release-pinned `OptionFactory`,
`OptionVault`, `OptionSeriesManager`, Shout/Outperformance child templates, T3
wallet and recovery-proof code. `currentOptionsBinding` is separate from the
retired factory/position layout. Current decoder qualification never supplies
missing original state or physical cash evidence.

The ledger infers OVBY/OVFD, OSWW, FEXC/OFEX and slot0 CLMJ requests from the
owner's original outgoing messages. It authenticates each original transaction
and both account boundaries, full causal messages, current contract peers,
canonical children and physical T3 debit/delivery. Current storage getters cannot
substitute for historical state. Business proof accepts up to 256 original
transaction envelopes at or after the dispatch; larger windows remain unresolved.

`kind: option_operation` exposes `settlement.currentOptions`: original dispatch,
request body, premium and fee components, writer backing/premium, right acquisition
or retirement, actual paid input/output and pending payout. Rights use nine-decimal
notional units. The premium and fee are components of one physical purchase debit;
writer collateral is separate funding. Metadata cash legs annotate the existing
T3 movements and must not be summed again. An accepted exercise can retire its
right while payout remains incomplete. Zero payout retires the right without a
cash movement; a refused exercise retains it. Retry delivery never repeats the
original debit. Aggregate owed claims retain `aggregateOwed` without inventing an
income source. Missing archive, wallet projection or related-chain coverage cannot
produce a confirmed settlement.

Run `npx tsx src/scripts/ledger-current-options-test.ts` for the current native
matrix and graph checks. The fixtures retain 24 original default/x6 snapshots from
a completed current440 producer run (two suites, ten tests), losslessly compressed
with original byte hashes, receipt, log and static source inventory. Sandbox head,
release and selected oracle responses are explicitly mocks. Portable current 1.5
compiler/source/artifact closure checks run with `npm run test:capture-build`;
missing historical producer manifests remain unqualified rather than being rebound
to a newer build. Old Options positive fixtures remain historical material and do
not admit the current release.

Fresh T3 uses the manifest's `T3Hub` as both hub and jetton master, with
`T3Wallet` and `T3RecoveryProof` code pins. Reserve identities carry each master's
and wallet's code hash, precision and immutable wallet budget profile. USDT/USDC
use six decimals and KUSD uses its declared precision; amounts remain atomic
strings. Current derivation authenticates all account/getter reads at one head.
The optional third slot may remain undiscovered without disabling the core pair.
There is no separate root, receiver contract or global wallet template.

`currentT3State`, `currentT3Wire` and `currentT3Proof` decode the current cells and
require exact original transaction summaries and before/after LT/hash, code and
data boundaries, including the original ShardAccount commitments in the transaction.
Unfreezing requires the exact incoming StateInit committed by the frozen account;
its prior token balance is preserved. An external receipt log is only a candidate: its leaf must
match the authenticated receipt tree. Successful mint, reserve payout and private
wallet delivery additionally require matched physical messages and exact source
and recipient balance changes. Burn retry does not debit the original wallet a
second time. A `SENT`, `FAILED`, accepted receipt or changed supply alone never
proves cash. Missing fee attribution remains `feeBreakdown: unavailable`.

`settlement.t3.receipt` includes the physical tree slot/key, exact record BOC,
record/root commitments and original request binding. `localNetworkFees` is
non-additive metadata; owned transaction fees already appear as movements.
`currentT3Receipts` reconstructs current hub witnesses and wallet recovery records
from complete initialization-to-head original history, authenticating every
historical code/state and checking every resulting tree root. It returns explicit
`unavailable` for gaps or missing logs that prevent reconstruction. These witnesses
authorize claim/recovery requests; they never establish payment.

Run `tsx src/scripts/runtime-t3-binding-test.ts`,
`tsx src/scripts/ledger-identities-test.ts` and
`tsx src/scripts/ledger-current-t3-test.ts` for the focused current port.
Retained G14 hub cases establish receipt/state correspondence. The six native
recovery cases retain 806 original transactions and exercise paired/direct mint,
transfer, redemption, reserve payout retry, refund, burn cancellation and mint
failure/retry. Their treasury funding and two forced wallet GRAM drains are
explicit sandbox preconditions: transaction pointers are linked, but those
mutated account boundaries do not establish complete physical history. The
reconstructor rejects the two injected wallet histories; unaffected account
trees and individual original transaction boundaries remain independently
verifiable. The portable `current-t3/source-closure` retains the exact original
1.5 manifest, source inputs and artifacts. The current verifier authenticates both
original producer receipts and their passing logs, including each target's full
Tolk import closure and virtual opcode/vendor inputs. Historical TypeScript
producer-source locks and compiler-binary locks were not recorded and are not
claimed. This source qualification does not authenticate public consensus or
qualify a public deployment; all current product and release gates remain required.
Run the dependency-refresh, boundary and platform-contract tests
after changing the shared native mint publication fixture.

Known perps OPEN/ADMG/MDIF funding and unverified T3 forwarding retain their exact
wallet transfers but cannot fall through to ordinary confirmed transfer settlement.

`historyComplete` proves the discovered account graph's observed chains, not
complete ownership, tax basis or portfolio coverage. `decodingComplete` is false
when identity, fees or supported settlement evidence is missing. Unsupported perps
aggregate/recovery and separate protocol cash flows, option abort/unwind and standalone expiry/shout paths,
rewards, cover, unsupported T3 refund/custody paths, launchpad claim/refund lifecycles,
and router/multi-hop operations remain explicit unresolved classes; raw native and
available token receipt evidence is retained. LP fee/principal tax treatment and
all country classifications belong to the tax engine. No fiat prices or user
secrets are stored here. Consumers must retain these gaps in reports.

Raw evidence and issued snapshot generations have no automatic deletion policy;
plan database capacity and backups. Use the canonical first-release schema;
legacy memory snapshots and unscoped projections are never imported. `npm run test:ledger`
runs PGlite PostgreSQL integration tests for exact large amounts, immutable
pagination, quiet snapshot reuse, new custody heads, resumable limits, admission,
deduplication, rollback and chain validation, plus numerical swap/LP/provenance
and option/T3 owner/query/position/message attribution fixtures, including
three-reserve mint conservation, sliced redemption, custody identity and fee provenance,
durable graph refresh, immutable activation after exercise/deletion, and unchanged dependency evidence reuse. Embedded tests do not
prove cross-process advisory-lock exclusion or
production archive availability. With no database configured the endpoint returns
HTTP 503 and never substitutes the bounded cache.

Run `npm run build` to typecheck and compile. For focused projection checks, run
`npm run test:ledger:scope` for exact owner/custody fee representation and
`npx tsx src/scripts/ledger-test.ts` for PGlite persistence, scope-only refresh,
immutable cursor scope, invalid metadata suppression, and transaction rollback.
The native PostgreSQL test uses the actual `pg` driver and a separately provisioned,
disposable empty database; set `INDEXER_TEST_DATABASE_URL` in that test
process, then run `npx tsx src/scripts/ledger-projection-scope-postgres-test.ts`.
Never point this test at an application database. The test does not establish
production archive availability or change the ledger's explicit decoding limits.

## Startup and release operations

Configuration, manifest and admission-artifact validation happen before listen. The listener opens before chain, database and native admission initialization; a live listener alone is not readiness. `/health` reports actual peer readiness, ledger state, disk capacity and admission state. It returns 503 when no peer is ready, disk is critical, or configured admission is not ready. Release admission separately requires the ledger to report ready. Database connection failures retry with bounded 2–60 second backoff; namespace, release or catalog conflicts remain unavailable without resetting data. Native authentication retries after 1–60 seconds while retaining its proof and artifact requirements. Source-mode workers cannot claim authenticated compiled-ledger readiness.

Use a fresh canonical database for this first-release schema. Retain old database/snapshot/journal state; there is no migration fallback. In one cutover window, start the new worker beside the existing one on another port with its new database and wait for readiness and singleton prewarm. Publish this phase's web build first, then switch the proxy to the new indexer, record ledger admission and run release acceptance. If the host cannot run two admission runtimes, publish the web first and then restart the indexer on the new database. Incomplete ledger reads remain pending. Rollback switches the proxy to the retained old indexer/database while the new web stays deployed. See `docs/rollback-checklist.md`.

The public proxy template is `config/nginx-indexer.conf`. Render `PUBLIC_MOUNT`, `LISTEN`, `BACKEND` and `ERROR_ROOT`, place `config/proxy-error.json` at the rendered error root, and run `nginx -t` before installation. It supports `/api/indexer` and `/api/indexer-r2`, unbuffered SSE, a three-second connect timeout and a twenty-five-second JSON timeout. Backend 429/503/504 responses pass unchanged; an unavailable backend produces the exact static 503 JSON, CORS, `Retry-After: 5` and `no-store`. Public metrics, debug and snapshots are blocked.

Rate limiting runs in the process. The edge must pass both `X-TONSwap-Edge-Key` and `X-TONSwap-Client-IP`; only a matching configured key and valid IP select a visitor bucket. Otherwise the raw socket address is the key. `X-Forwarded-For` supplies no identity. Direct requests remain allowed and share their socket bucket; the proxy does not add another limiter.

## Production Smoke
```bash
npm run smoke:production
TON_INDEXER_BASE_URL=https://test.tonswap.org/api/indexer-r2 npm run smoke:production
```

The smoke check verifies that the target host serves the TONSWAP API contract,
not another indexer service. The CLI is always release-bound: either command
above fails until all of the release inputs below are present in its environment.

Release-bound checks fail closed unless the network, release ID,
canonical manifest path/hash, and allowed browser origin are all pinned. The
manifest must be a canonical absolute path to a stable, single-link regular
file in a non-symlink, non-group/other-writable parent. A release-bound check
keeps the parent's device, inode, permissions and ownership stable across the
read. Unrelated sibling creation, deletion or snapshot renames are permitted;
the manifest file's full identity and content checks remain strict. Run
`npx tsx src/scripts/release-manifest-test.ts` and `npm run test:runtime-manifest`
after changes to these read checks. The public service must expose the manifest's exact contract
map, the three discovery/root equality pairs, and exactly two complete
one-minute single-trade candles for each of its three canonical markets:
```bash
TON_INDEXER_BASE_URL=https://test.tonswap.org/api/indexer-r2 \
TON_INDEXER_EXPECTED_NETWORK=testnet \
TON_INDEXER_EXPECTED_RELEASE_ID=<final-release-id> \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH=<sha256> \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH=/absolute/path/to/release-manifest.json \
TON_INDEXER_EXPECTED_CORS_ORIGIN=https://test.tonswap.org \
npm run smoke:production
```

The native manifest's `services.indexer` supplies the exact public mount and
service identity. With no target override, smoke uses that manifest URL.
`TON_INDEXER_BASE_URL` may be a transport origin or that origin
plus the exact manifest mount; another nonempty path is rejected before requests.
The transport origin can be an explicitly selected local proxy for an owned check.
Optional expected service-ID/public-URL overrides must agree with the manifest.
For example, `/api/indexer-r2` produces `/api/indexer-r2/v1/health`, once.

The backend still registers `/api/indexer` routes. Its native discovery, OpenAPI
path keys (with server `/`) and interactive docs advertise the manifest mount.
A distinct public mount requires a reviewed reverse-proxy mapping to the backend
routes that preserves methods, query values and streaming behavior. Keep any
funded release's existing service and public mount independently available.
These source changes do not provision a proxy or qualify either release.
Run `npm run test:public-mount` for offline route/document behavior and
`npx tsx src/scripts/production-smoke-adversarial-test.ts` for the loopback smoke
regressions, including exact R1/R2 mounts and rejection of cross-release routes.

The smoke sends simple and POST-preflight requests for both the allowed origin
and a distinct hostile origin. Hostile responses must omit both CORS
allow-origin and credential headers.

The certified manifest binds the three market identities and query metadata,
but does not contain the certified candle transaction IDs or time windows. The
standalone smoke therefore enforces six distinct, coherent transaction-backed
candles; the canonical release wrapper remains responsible for matching those
candles to the retained release proof.

Release acceptance uses the current local liteserver source, exact manifest service identity and native runtime qualification. Repository checks do not install the live proxy or mutate a funded release.

## Configuration
`INDEXER_RELEASE_MANIFEST` is required at bootstrap. Other environment variables
have defaults or are required only for their documented feature:
- `PORT` (default: `8787`)
- `HOST` (default: `127.0.0.1`)
- `INDEXER_MODE` (`dev` | `production`, default: `dev`)
- `TON_NETWORK` (`mainnet` | `testnet` | `localnet`, default: `testnet`)
- `INDEXER_ENABLE_WRITE_RPC` (`true` to allow single-attempt liteserver BOC submission; default `false`)
- `LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` / `LITESERVER_POOL_LOCALNET` (lite client pool; see below)
- `INDEXER_RELEASE_MANIFEST` (reviewed `tonswap-release-v1` file path or HTTPS URL; HTTP is allowed only on loopback; polled every five seconds)
- `INDEXER_DATABASE_URL` or `INDEXER_DATABASE_URL_FILE` (exactly one PostgreSQL secret source; each manifest hash receives a separate release schema)
- `INDEXER_EDGE_KEY` (optional authenticated-edge secret, at least 32 characters)
- `INDEXER_LEDGER_WORKERS` (default `3`, range `2..8`)
- `INDEXER_DISK_GUARD_PATH` (filesystem to monitor; defaults to the snapshot parent)
- `INDEXER_DISK_SOFT_FLOOR_BYTES` (default `2147483648`, 2 GiB)
- `INDEXER_DISK_HARD_FLOOR_BYTES` (default `536870912`, 512 MiB; must not exceed soft floor)
- `INDEXER_MAX_WATCHED_ACCOUNTS` (default: `1000`, range: `1..100000`)
- `INDEXER_MAX_PAGES_PER_SYNC` (default: `20`, range: `1..100`)
- `INDEXER_MAX_RELATED_ACCOUNTS` (default: `256`, range: `1..1024`)
- Native-release service metadata uses the manifest's exact `services.indexer` URL,
  with its host and mount path as the service ID. Exact current release bindings
  advertise `fresh-read` and `/api/indexer/v1/readFresh` in `/service-info`.
- `CORS_ENABLED` (`true` to enable CORS headers; default `true`)
- `CORS_ALLOW_ORIGIN` (default: `*`; `reflect` is treated as wildcard without credentials)
- `CORS_ALLOW_ORIGINS` (comma-separated exact-origin allowlist; when set, only matching origins receive credentialed CORS headers)
- `CORS_ALLOW_METHODS` (default: `GET,HEAD,POST,OPTIONS`)
- `CORS_ALLOW_HEADERS` (default: `content-type,accept`)
- `CORS_EXPOSE_HEADERS` (rate-limit headers plus mandatory `retry-after`)
- `CORS_MAX_AGE` (default: `600`)
- `SNAPSHOT_PATH` (snapshot path prefix; the actual file includes the manifest hash and is loaded only for that release)
- `SNAPSHOT_ON_EXIT` (`true` to write snapshot on shutdown; default `false`)
- `SNAPSHOT_AUTOSAVE_ENABLED` (`true` to periodically persist snapshots; default `true` in production when `SNAPSHOT_PATH` is set)
- `SNAPSHOT_AUTOSAVE_INTERVAL_MS` (default: `30000`)
- `RATE_LIMIT_ENABLED` (`true` to enable simple per-IP rate limiting; default `true`)
- `RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `RATE_LIMIT_MAX` (default: `10000`)
- `RATE_LIMIT_BUCKETS_JSON` (optional endpoint-class limits override JSON)
- `RESPONSE_CACHE_ENABLED` (`true` to enable response caching; default `true`)
- `INITIAL_HISTORY_TIMEOUT_MS` (default: `10000`, range: `1..120000`; caps the first account-history source read and returns `504` if it expires)
- `TX_CACHE_TTL_MS` (default: `1000`)
- `HEALTH_CACHE_TTL_MS` (default: `1000`)
- `METRICS_CACHE_TTL_MS` (default: `1000`)
- `PAGE_SIZE` (default: `10`)
- `MAX_PAGES_PER_ADDRESS` (default: `150`)
- `GLOBAL_MAX_PAGES` (default: `200000`)
- `IDLE_TTL_MS` (default: `7200000`)
- `BACKFILL_PAGE_BATCH` (default: `5`)
- `BACKFILL_MAX_PAGES_PER_ADDRESS` (default: `150`)
- `BACKFILL_CONCURRENCY` (default: `2`)
- `WATCHLIST_REFRESH_MS` (default: `5000`)
- `BLOCK_POLL_MS` (default: `5000`)
- `LOG_LEVEL` (default: `info`)
- `INDEXER_ADMIN_TOKEN` (required for snapshot save/load and debug endpoints; pass as `Authorization: Bearer ...` or `X-Indexer-Admin-Token`)

Explicit enum values for `INDEXER_MODE` and `TON_NETWORK` fail startup when unsupported instead of silently falling back.
The worker binds the configured `PORT`. If it is occupied, startup fails and the supervisor retries; a release reload never silently moves the public API to another port.

Production safeguards:
- Missing, malformed, unauthenticated or wrong-network release manifests fail startup.
- Code pins and deployment bindings come only from that manifest. Opcode definitions are bundled with the service.
- A changed manifest hash stops the old child worker before a fresh process starts with separate snapshots, PostgreSQL schema, jobs, caches and native admission workers.

## API

Native assets expose `GRAM` with nine decimals. `TON` names the network. Native identity is `kind: "native"` in balances and `<network>:native` in ledger movements; symbols never establish token identity.

`GET /api/indexer/v1/accounts/{addr}/balances` returns `{address, network, head_seqno, head_utime, complete, assets}`. Assets are GRAM then every manifest token in manifest order, always with manifest symbol and decimals. A verified row is `status: "ok"` with an atomic `balance_raw` string; a qualified undeployed wallet is `not_deployed` with `"0"`; an unavailable row retains its identity with `balance_raw: null` and a reason. Native read failure fails the whole request. `complete` is true only when all rows are verified or undeployed. There is no completed balance cache.

Each manifest token carries its own `masterCodeHash` and `walletCodeHash`. The wallet reader authenticates the master account and `get_jetton_data`, resolves the owner with `get_wallet_address`, and reads active wallet balances through `get_wallet_data`. T3Wallet, Jetton v2.1 and vendor stablecoin wallets keep their separate pins; no global wallet template or JTW1 storage assumption is used. Master code, wallet code, owner/root identity and transaction pointers qualify at the same head on every read, with no completed qualification or wallet-address cache. A read failure never means zero; display metadata never supplies accounting precision.

SSE `/stream/balances` accepts `address` and comma-separated `addresses`; `wallet` has no effect. One HeadFeed subscriber shares per-owner reads, with at most eight owners running and slow owners coalescing to the newest head. Each client gets an initial snapshot. Later verified amount changes emit `balances_changed` before a snapshot. Unavailable rows keep the previous verified comparison value, so availability flapping does not fabricate changes; the first verified value after initial unavailability does count.

Current routes include:

- `GET /api/indexer/v1/accounts/{addr}/balances`
- `GET /api/indexer/v1/accounts/{addr}/txs?page=1`
- `GET /api/indexer/v1/accounts/{addr}/state`
- `GET /api/indexer/v1/accounts/{addr}/ledger`
- `GET /api/indexer/v1/accounts/{addr}/ledger/discoveries`
- `GET /api/indexer/v1/markets/{market}/candles?market_address={pool}&asset_symbol=TOKEN&quote_symbol=T3&interval=1m`
- `GET /api/indexer/v1/ledger/readiness`

- `GET /api/indexer/v1/governance/{governance}/snapshot?owner={addr}&start_id=1&max_scan=20`
  - Requires the exact manifest `Governance` singleton/code and a complete active original ShardAccount at one fresh head. Current storage supplies locks and the uint32 proposal allocation range; `get_params(0..2)` supplies and verifies current class timing at that same head. Missing or malformed state/getters fail the entire page with 503; the shared deadline returns 504. There is no retired Voting decoder or completed snapshot cache.
  - The `tonswap-governance-snapshot-v1` response includes release/hash identity, full `asOf` head, code/data hashes, current lock fields, proposal tally/action BOCs and derived `closeAt`, `eta`, `expiresAt`, and `voting`/`closed`/`queued`/`expired` status. Financial amounts remain atomic strings. IDs below `nextProposalId` absent from this bounded page’s complete dictionary are `prunedProposalIds`; IDs at or above the counter were not allocated. Absence never identifies execution, defeat or expiry. Dispatch/queue state does not prove target execution. `page.complete` covers current dictionary presence only, `historyComplete` is always false, and `nextStartId` continues the bounded range (max 64 IDs). Each page independently refreshes its head. Cumulative serialized actions are capped at 1 MiB and the full response at 2 MiB; overflow is unavailable, never a truncated complete page.
  - Run `npm run test:governance` (also the ordinary suite’s pretest) for original source-bound native default/x6 states, real native getter timing cutoffs, pagination/absence, exact-head identity and fail-closed negatives. Retained producer evidence lives in `src/scripts/fixtures/current-governance`; its sandbox heads and separate native getter probe do not qualify public consensus or a deployed release.

- `GET /api/indexer/v1/contracts`
- `GET /api/indexer/v1/service-info`
- `GET /api/indexer/v1/stream/balances?address={addr}` (Server-Sent Events stream)
- `GET /api/indexer/v1/health`
- `GET /api/indexer/v1/metrics`
- `GET /api/indexer/v1/metrics/prometheus`
- `GET /api/indexer/v1/openapi.json`
- `GET /api/indexer/v1/docs`
- `POST /api/indexer/v1/runGetMethod`
- `POST /api/indexer/v1/readFresh`

JSON-RPC compatibility endpoints:
- `POST /jsonRPC`
- `POST /api/v2/jsonRPC`

These compatibility endpoints serve the same local chain source. Unsupported methods return 404; enabled BOC submission uses the same authenticated network. The OpenAPI document lists the current manifest mount.

Admin endpoints require `INDEXER_ADMIN_TOKEN`:
- `POST /api/indexer/v1/snapshot/save`
- `POST /api/indexer/v1/snapshot/load`
- `GET /api/indexer/v1/debug?limit=100`

Optional tx cursor query params:
- `cursor_lt`
- `cursor_hash`

Stream query params:
- `address` (single address)
- `addresses` (comma-separated addresses)

Metrics require the admin token. Existing request/cache/backfill counters remain; runtime metrics use `indexer_runtime_`. These include chain query latency and outcomes, head sequence/time, event-loop p95/max delay, ledger scheduler depth/foreground age, per-role pool wait, cycle phases, first-publication latency, five-minute database-size observations, refresh failure codes and confirmed regressions. Source/database timing totals are additive and may overlap wall-clock phases. Metric cardinality and log buffering are bounded; dropped-series and dropped-log counts reveal overload.

The disk guard samples every thirty seconds and treats unknown capacity as critical. Below the soft floor the state is low; below the hard floor or on statfs failure it is critical. Snapshot saves run only when disk is ok. Saves serialize asynchronously through one owned temporary file per destination, then rename; shutdown awaits in-flight saves. Critical capacity keeps health unavailable. Existing ledger evidence and resumable work remain intact; operators must restore storage capacity. No guard deletes operational data.

## Release Manifest

Set `INDEXER_RELEASE_MANIFEST` to the native deployer's reviewed
`tonswap-release-v1` manifest file or HTTPS URL. Loopback HTTP is supported for
local release runs. The supervisor polls it every five seconds. A changed
`manifestHash` drains and stops the previous child worker before starting a fresh
process; each release retains its own snapshot files and PostgreSQL schema, so
old ledger jobs and cursor generations cannot resume under new bindings.

The manifest contains `network`, `globalId`, `releaseId`, source/build identity,
services, singleton `contracts`, child-code `templates`, `tokens`, `spotMarkets`,
`perpsMarkets`, `options`, content-addressed vendor assets, campaign proof identity, `supplyBase`, `orderKeeper`, and `manifestHash`. Token entries contain exact master and wallet code pins; spot entries include X-token precision and its complete wallet gas/rent profile. Singleton entries are exact
address/codeHash objects. The SHA-256 digest authenticates recursively key-sorted
manifest content with `manifestHash` omitted. `/contracts` and `/service-info`
expose `release: { releaseId, manifestHash }` for the running worker. There is no
static registry, registry sync, secondary pin source or registry parity check. The stable public service mount is `/api/indexer` (testnet: `https://test.tonswap.org/api/indexer`); release IDs never enter its path. `/contracts` also returns the current templates, token pins and spot/perps/options inventories. These are deployment identities, not proof of current product readiness.

Every API response, including validation errors, preflight and ledger readiness, carries `x-tonswap-release` with the bound manifest hash. A request may supply the same header. A different hash returns HTTP 409 with `cache-control: no-store` before route work; an unavailable binding returns HTTP 503. CORS allows and exposes this header, including when custom header lists are configured.

Current source and native evidence qualify the implemented T3, Options, Perps, DLMM, Orders and Launchpad decoders. `deriveRuntimeManifestBindings` marks that current decoder set qualified; it never enrolls older business-state readers. An explicitly false binding still refuses ledger initialization before allocating a database. Canonical SQL/catalog, release namespace, compiled-build identity and live T3 reserve authentication remain mandatory. Unlisted token roots remain unqualified.
Reserve wallet custody still requires exact on-chain identity and archive
evidence. Native perps admission artifacts and chain/genesis authentication
remain required. Deployed identities do not establish fresh oracle depth, mint
delivery, writer backing or an economically funded Cover product.

## Notes

The sole source is the configured `ton-lite-client` pool. Current reads and durable historical proofs share its network authentication but have separate evidence requirements. Activity classification extracts intent from message opcodes and optional query metadata; classifier hints do not prove settlement. Candles include only confirmed DLMM swaps with decoded actual outputs, exact canonical market metadata and source transaction IDs. Minimum output never substitutes for received output.

### Swap `queryId` Metadata (Optional)
- Backward compatible formats:
  - `0xd1` (v1): mode + twap slice/total + timestamp/nonce.
  - `0xd2` (v2): mode + twap slice/total + pay/receive token codes + sequence/nonce.
- v2 token codes currently recognized:
  - `1=GRAM`, `2=T3`, `3=USDT`, `4=USDC`, `5=KUSD`, `6=TS`
- If `queryId` metadata is absent, classifier still falls back to opcode-level swap decoding.

### Liteserver Pool Format

Set the selected network's `LITESERVER_POOL_MAINNET`, `LITESERVER_POOL_TESTNET` or `LITESERVER_POOL_LOCALNET` to an absolute path containing a reviewed TON global-config JSON, or an inline comma-separated `host:port:base64-public-key` list. IPv4 and bracketed IPv6 endpoints are accepted. Pool files and endpoints are operator-supplied; URLs, relative paths, implicit public defaults and remote peer discovery are rejected. Missing or malformed pools fail configuration before listen.

### Exact perps ledger evidence

The release manifest supplies the current-network `PerpsEngine` identity and
approved code hash. Historical account code and state must match that binding;
RPC-observed code never defines the allowlist. Missing or mismatched deployment
qualification leaves product settlement unresolved while preserving physical
wallet transfers.
Current positions require exactly four counterparty coins in this order: reserved
LP cash, booked positive funding, collected trader loss, and remaining cumulative
gross entitlement. OPEN reserves 2N of LP cash and grants entitlement N using the
actual entry fill. Gross positive price and funding benefit share that entitlement;
paid funding and positive funding canceled against opposite debt consume it.
Partial exits retire the closed quantity's unused entitlement, deposits preserve
it, and actual new gross fills alone add new entitlement. Withdrawals retain entry
principal N even when a favorable price lowers the current margin requirement.
The API exposes mandatory `remainingEntitlementRaw`; omitted or old three-coin
states are unsupported. These bounds do not claim every LP position is lossless.
Run `npx tsx src/scripts/perps-entitlement-test.ts` for strict ABI and integer
boundaries, `npx tsx src/scripts/ledger-perps-test.ts` for synthetic lifecycle
conservation, and `npm run test:ledger` with genuinely recaptured current native
fixtures before release. Synthetic states never certify physical token settlement.

The durable graph crawls the canonical engine and the owner's and engine's T3 wallets,
including keeper transactions that name an owner without touching the owner's wallet.
Current and exact historical engine code must match the pin. The stored T3 root,
wallet code, deterministic wallet addresses, and wallet getter identities must agree.
The decoder reads exact before/after account, full owner/market position key, and payout
journal dictionaries; current `account_state` totals and global open interest are never
historical settlement evidence. Missing archive boundaries, identity, or related chain
coverage leave the operation incomplete. Backfill and dependency limits remain explicit.

Standard linear OPEN and full CLOSE requests first enqueue one immutable oracle
order. The current state ABI requires an order reference containing the original
request, original OPEN notification (empty for CLOSE), exact native budget,
outcome, reason and requested pool. Older receipt layouts are not decoded.
Every market also carries the mandatory third stats reference containing its
int64 funding accrual remainder in [0, 3600). Fractional elapsed funding survives
successive oracle callbacks; the integer funding index and position units remain
unchanged. The same reference ends with `oraclePriceHealthy:bool`. This per-market
fact qualifies the current execution price separately from a risk overlay that
halts new exposure. Accepted linear OPEN/CLOS needs a healthy callback price.
An absent or malformed reference or missing health flag is rejected.
The graph and bounded range worker also retain the pools actually addressed by
PRPQ. Acceptance requires the original PRPQ → pool → PRPC path and a separate
qualified engine transition; PRFA, an exact failed PRPQ VM bounce, or permissionless
PREX after the stored deadline can prove a rejection. A market-pool rebind only
permits reason-7 rejection through the original stored pool. A pending receipt,
expired wall clock, unrelated query, duplicate callback or an oracle price change
alone never establishes a trade.

`oracleExecution` retains separate queue, pool and completed transaction evidence,
plus the unchanged intake account, position and payout journal. A concurrent
position change before the callback never overwrites that original intake proof.
Economic state evidence binds the completed transaction and its timestamp, and
fill/funding arithmetic uses the market established by that callback. Physical
original deposits and final payouts retain their own transaction evidence. A
rejected CLOSE with unchanged account and position does not depend on unrelated
T3-wallet history. Derived market kinds have separate pricing rules and remain
explicitly unresolved by this standard-linear economics decoder.

When a masterchain snapshot skips an intermediate transaction, the lite adapter
fetches the full preceding Account and up to 32 original transactions. It uses
the original shard-block random seed and the historical configuration committed
by that block's masterchain reference. The pinned production dependency
`@ton/sandbox@0.43.0` executes these inputs locally; every reconstructed full
transaction Cell and new Account hash must equal the chain commitments. No
current state, default configuration, replacement request, or broadcast is used.
Basechain internal transactions are supported; missing library/context inputs,
external/ticktock transactions, longer segments, and any replay mismatch remain
unavailable. Existing qualified code, custody, request and economic checks still
apply. Install with `npm ci`, build with `npm run build`, and run the offline
original-transaction regression with `npm run test:historical-replay` (also part
of `test:ledger`). The bundled fixture contains public local-chain data only.

`perps_operation` events preserve the original request, owner, market, business query,
separate jetton funding query, exact state hashes and block boundaries, stored account
and position snapshots, and signed atomic economics. Open/modify/close, margin changes,
booked funding claims, forced liquidation, and ADL are accepted only when exact source
arithmetic conserves collateral, funding, position, payout liability and bad debt. A
rejected funded preflight can produce a verified refund liability; it never proves an
opened position. A token-free funding retry never creates new funding income. Position
margin is a reserved subset of collateral, and exposure is not a received underlying
asset. `perps_balance` movements represent changes in booked collateral or funding,
not jetton transfers. Pending payout liability stays in metadata, avoiding a second
asset credit when wallet delivery has already occurred. Assessed trading fees are in
`economics.tradeFeeRaw` and split from the existing debit: OPEN pays from its T3
deposit, while modify/close pay from booked collateral. Principal plus fee equals
the original debit; the metadata fee must not be added again. Engine/custody native
fees are retained with their actual payer and are not charged to the user.

Operation outcome and payout completion are separate. A completed individual payout
requires the original engine liability/wire, exact typed token delivery, receiver ACK,
source wallet success, engine finalize, wallet finalized ACK, and historical engine
journal clearance. A sole READY liability may be followed through exact intervening
journal boundaries to its later assigned wire. Additional queued contributions remain
`aggregate_unresolved`; no combined payment is assigned to the nearest trade. Missing
ACK/archive evidence stays pending even when a physical token credit is known. Ordinary
TEP-74 excess messages cannot certify settlement. Accepted physical credits are deduped
by the canonical typed wallet wire and are retained independently of product decoding.

Current limits include aggregate payout attribution, lost/replayed control paths that
cannot reconstruct the complete original ACK chain, protocol fee routing allocation,
and separate RiskVault/insurance/referral reward cash flows. Funding index updates are
accrual inputs, not cash movements. Production archive availability must be qualified
independently. `npm run test:ledger` includes exact numerical/provenance perps fixtures
and PGlite ingestion, dependency coverage, and immutable snapshot reuse tests; it does
not replace live release qualification.


Option purchase acquisition is proved from the factory state immediately before
and after the first successful activation ACK. `option_position` movement evidence
contains `optionPosition` with the original owner/factory custody wallet, series/position,
notional/premium/collateral, series and custody wires, fee/excess, and before/after
buy flags. Both exact transaction boundaries must have the verified factory code;
the position must transition from all activation prerequisites to ACTIVE without
abort/refund state. Outer evidence supplies before/after data hashes, block numbers
and the actual activation transactions. Later exercise, changed collateral/premium,
or position deletion cannot alter this original acquisition. No latest
`position_info` getter is used or emitted for historical ownership proof. Missing
archive boundaries remain `option_activation_state_unavailable`; existing verified
message chains or current counters cannot replace them. Post-purchase settlement
and OptionsVault liability release remain separate: a liability release alone is
not a token refund.

The historical `optionPosition.sourceWallet` is the factory-owned collateral
wallet stored by the current contract. It must equal the actual factory receipt
wallet in the original funding evidence. The buyer's source wallet remains the
funding debit asset's `wallet`; consumers must bind these distinct identities.

Factory ingress receipts use the sole current layout: accepted flag,
`buyKey:uint128`, accepted amount, then the pending refund dictionary. Historical
abort proof binds that key and amount to the exact original allocation and token
payment. A separate physical refund cannot alter an earlier accepted identity.
The current Factory state also requires the series expiry-registration flag and
writer native-escrow reference before the returns reference. Its guard cell stores
exactly guardian and oracle addresses; obsolete canary owner/mode fields are rejected.
Missing fields and the former two-field receipt are rejected. The lifecycle suite
includes an actual VM Factory state BOC as well as malformed-state fixtures. Run `npx tsx
src/scripts/ledger-option-lifecycle-test.ts`, `npx tsx
src/scripts/ledger-option-abort-test.ts`, and `npx tsx
src/scripts/ledger-option-buy-bounce-test.ts` after changing this interface.

Regenerate the actual rejected-ingress fixture with the maintained preparation
tool after building the current native testnet artifacts (`build:deploy:testnet`
in `../tonswap_tolk`). Use the reviewed Node executable and its SHA-256, with
that executable's directory first in `PATH` and `NODE_OPTIONS` unset:

```sh
"$NODE" --no-turbo-fast-api-calls scripts/refresh-options-rejected-ingress-fixture.cjs prepare \
  --native-root "$NATIVE_ROOT" --node-sha256 "$NODE_SHA256" --output-root "$NEW_OUTPUT"
```

All paths must be absolute; the output directory must not exist. This runs the
complete 55-test `OptionFactory.spec.ts` with `OPTIONS_REFUND_STATE_CAPTURE=1`,
freshly compiles Factory, Wallet, Root, Shout and Outperformance, and validates the
actual BOC against the current strict state decoder and embedded code identities.
It checks complete native source/runtime equality, authenticated testnet build
inputs, complete compiler imports, actual unfiltered Jest JSON and log, and owned
process cleanup. It retains the capture under `capture/` and writes the unchanged
captured BOC and provenance under `fixtures/`. Failed or interrupted runs never
produce accepted fixture outputs. This is local fixture preparation, not release
qualification or evidence of live settlement.

A separately reviewed, already completed producer can be consumed without
repeating its native suite:

```sh
"$NODE" --no-turbo-fast-api-calls scripts/refresh-options-rejected-ingress-fixture.cjs adopt \
  --capture-dir "$CAPTURE_DIR" --native-root "$NATIVE_ROOT" --node-sha256 "$NODE_SHA256" \
  --source-before-sha256 "$REVIEWED_SOURCE_BEFORE_SHA256" \
  --compile-sha256 "$REVIEWED_COMPILE_JSON_SHA256" --output-root "$NEW_FIXTURE_OUTPUT"
```

The explicit pins select the reviewed actual producer/runtime authority and its
fresh independent compiler output; they must not be manufactured by repinning old
transactions. The capture directory must contain the complete source-before/after,
producer-launch/terminal/result/log, independent-compile JSON/terminal/log and
diagnostic files emitted by `prepare` (or the equivalent reviewed producer).
After reviewing the two output files, copy both into `src/scripts/fixtures/`,
then run the lifecycle consumer above and the native release fixture preflight.
The tool never overwrites canonical fixtures automatically. Its maintained
negative and process-cleanup tests run with
`"$NODE" --no-turbo-fast-api-calls --test scripts/refresh-options-rejected-ingress-fixture.test.cjs`.

### Option exercise, payout and individual refunds

The release manifest's OptionFactory/OptionVault/T3Root singletons and
`ShoutOption`, `OutperformanceOption` and `JettonWallet` templates supply option
qualification. Observed
code/configuration and exact historical evidence must match those pins. Missing
or mismatched bindings leave option settlement unverified, including historical
purchases, while preserving known physical movements.
`option_exercise` identifies the original owner, factory, series and position,
the exact original FEXC body hash, and the qualified historical factory/product
state boundaries. Shout requires its product callback and deleted product right;
Outperformance requires the stored settled payout and exercised position. A
confirmed exercise records one outgoing `option_position` with purpose
`option_right_retired`. `settlement.optionLifecycle.payout` is separate:
`none`, `pending`, or `completed`. Its `amountRaw` is null until the product
transition proves the actual quantity. Caller intent is retained separately in
`requestedPayoutRaw`/`requestedPremiumBurnRaw`. These exercise bodies carry no
user query ID; position, business journal key and delivery wire remain distinct.

Completed cash requires the full factory SPYT request hash, vault journal key,
original recipient, canonical root/derived wallets, exact wallet transfer and
recipient credit, positive acknowledgement, finalize and finalized acknowledgement,
and historical DELIVERED→FINAL journal/balance conservation. Actual owned credits
alone receive `option_payout`; a third-party recipient credit is never added to
the holder's balance. `requestEvidence`, `productEvidence` and `positionEvidence`
retain the separate historical hashes and transactions. A completed right can
coexist with a queued or bounced payout. `ReleaseCollateral` and premium release
are liability metadata, never invented cash refunds or additional fees.

`option_refund` proves one factory ingress/excess claim or a qualified
owner-requested or initial-series-bounce purchase unwind. Individual claims bind the original funding query/payload (ingress) or original position/refund owner
(excess), claim identity, actual payment wire, full wallet finalization and the
historical claim removal/identity tombstone. Early OCRC receipts, current missing
claims, retry funding and transferred tokens without this evidence cannot prove
claim completion. Replay is deduplicated by business identity. Native transfers
and all available raw transaction/message fees remain physical evidence;
`localNetworkFees` is provenance and must not be added again to owner movements.

Owner-initiated `OBAR` unwind uses `refund.kind: aborted_buy` and
`scope: position_unwind`. `refund.unwind` preserves the original FBUY funding
query/payload/body hash, exact buyer/factory wallets and gross amount, historical
allocation and product reservation, required `trigger: {kind: owner_abort, bodyHash}`, custody wire and actual
custody finalization, commit outcome, individual vault receipt/tombstone, product
cancellation and separate `factoryReturn`/`vaultReturn` cash legs. All amounts are
atomic strings; an inactive reservation creates no option right. For no committed
custody, the factory must physically return the gross funding. With proven vault
custody, the vault returns collateral plus premium and the factory returns the
original fee plus excess. Each return requires the exact full wallet finalizer
and historical controller state; neither `OBAA` nor a `REFUNDED` bit is cash.
The vault refund journal starts with accounting unapplied (0), stays unapplied
while DELIVERED, and becomes applied (1) only at FINAL. This refund journal has
no RiskVault claim; its dispatch and finalizer must preserve that scope.

A failed or not-yet-observed custody commit can use the vault's individually
bound orphan refund path, with that commit outcome retained explicitly. A
successful commit additionally requires the original exact receipt and bucket
changes. The canonical `vaultAbort` boundary includes required
`receiptBeforeHash` (explicitly null for orphan custody), `receiptAfterHash`,
`trackedBalanceBeforeRaw`, `trackedBalanceAfterRaw`, and nullable
`beforeBucket`/`afterBucket`, bound to its single historical vault transaction.
Observed commits and aborts have independent historical boundaries; unrelated
vault activity between them does not invalidate the position receipt.
Committed deposits decrease both bucket and aggregate locked/premium amounts
without changing tracked balance. Orphan custody increases tracked balance by
the exact principal and preserves the complete bucket dictionary and aggregate
amounts. Missing fields are not a substitute for proof. Snapshot identity uses
decoder `exact-ledger-v21`; consumers use this canonical format without an older
format adapter. A partial return records only its actual credit and leaves the purchase
refund pending. A complete refund conserves the original gross funding exactly
once, and replaces that request's incomplete acquisition event with the same
stable purchase group. Actual native budget returns and independent raw fees are
retained; network-fee metadata is never another owner debit. Quiet-wallet
backfills include custody/product dependencies and reuse unchanged published
snapshots. Missing archive or related history stays explicit. Known unresolved
option funding/cash cannot become ordinary confirmed transfer settlement. Discovery
includes the qualified factory/vault and affected product/custody wallets even
when the original purchase is outside the returned date range. Independent
RiskVault reimbursement remains `protocolAccounting.status: unverified`, even
when its journal claims FINAL. Automatic NACKs and later-stage bounces,
later cancellation-dispatch recovery, previously bounced custody attempts,
standalone shout/settle/expiry, direct product-only exercise, keeper rewards and protocol fee
routing cash remain unsupported; no full refund, expiry loss, remote receipt or
tax treatment is inferred. `npm run test:ledger` includes numerical and adverse
lifecycle fixtures; live archive availability remains a release qualification.

A failed initial Shout `BOYR` or Outperformance `BBUY` can automatically unwind
without an owner cancellation. Its required `trigger.kind` is
`initial_series_buy_bounced`, retaining the actual 288-bit VM bounce BOC and hash,
original assigned-message hash, failed product and successful recovery references,
and exact factory series/index before and after values. Qualification requires
unchanged complete product state with no reserved position, exact original
allocation, canonical wire counters and wallet funding, index removal and exact
capacity release. A successful recovery can dispatch payment while receiving a
bounced message; only that proved dispatch gets this exception. The ordinary
wallet finalizer still establishes actual cash. A busy factory or missing payment
receipt leaves the return pending. Uninitialized/unreachable product execution,
manual truncated prefixes and other automatic abort paths remain unresolved.
The focused producer checks run with
`npx tsx src/scripts/ledger-option-buy-bounce-test.ts`; archived dictionary checks
run with `npx tsx src/scripts/ledger-option-factory-state-test.ts`.

Regenerate the canonical cross-service abort fixtures with
`npx tsx src/scripts/export-option-abort-fixtures.ts services/platform/test/fixtures`.
The exporter runs the actual ledger projector over archived-state/message fixtures
for committed, failed and unobserved deposits, independently pending cash legs,
existing populated buckets, and complete/pending initial-bounce returns for both
products. `option-abort-provenance.json` records each
fixture's SHA-256, commit outcome and physical credits.

### Graceful shutdown

`SIGINT` and `SIGTERM` stop workers and close active balance SSE streams before
draining HTTP and ledger work. Repeated signals share the same shutdown; cleanup
failure or a 20-second deadline exits with status 1 so the supervisor can replace
the process. `npm test` includes real HTTP/SSE and child-process shutdown regressions;
run them alone with `npx tsx src/scripts/shutdown-test.ts`. `npm run build` compiles
the same shutdown path used by `npm start`.


### Launchpad participation and refund ledger evidence

The release manifest supplies deployment-qualified `SaleFixed`, `SaleBonding`,
`SaleAuction` and `JettonWallet` template hashes for the
selected network. RPC-observed code never defines this allowlist. Without
qualification, Launchpad token movements retain exact cash and fee evidence with
unresolved product settlement.
Known sale addresses come from release-manifest markets and observed claim or
contribution destinations. An empty-payload return can also be discovered through
its independently resolved source wallet owner.

Launchpad `priceRaw` and `maxPriceRaw` encode the raw T3/token ratio multiplied
by `10^18`. Contributions receive `floor(paymentRaw * 10^18 / priceRaw)` tokens;
auction bids pay `ceil(quantityRaw * maxPriceRaw / 10^18)`. This first-release
format has no legacy-price conversion. Run `npm run test:ledger:launchpad` to
verify the captured contract states, wire requests and settlement arithmetic.

The participation decoder requires an explicit qualified fixed, linear bonding,
or Dutch auction model. It binds the original owner transaction and outgoing
message to the exact source-wallet debit, sale-wallet credit, notification and
archived participant-entry change. `launchpad_participation` means the payment
was accepted; it never supplies delivered sale tokens. Metadata preserves both
actual inner and outer query IDs, original and incoming message hashes, model
entitlement before/after, and all three historical state boundaries. Repeated
query IDs and byte-identical messages in distinct transactions remain distinct
requests. Every recognized original also publishes `launchpadRequests`,
independently of settlement, including the owner transaction, outgoing message
index and body hashes. Consumers count this same physical identity even before
a payment reaches the sale; an unresolved duplicate cannot disappear from a
confirmation scan. Incomplete typed participation and narrowly identified pre-credit
requests retain a `launchpad_participation_settlement_unverified` marker so
notification scanning can revisit the original boundary. Missing historical
wallet activation/balance evidence remains unresolved.

The fixed-sale decoder verifies an initial failed-soft-cap refund against the
original single contribution, historical claim entitlement, newly reserved
payment record, canonical source and recipient wallets, exact typed delivery
handshake, and the sale's independent DELIVERED-to-FINAL reserve release.
Historical code, transaction identity, and related history must agree. A journal
FINAL flag alone is insufficient: the contract also uses it to retire a failed
attempt before issuing a fresh wire. Retry ancestry, accumulated contributions,
successful-sale claims, bonding and auction payouts, and vesting remain explicit
decoding gaps in the refund branch. No tax classification follows from a refund label. Recognized claims without
historical settlement proof carry `launchpad_claim_settlement_unverified`;
notification consumers retain their scan boundary until the evidence resolves.
Recorded factory identity is provenance, not an assertion of official registry
authority.

Original contributions remain at their original economic time. The refund uses
only its observed cash flow and owned physical transaction fees; the separately
queued creator insurance return does not become the participant's refund.
`npm run test:ledger:launchpad` runs configuration, storage/wire, projector, and
graph discovery checks using a contract sandbox trace. No provider credentials or
live transactions are needed. The decoder fingerprint is `exact-ledger-v21`, so
changed decoding or evidence publishes a fresh immutable generation instead of
reusing earlier projections.

### Native DLMM farming observations

Current farming uses the pool's `get_farm`, `get_farm_pending` and `get_next_farm_id` getters through the normal exact-head `readFresh` or `runGetMethod` transport. There is no dedicated farm snapshot endpoint. Cover, volatility-index and old farm snapshot routes return 404 and are absent from OpenAPI. Current operation and ledger proofs independently require original state and physical payout evidence; getter values alone do not prove wallet delivery. The retired tuple decoders and their positive test aliases are not part of the current runtime; retained original fixture evidence remains unchanged.


### Durable owner-event discovery

`GET /api/indexer/v1/accounts/{addr}/ledger/discoveries?since=<ISO>&after_revision=0&limit=100` returns newly published owner-event revisions, independently of the original request date. An immutable revision contains the full event, exact decimal-string revision, publication generation, `discoveredAt`, and `evidenceUtime`. The latter is the maximum of the original event and canonical settlement transaction-reference timestamps: it selects discovery candidates and never asserts a particular stage completed. Notifications must qualify the stage and use that stage's required chain transactions for eligibility. Publication time never substitutes for chain confirmation time.

The initial `since` is a canonical ISO timestamp with milliseconds. A revision qualifies when publication is at/after `since` **or** its canonical chain evidence reaches that instant; thus enrollment does not lose a pre-enrollment publication whose chain evidence reaches enrollment. This candidate test also prevents stale historical activity from being replayed merely because a consumer starts late. A consumer still applies each notification category's independent activation boundary to the qualified stage time.

Every completed owner publication holds the owner account row lock and publishes its changed event revisions, per-owner revision counter and generation atomically. Exact revisions remain strings beyond 2^53. Unchanged event evidence, including a getter timestamp-only refresh, produces no new revision. Physical related-account chain publication produces no owner discovery event. These records are durable and never inherit the memory history limit or an arbitrary request-date lookback.

The response's `throughRevision` and coverage generation define a fixed upper boundary. Follow `nextCursor` without changing owner, network or `since`; if also supplied, `after_revision` must match that cursor's last consumed revision. Once the page sequence completes, persist `throughRevision` and use it as `after_revision` in the next poll. A later old-request settlement is a higher revision even if its chain timestamp is hours or days behind the current head. A restarted consumer resumes its exact revision. Cursors cannot be spliced across generations, owners or networks. Consumers must not advance on incomplete/stale root coverage, malformed records, or lost job leases; immutable continuation pages retain the original verified dependency boundary.

This is one canonical first-release schema: `ledger_runs.discovery_revision`, `ledger_discovery_heads` and `ledger_discovery_events` are required. Initialization rejects a superseded schema without adding a compatibility adapter or changing existing rows. Qualify the matching schema/API/worker together before release; this documentation does not authorize resetting a live database. The existing `/ledger` endpoint remains the canonical transaction-history interface for reporting, while `/ledger/discoveries` is the publication-discovery interface.

Run `npm run test:ledger:discovery`, `npm run test:ledger` and `npm run build`. The discovery suite exercises actual PostgreSQL SQL in PGlite, including delayed settlement, fixed cursor pages, exact large revisions, wallet/network isolation and rollback. PGlite does not establish multi-process row-lock behavior or real browser push delivery.

For actual connection and row-lock verification, provision an isolated **loopback-only** PostgreSQL test instance, set `INDEXER_TEST_DATABASE_URL` only in the test process, and run `npm run test:ledger:discovery:native`. It creates and removes its own random schema. The fixture observes two simultaneously blocked generation publications, allows an independent owner to publish, verifies exact commit ordering, and forces a partial insertion rollback before proving the next publication can acquire the lock and reuse the uncommitted revision. Never target an application database.


### DLMM liquidity source evidence

The canonical owner ledger distinguishes `lp_deposit`, `lp_withdraw`, and
`lp_fee_collect`. Deposits require the original two physical contributions, the
current pending journal, and exact integer mint economics. Withdrawals require
both the position burn and principal/fee reserve changes. Standalone collections
claim the requested proportion of accrued credits without burning shares; their
wire business query is zero, so the original transaction identifies each request.
The public collection event omits `queryId`; `request.transaction` supplies its
actual identity. All owner-ledger transaction references use canonical base64
hashes, including nested proofs; contract, body and data hashes remain hex.

The deposited position marker's `evidence.dlmmDeposit` retains the exact shares
before/after the applying transaction, the minted amount and requested minimum,
qualified pool/wallet code, and both original funded contributions. Each binds
the existing outgoing token movement ID to its owner request, actual debit,
pool-wallet credit, pool acceptance and authenticated wallet/pool state boundaries.
Atomic token contributions and attached native funding remain separate.
Neither a minimum nor an absolute position balance supplies an acquisition value.
Missing funded-source or archive evidence never produces this metadata.

`settlement.dlmmLiquidity` records qualified pool/wallet code hashes, exact before
and after state references, share counts, principal and earned fee components,
and both token payout states. `status` describes physical delivery and `finalization`
separately describes protocol acknowledgement/cleanup. A verified credit retains
its `deliveryEvidence`, components and actual timestamp when a later finalizer
is missing; full `settlementEvidence` is added only after protocol completion.
Each delivered owned token has one physical ledger
movement, with `evidence.dlmmReceipt` describing its components and actual credit
transaction. Never add the component amounts to the original receipt again.
A payout to a separate recipient has no invented receipt in the position owner's
ledger. Zero-fee collections have no token movement. Missing one delivery leaves
the operation incomplete while retaining independently verified physical data.

The shared typed-settlement verifier checks original requests, exact wallet
balance changes, recipient acknowledgements, finalizers, queue identity and
reserve release. The withdrawal completion message additionally verifies closure
of both legs and release of its native completion reserve. First wallet credits
use explicitly authenticated transaction-free historical states; absent archive
metadata never becomes a fabricated zero balance. Current constructor and
persisted storage layouts are qualified directly. Superseded partial dictionary
readers have been removed; this is the canonical first-release decoder.

The report UI displays source components and physical receipt time. These are
protocol facts, not an income/disposal classification or a token decimal/price
assumption. Nonfungible DLMM positions and unclassified LP movements remain
unresolved until the selected country policy supports them. The all-country
release gate continues to reject incomplete policy coverage.

Run `npm run test:ledger:liquidity`, `npm run test:ledger` and `npm run build`.
The liquidity fixture executes the current compiled contracts in local Sandbox:
two deposits, swaps earning both fees, partial withdrawal, partial collections,
collection to an initially unfunded recipient, final fee drain and a zero-fee
rerun. Tests retain original transaction/account BOCs, independently check exact
integer arithmetic, exercise missing/conflicting evidence and round-trip the
actual owner projection through PostgreSQL SQL in PGlite. Synthetic local token
funding and treasury setup are explicitly identified; this does not qualify a
mainnet deployment, fiat valuation, historical token precision or tax policy.

## Original transaction evidence

`getTransactions` on `/jsonRPC` and `/api/v2/jsonRPC` reads original transaction cells directly from the configured TON liteserver pool. Each response includes `data` (the original cell graph as a base64 BOC), exact `transaction_id`, message bodies and actual compute/action outcomes. It never turns activity-summary cache rows into transaction proof. The REST activity-history endpoints remain paginated summaries.

A cursor-free read first obtains the account's current transaction LT/hash; an explicit `lt`/`hash` request is exact and inclusive. Every page must match that anchor, the requested account/workchain, and every predecessor LT/hash. The reader fills the requested limit (1–50) across provider pages, or stops only at the canonical first-transaction predecessor. Missing original cells, malformed data, broken links and incomplete anchors fail the request. This is hash-bound provider evidence, not a substitute for independently verifying TON consensus proofs.

The liteserver source preserves original returned cells and block workchains; it never serializes reconstructed transaction summaries. No database migration or cached-history rewrite is needed.

`npm test` runs the original-evidence regression through the mandatory adversarial suite. For a focused local check, run `npx tsx src/scripts/transaction-evidence-test.ts`; it uses authentic sandbox-emitted transaction cells and tests the liteserver source, exact cursor chains, actual failures, atomic amounts, and the service/HTTP response.


#### DLMM withdrawals with zero token payout

The current pool can burn a positive number of shares while both token amounts
round down to zero. The exact ledger still publishes the proved `lp_withdraw`,
its original request, before/after position state, positive share-burn marker,
and actual `DWCM` native completion. Both token-side records have zero component
amounts, `status: none`, `finalization: none`, and null settlement, movement and
delivery references. No zero-amount token movement or synthetic wallet receipt
is created. Both ends of the native completion must carry the same exact
50,000,000 nanotons, alongside the existing sender, recipient, body, source order
and terminal withdrawal-state checks. Missing or conflicting completion evidence
remains unresolved even when neither token requires a payout.

`src/scripts/fixtures/dlmm-zero-payout-settlements.json` is a separate current-code
Sandbox fixture. Two owners each deposit one atom of each token for two shares.
The first owner burns one of four total shares, then its last share out of three;
both withdrawals receive zero token atoms. The remaining owner then burns its two
shares and receives the entire two-atom reserve of each token. These are actual
root mints, wallet transfers and pool calls; no pool/token state is fabricated or
protocol math changed. Token precision and any legal/tax classification remain
unresolved. The fixture preserves all 87 transaction BOCs and before/after account
archives, compiler/source hashes and explicit Sandbox-only native treasury funding.

Run `npm run test:ledger:liquidity` (included by `npm run test:ledger`) for the
positive, missing-proof, exact-component, original-source, owner-isolation and
durable PostgreSQL-compatible cursor round-trip checks. To retain the two owner
projections and source-coverage evidence, set `DLMM_ZERO_PAYOUT_EVIDENCE_OUT` to a
local artifact directory when running `npx tsx src/scripts/ledger-dlmm-zero-payout-test.ts`.
The original nonzero liquidity fixture remains unchanged. The separate generator
and source qualification are recorded in
`../output/first-release-ui/dlmm-zero-payout-20260911/fixture/`.


Native terminal accounting uses the original transaction outcome on each native
movement's `evidence.transactionStatus` (`success` or `failed`) and exactly one
`evidence.transactions` reference. The enclosing event status belongs to its
first grouped transaction and does not qualify every movement. The ledger
normalizer requires explicit terminal `RawTransaction.status` consistent with
`success`; missing, pending or conflicting results stop publication as a decoding
gap. Original BOC adapters supply the outcome from the transaction description.
No fallback from the event anchor or missing status is supported.

Actual native input, bounce/output, transaction fee, forwarding and IHR fee slots
remain physical balance effects when computation fails. Forwarding and IHR fees
are emitted once by the shared normalizer and remain separate from `totalFeesRaw`.
A failed token transfer instruction remains unconfirmed and does not create a
settled token credit. Terminal status is specific to native movement evidence;
shared historical transaction references and market evidence retain their own
contracts. This does not infer beneficial ownership, tax classification or a
deduction. Decoder `exact-ledger-v21` gives reprojected canonical records a new
fingerprint, without an old-format adapter.

Run `npm run test:ledger:native-terminal`, `npm run test:ledger`, and `npm run build`.
The focused test re-decodes retained Sandbox BOCs, checks exact account-state
balance conservation, and separately labels constructed multi-account scope and
IHR examples. It requires no live network, wallet signing or deployment. Optional
`NATIVE_TERMINAL_EXPORT_DIR` writes the retained source and current projection
evidence for independent consumer tests.

### Bounded perps settlement proofs

`GET /api/indexer/v1/accounts/{owner}/ledger?scope=perps&from_utime=...&to_utime=...`
requests a half-open interval. Its dedicated worker and `ledger_perps_ranges`
table are independent of unfinished all-history runs. The owner, owner T3 wallet,
qualified engine and engine T3 wallet share one masterchain boundary at or after
`to_utime`. Each linked chain is verified to its lower-bound witness. Raw
head-to-boundary evidence and the perps projection are immutable after completion.
Existing exact historical state, economic conservation and payout checks apply.

Wallet identity uses these same captured accounts: the qualified engine's wallet
code derives both T3 wallet addresses, and each active wallet must have that exact
code plus the sole current storage layout with matching owner/root and both full
burn and mint journals. Uninitialized, missing, malformed or conflicting state
stays unresolved. Latest-head getters, cached identities, balance discovery and
display metadata cannot admit or block this historical proof. Range assets carry
raw atomic identity; they do not infer symbols or decimals. The range regression
suite includes captured testnet wallets and an original Tolk CLOSE trace with
all latest-head identity and metadata methods unavailable.

Poll unchanged bounds while `coverage.range.status` is `pending` or `running`;
these responses contain no events. Consume only when the range scope, bounds and
generation match, and `range.complete` and `snapshotComplete` are true. Cursor
pages retain that same scope and generation. `historyComplete` remains false;
only the requested perps interval is proved. Failed work reports an explicit
issue and no events. Polling the exact same bounds after `coverage.range.retryAfter`
admits one new generation, including after a service restart. The previous failed
row and all published cursor snapshots remain immutable. Backoff starts at five
seconds, doubles after each unsuccessful generation and is capped at five minutes;
concurrent readers share a single active generation. Completed snapshots with
unresolved operations can similarly refresh when missing archive evidence becomes
available. Fully decoded snapshots retain their generation. A later interval is a
new proof, without advancing an old
all-history cursor. Aged orders retain their original lower bound so delayed
payouts remain discoverable. Work is bounded by four base accounts plus up to 128
requested oracle pool accounts, 128 chain pages,
a 120-second collection budget, two concurrent workers and 128 active jobs per network;
capacity exhaustion never certifies partial evidence.

Service startup resumes durable pending and crashed running ranges even when their
original clients have left. A five-second sweep queues at most 64 jobs, using the
same two workers and per-generation PostgreSQL locks as new requests. A chain head
that is not ready retries with persisted 5–300 second exponential backoff. Active
generations expire after 15 minutes from admission, releasing capacity with the
explicit `perps_range_expired` failure; an uncursored request can later admit a new
generation after backoff. Expiry also retires abandoned bindings without decoding
them, and cannot overwrite a locked collector. Failed and published generations
are never swept or changed. Timers and queued work stop with the ledger service.

Run `npx tsx src/scripts/ledger-perps-recovery-test.ts`,
`npx tsx src/scripts/ledger-perps-retry-test.ts`, `npm run test:ledger`, and
`npm run build` after changing this lifecycle. The recovery regression admits 128
actual head-wait jobs through the public API, restarts the ledger without owner
polling, and checks startup/timer progress, backoff, expiry and new-owner admission.
Set `INDEXER_TEST_DATABASE_URL` to an isolated loopback PostgreSQL database
to additionally verify independent-connection recovery locks; each run creates and
drops its own schema. The default isolated PGlite run does not qualify those locks.

The first-release range schema requires its generation ordering, persisted backoff
and retry timestamp columns; startup rejects missing metadata. A partial unique
index enforces one active generation per exact scope, and native advisory locks
serialize admission and collection across processes. Display metadata consumes the TEP-64 SnakeData prefix and
omits malformed/NUL text, without changing atomic economics. PostgreSQL failures
report `ledger_storage_unavailable` separately from chain-source failures. Run
`npm run build`, `npm test`, and
`npx tsx src/scripts/ledger-perps-range-test.ts` and
`npx tsx src/scripts/ledger-perps-retry-test.ts` to qualify these changes. The retry
suite additionally supports `INDEXER_TEST_DATABASE_URL` for independent
connection/worker lock tests in an explicitly selected loopback PostgreSQL instance;
it creates and removes an isolated schema.

Masterchain freshness uses authenticated block creation time, never the server clock. Historical lookup brackets backward from the recent head before locating the exact containing block. Intermediate states require original transaction and Account-hash replay using the pinned sandbox. The retained current native fixtures and historical replay tests preserve original evidence; unsupported old layouts are not accepted through compatibility readers.

## Public testnet report regression checks

Run `npm run test:report` after changes to balances, account history or the public API.
Balance reads coalesce concurrent requests by canonical owner, deduplicate roots and
return raw wallet addresses in stable root order. Display precision comes only from
on-chain metadata; missing precision leaves formatted balances unavailable instead
of guessing from a symbol (testnet USDT has 9 decimals). A temporary native balance
source failure returns HTTP 503 with `balance_unavailable`, and the next request can retry.

`/txs` accepts only `page` or the paired `cursor_lt`/`cursor_hash`; unknown parameters
(including `limit` and opaque `cursor`) and mixed pagination modes return 400. The
page size is configured by the service. `/swaps` exposes `minimumReceiveAmount`
separately and never fills `receiveAmount` from a slippage bound or outgoing transfer request.
When durable storage is configured, `/swaps` enriches exact received amounts from
confirmed canonical owner-ledger DLMM credits, with `receipt.ledgerEventId`,
`receipt.generation` and `receipt.assetId`. Matching binds the original owner
transaction and exact transfer body, pool, wallet, debit and credited asset. The
reader scans one complete immutable generation (at most ten 500-event pages);
missing or ambiguous evidence leaves the receipt unavailable. The complete ledger
retains cross-account settlement and coverage details.

Both metrics endpoints require the configured `INDEXER_ADMIN_TOKEN` using
`X-Indexer-Admin-Token` or bearer authorization; they return `metrics_disabled` when
no admin token is configured. Public browser reads remain open.

Application CORS headers are installed before rate limiting and survive application
429/400/415/503 responses. Reverse proxies must also add CORS to their own 429/502/503/504
responses. `config/nginx-indexer.conf` supplies the reviewed public-mount template
with `always` headers, hides duplicate upstream CORS headers and blocks operational
paths from the public listener. Adapt and validate it on the actual edge before
reloading; application tests cannot verify a separately managed proxy.

T3 graph discovery identifies owned mint/burn activity before remote state reads.
The current `vault_routes` getter has exactly 18 fields, including the mandatory
wallet code after the receiver code; the old 17-field getter is unsupported.
Configured recovery bindings must match both code hashes.
A failed redemption-receiver lookup leaves a receiver gap while mint hub/root
identity and settlement discovery continue. Active receiver identity/getter or
custody discovery failures likewise retain the independently verified mint hub,
while publishing an explicit receiver gap and never accepting unverified custody.
Required hub getter failures remain an
explicit T3 gap. The retained public-testnet mint fixture tests discovery with the
original transaction and current identity inputs; it does not certify historical
settlement or replace a live reindex.

Balance snapshots with unavailable configured wallets remain `confirmed:false`
and are not cached, so a later read can immediately recover the missing asset.
An unavailable wallet is never reported as a zero balance or replaced with a stale
balance. `npm run test:report` covers transient balance recovery and the isolated
T3 receiver failures; `npm run test:ledger` covers exact settlement qualification.

The first release supports only DLMM and stableswap. Registry roles use `DexRouter` and `DlmmPoolFactory`; pool discovery accepts only the current DLMM factory protocol. CLMM deployment messages, contract roles, and perps registration hints are unsupported.

Async perps debt conservation uses the exact callback before-market deficit as its
starting balance. Its freshly authenticated callback market supplies execution
price, funding and safety controls only. Accepted insolvent CLOSE execution can
therefore prove the new protocol debt without reporting cash that was never paid.
The `exact-ledger-v21` owner fingerprint and `perps-range-v3` range binding identify
these corrected projections; no older state layout is decoded as a fallback.

The current DLMM liquidity evidence ABI records one original notification per
pending token side. Its mandatory second reference contains two uint256
commitments; only the occupied side is nonzero. Each commitment hashes a cell
containing `DLRF:uint32`, pool address, source pool-wallet address, incoming
`created_lt:uint64`, and the original notification body hash. The exact physical
message graph supplies these fields, so another identical-body contribution
cannot stand in for the original deposit.

The sole current DLRF refund payload is `opcode:uint32`, business query uint64,
notification commitment uint256, replacement predecessor uint64, owner address,
and token-root address. Initial refunds have predecessor zero. Receipt query,
owner, predecessor and token root must match the typed settlement and pool side;
the receipt itself does not prove cash delivery. Older pending/receipt layouts
are rejected. `npm run test:ledger:liquidity` includes strict ABI/adversarial
checks in `ledger-dlmm-refund-state-test.ts` alongside actual current execution
and physical settlement qualification.

The source-wallet settlement queue contains funded work only. A READY record
outside the queue retains its exact token and native liability, has no successor,
and waits for a funded retry; an authenticated action bounce may leave it fully
funded. Active records must remain their source-wallet queue head. Queued READY
records must hold the full delivery plus control budget. The current liquidity
fixtures in `src/scripts/fixtures/dlmm-referral-liquidity-current` preserve raw
transactions and code/byte hashes in `provenance.json`; older captures remain
unchanged and are not selected by these qualification tests.

The current journal products cell has three references: farming, router operations
and durable direct-swap receipts. Each direct receipt binds the complete original
notification and retains every exact transfer body across READY rotations and
authenticated negative-finality replacements. A completed receipt survives active
settlement pruning. Strict decoding verifies live indexes and complete predecessor
chains; cash qualification additionally verifies original requests, failed delivery
and restoration where applicable, and final physical recipient credit. The gas-abort
fixture preserves original transactions and account boundaries without replacing
contract code or token state.

Trading fees from both directions accrue to LPs in T3 after the 83 percent LP
allocation. Fee-only collection with zero X payout does not deploy or require an
X recipient wallet. Discovery follows actual positive pool transfers, while
historical economics and independent wallet finality remain mandatory for payout
qualification. Run `npm run test:ledger:liquidity` for the current arithmetic,
queue admission, recovery, zero-payout and repeated-query cases.

The first-release options ledger recognizes the current writer-backed factory layout only. Writer reserve state is a mandatory series reference; actual market backing, committed allocations, and owner indexes are a mandatory factory accounting reference. A purchase transfers the gross premium, while its collateral value records an allocation of writer backing rather than a buyer cash debit. Refunds return premium only. Funding and writer withdrawals change spendable backing only after authenticated durable custody receipts; a wallet submission or product activation intent is not custody proof.

Current product runtime includes the mandatory authenticated oracle-pull reference and canonical prices. Shout terminal positions retain their exact replayable `SYPT` callback (holder identity, computed payout, zero premium burn) instead of deleting the position. Outperformance uses the sole `SSTL` settlement request and `OPST` callback, retains computed payout, marks the position settled/exercised and releases product notional once. Historical payout projection requires these qualified product transitions and the Factory's IDs-only holder request; the removed supplied-price exercise interface is unsupported.


Physical options ingress evidence uses the current mandatory factory accounting
`ingressReceipts` and `ingressClaimAttempts` dictionaries. The logical business
identity accepts at most one order, while each additional wallet credit has a
separate physical refund identity: H(OCRC, canonical factory wallet, notification
created_lt, full notification body hash). An ingress refund requires that exact
credit, the reciprocal pending claim mapping, actual owner wallet receipt, and
final claim/attempt removal with its physical tombstone retained. Original
purchase abort/bounce attribution also requires the physical absent-to-tombstone
and logical absent-to-accepted historical boundary. Missing fields or old
business-hash claims are unsupported. Run `npm run build` and `npm run test:ledger`
after changing these decoders; the lifecycle suite includes distinct physical
payments with identical business queries and forged-header/journal negatives.


The runtime manifest's `spotMarkets`, `perpsMarkets` and `options` inventories
are independent. Spot pools bind a declared token symbol/root/precision and the
current DLMM template hash, with 9-decimal T3 as quote. Perps entries bind actual
market IDs to those pools, and outperformance templates bind two distinct spot
symbols. Template-only options do not fabricate a series address. The indexer
exposes every explicit spot chart and only registered perps oracle candle keys;
a comparison-only pool therefore has a spot chart without inventing a perps
market. Validate changes with `npm run build`,
`tsx src/scripts/release-manifest-test.ts`, `tsx src/scripts/market-candles-test.ts`,
and `tsx src/scripts/production-smoke-adversarial-test.ts`.

Publication transport smoke checks all declared spot candle endpoints and their
returned canonical pool/root/symbol/precision metadata. Complete zero-trade
history is valid for a fresh comparison pool: the returned array and count must
agree and obey the requested 0–2 candle limit. Nonempty candles must have valid
OHLC/volume data and distinct physical source transaction IDs. This transport
check does not certify oracle readiness or prove actual product transactions; authentic 300/1800/7200 pool windows
remain a separate readiness requirement.


The current options Vault writer reserve includes the mandatory `pendingClaimQueryId:uint64` after cumulative backing returned. Archive decoding retains that exact identity (zero means no active claim) and rejects missing or trailing fields. Factory current `position_info` is a ten-field tuple including the recorded net premium and protocol fee; historical cash qualification continues to read exact archived `OptionBuyMeta.protocolFee` and never substitutes the current getter or current fee configuration.

Historical Factory positions require the complete current `OptionBuyMeta` reference:
refund owner, three uint64 wire IDs, protocol fee, excess jettons, wallet funding,
buy funding, and the uint64 referral operation ID, in that order. Buy funding and
the referral operation ID are mandatory even when zero and are decoded as exact
decimal strings. Missing, truncated, or trailing metadata is rejected; there is
no older-layout fallback. `npm run test:ledger` includes the strict position-state
codec checks and current-layout purchase, exercise, refund, abort, and bounce
projection tests.

DLMM deposit projection treats a business query as a reusable pending slot. Each
applying transaction selects its earlier contribution through the exact archived
notification commitment, then verifies both original physical payments and the
mint transition before joining their movements. Missing archives leave separate
unresolved contributions; they cannot absorb another completed deposit.
`npm run test:ledger:liquidity` includes the byte-identical compressed Sandbox
repeated-query fixture and tests reversed input, partial reuse, missing archives
and missing original contributions. Set `DLMM_DEPOSIT_IDENTITY_EVIDENCE_OUT` to
write its check results and exact projected events to a local directory.

The first-release owner swap settlement includes mandatory `dlmmSwap` economics
when qualified: paid input, consumed input, returned input and output, bound to
the exact input/output/refund movement IDs and pool finalization transactions.
Its required `poolCodeHash` identifies the code authenticated at those historical
boundaries; consumers compare it with the code pinned in the reviewed request.
A fully refunded request has zero consumed input and no output movement. The
account swaps API keeps `requestedPayAmount` separate from actual `payAmount`
(consumed input) and `returnedPayAmount`. Actual amounts require the qualified
ledger; unavailable archives do not publish requested input as spending. A full
refund publishes zero input consumption and its return, without an output receipt.
`npm run test:ledger:market` includes original Sandbox full, partial and first-swap
refund fixtures plus public receipt-consumer regressions. Set
`DLMM_SWAP_EVIDENCE_OUT` to write projected operations and check results locally.

Current-source DLMM qualification requires the exact 608-bit guard containing
reserve high-water and oracle-depth continuity, the fourth cumulative observation
dictionary, mandatory products/provenance cells, and current wallet dictionaries.
Direct swaps are zero-fee. Their allocation proof reserves 0.3 TON for processing
before funding any output/refund journal. Fee-bearing execution uses the qualified
router and the exact RSWI/RPSX/RPSC/RPCA chain; fee accrual is separate from the
trader's physical output and any unused-input refund. Router history uses only
RTR1, extras version 5 and the committed RSJ8 journal layout; missing or obsolete
state remains unresolved. Current fixtures under
`src/scripts/fixtures/dlmm-referral-{market,liquidity}-current` are regenerated
from original canonical-v15 executions, including full router/referral custody
for LP fees. Run `npm run test:ledger:market`, `npm run test:ledger:liquidity` and
`npm run test:ledger` after changing these proofs.

Launchpad first-release storage uses one shared settlement journal across fixed,
bonding and auction sales. The current decoder requires the activation bit,
settlement native-refund owner, null referral registry and zero module key.
CNTR/PBID retain their explicit nullable referral reference; a non-null inviter
cannot establish participation. Protocol fees use only the current RFFL outbox
and physical FeeRouter custody, with zero TS rewards. The old CRED body and
obsolete storage layouts are rejected. `accounting-pending` records do not
certify a completed fee allocation. Participation proofs require unchanged
settlement state because fees can be routed only after positive purchased-token
finality. Fixed/Bonding refunds cancel accrued fees; Auction bids have zero
accrued fees until a successful claim. The current fixtures include original
ShardAccount inputs/outputs matched to raw VM transaction state hashes, exact
compiler/import/runtime provenance, and actual failed nonzero-referral
configuration and inviter-refund graphs. Run `npm run test:ledger:launchpad`.

Perps referral-release qualification uses only the current wallet storage, including
both permanent mint and funding-notification dictionaries. The current OPEN/CLOSE
range fixtures and oracle execution fixtures are in
`src/scripts/fixtures/perps-referral-current` and
`src/scripts/fixtures/perps-referral-oracle-current`. They retain original raw
transaction cells and exact historical storage boundaries; older captures remain
unchanged and cannot enable a compatibility decoder. Run `npm run test:ledger`
for chain identity, oracle admission, funding, payout, retry and range coverage.

Current jetton wallet identity and settlement readers share the strict `readT3RecoveryWallet` decoder for the tagged three-reference `JTW1` tree, including the fixed 793-bit workchain/hash identity tuple and mandatory mint receipts and referral notifications in the bounded journals cell. Absent delegates require zero fixed fields; flat roots, noncanonical coin widths and omitted-dictionary layouts are rejected. Run `npm run build` and `npm run test:ledger` after changing it. The range identity test uses explicitly qualified current-source sandbox OPEN/CLOSE transactions; the earlier testnet capture remains unchanged and is exercised only as an obsolete-layout rejection. Fixture provenance records the pure-build target closures, reviewed capture maps and original artifact hashes.

Current perps journal qualification uses a 128-record eligibility index. The exact count, unique wire ids, protected paid orders and receipt/index bijection are verified by the sole current state reader. Run `npm run test:ledger` for actual engine callback, settlement and current-source range fixtures.


### Verified testnet perps admission runtime

A registered PerpsEngine requires the qualified native admission worker on macOS arm64, testnet, and the exact engine code hash. Set `PERPS_ADMISSION_BINARY_PATH`, `PERPS_ADMISSION_BINARY_SHA256`, `PERPS_ADMISSION_CONFIG_PATH`, and `PERPS_ADMISSION_CONFIG_SHA256` to the immutable reviewed native package. The package carries the native binary, its official TON source/toolchain provenance, and the exact global configuration with its retained trust anchor. All four values are mandatory together. There is no generic container deployment in this release; the host must provide the reviewed native package.

The HTTP listener opens before native authentication. The pool owns at most two persistent worker processes. HTTP readiness starts as soon as one live worker authenticates the signature chain and a fresh exact-block engine account; a slow or failed sibling does not discard that authenticated capacity. Cold workers cannot receive requests, and failure of both startup attempts remains unavailable. Cold bootstrap refreshes a fully authenticated but past-stale readiness snapshot by requesting a new verified sync, exact header and exact account. At most three startup rounds share the transport/freshness retry budget; future or inconsistent clocks, invalid proofs and wrong identity/code fail immediately. The 30-second proof-age and three-second future-skew checks remain strict. Private native diagnostics record authenticated master/shard ages. Cold bootstrap has a 600-second total deadline and a 120-second validated-progress stall deadline; the parent allows 610 seconds for process startup and cleanup. Deployment health gates must allow at least this cold-start interval. Each admission request has one attempt, a five-second timeout, a fixed one-million TVM gas maximum, and complete authenticated account/configuration/context binding. Busy workers return `admission_busy`; unavailable, timeout, proof, context and worker failures retain distinct safe API codes. Economic denial, VM failure and exhausted gas retain their actual getter result and gas usage. Admission requests never use generic remote-getter fallback or response caching.

After worker loss, the pool keeps authenticating replacements with exponential backoff capped at 60 seconds; repeated startup failures do not permanently exhaust recovery. When no authenticated worker remains, admission stays unavailable until a replacement authenticates. Failed requests are never replayed. Shutdown cancels pending replacement attempts and reaps owned workers. Run `npm run test:admission` for the supervisor lifecycle and API regressions.

Each owned worker emits one private operator record when its process closes. It
retains the original failure origin and phase, exact close code/signal, parent
kill intent, readiness/timing and request/output counters. Only the last 4 KiB
of stderr are retained and rendered as bounded printable ASCII; stdout contains
proofs and payloads and supplies counters only. Expected shutdown and 128-job
retirement use informational records; failures use warnings. Diagnostic sink
errors cannot interfere with rejection, process reaping or replacement. Public
admission error codes and messages remain fixed. The existing lifetime 1 MiB
stderr termination guard is unchanged and separate from diagnostic retention;
authentication, deadlines, resource limits and one-attempt execution are unchanged.
The admission suite covers original failure preservation, exact exit status,
stderr boundaries, same-chunk protocol failures and throwing diagnostic sinks.

The retained historical Perps economic fixtures use the isolated LP counterparty model. Returned trader margin stays separate from an `RVPS` profit claim against that position's actual reserved capital. The independent integer verifier checks ceiling reserve allocation, signed floor PnL, capped funding and profit, exact predecessor/hash/beneficiary binding, and collected-loss journal growth. It rejects pooled profit credits, changes to another trader's cash, old fractional ADL, and obsolete funding-transfer layouts. A verified claim is not evidence of completed token delivery; wallet and RiskVault finalizers remain separate physical facts. Those earlier ABI fixtures are retained as historical evidence. The fresh PxStorage release is qualified by `npm run test:ledger:perps`, followed by the complete `npm run test:ledger`.

The current engine extras also retain future market risk-policy commitments as
an exact uint32-to-referenced-cell dictionary after the collectors and T3
references. The state decoder exposes `pendingRiskPolicies` separately from
registered market leases. Only absent slots 2-4 may hold the native unissued,
blocked commitment: no epoch, expiry or gross credit has been granted. Dictionary
completeness, every commitment field and registered-market exclusion are checked.
`npx tsx src/scripts/perps-oracle-state-test.ts` covers current-source state with
future bindings and rejects malformed, pruned, tampered and trailing layouts;
it also retains the original testnet state that exposed the pending-policy
failure. That live observation tests schema decoding, not historical transaction
or replay qualification. Run `npm run test:ledger` and `npm run build` after
changing this decoder.

The current oracle journal distinguishes an ordinary CLOSE's empty context, a
MODIFY's complete prior position, and a managed CLOSE or funding claim's exact
position commitment plus native sponsor. Pending kind and terminal reason have
different meanings. The decoder preserves the original context across the
callback and checks an accepted managed exit against its actual prior position;
Mesh refunds must name job 405 and the configured control return collector.
The oracle-state regression includes an authenticated current native maintenance
capture and rejects substituted position commitments, sponsors and trailing
fields. These bindings identify the operation and do not prove wallet delivery.
An ordinary owner full CLOSE may replace a pending maintenance CLOSE, including
with the same business query ID, only under the native supersession conditions
and with a new wire nonce. Other paid pending orders remain protected.
This exception has a synthetic indexer boundary regression using an unchanged
ordinary-CLOSE wire, plus the existing native supersession test; it is not an
actual captured supersession ledger graph.

A fresh direct-owner `CFNG` funding claim executes at its authenticated oracle
callback. Intake queues the claim and preserves the position commitment; it does
not establish settled funding. The stored native sponsor must retain the intake
transaction's logical time, direct refund kind 0, module 0 and owner refund
address, with the same context through the callback. An existing pending funding
transfer follows the contract's direct retry branch and keeps its original
settlement journal. Fee allocation, trader-margin returns and LP-funded profit
delivery require their separate custody evidence. As of 2026-09-27, the decoder
and continuation changes pass the targeted oracle-execution integration against
the authenticated final15 native captures, including accepted and rejected
funding claims and an exhausted-reserve close. The 53-test native risk producer
and independent compilation bind those captures to source closure `c93e4a60...`
and Engine `d3a74ae2...`. The targeted log is
`../output/first-testnet/generation-20260925-g33/preparation/indexer-claim-integration-final15-01.log`.
All six final15 producers now pass at counts 53/7/32/5/1/1. The canonical risk
fixtures contain all 11 authenticated cases, and the browser and funded exports
bind the exact current 234-file indexer source inventory. The complete indexer
`npm test` (including pretest and all 47 ledger scripts), indexer and web
typechecks, 592 Perps unit tests and 13 browser scenarios pass. A post-package
check revalidates all six native receipts, both projector inventories and output
hashes. The receipt is
`../output/first-testnet/generation-20260925-g33/preparation/perps-current-precheck-final15.json`.
Frozen whole-release qualification and testnet deployment remain pending.

The current bounded Perps range graph discovers complete engine-emitted RVLT/RVPS, RPRQ and referral requests, including RiskVault and fee-router T3 custody. It captures every peer at the original masterchain snapshot and qualifies active wallets against the engine-pinned root and wallet code. Discovery is bounded to 32 protocol peers plus their wallets and shares the existing 128-page work budget; it never substitutes a latest-head account read. Physical profit delivery still requires the separate exact RiskVault journal, beneficiary credit, wallet finality and engine hook. Run `npx tsx src/scripts/ledger-perps-range-test.ts` and `npm run test:ledger` after changes.

Current funded managed messages use the strict `CNFW` envelope and full TVM12+
RichBounce. Token semantics decode its one business reference, while physical
message matching and evidence hashes retain the entire original outer body,
including payer metadata. A native context or correlation label is routing data,
never token settlement authority. Malformed/nested envelopes and prefix-only
bounces do not qualify. `npm run test:ledger:native-funding` checks unchanged
original compiled Sandbox transaction BOCs, exact native balance conservation,
actual full bounce decoding and physical token edges. These captures do not
substitute for deployment-qualified historical state or live-chain evidence.

The current RiskVault payout journal contains the explicit native escrow reference
before its route reference. Its containing journal has the mandatory funded ready FIFO (`head:uint64 tail:uint64 entries:dict64→256`); missing, noncontiguous or dangling queue entries are rejected. Omitted historical layouts are unsupported. Run
`npm run test:ledger:native-funding` for original compiled wallet and RiskVault
captures, including all seven RiskVault graph account balance boundaries. Current
Mesh snapshots require exactly37 getter fields; no13/31/57-field fallback is accepted.

Launchpad bonding participation verification uses the current cumulative linear
curve cost `C(s + q) - C(s)`, including the contract's upward rounding, and checks
that the accepted quantity is maximal for the physical payment. Spot price alone
does not establish a fill. Every confirmed bonding entitlement carries the
mandatory `curve` evidence: linear `curveKind: 1`, base price, slope numerator
and denominator, maximum supply, global sold before and after, and the actual
post-fill marginal price. The values come from the same authenticated archives
as the participant delta; participant balances cannot replace global supply.
Run `npm run test:ledger:launchpad` to verify all three
current model captures and their independent wallet/state evidence.
# Historical Perps fixture qualification

This section records the retained earlier ABI producer and its evidence format.
It does not qualify the fresh PxStorage release or supply its current commands.
The current source-locked 18-test/66-capture qualification is described below.

Perps ledger fixtures preserve original local VM transactions and account state
commitments; they are not evidence of a live testnet deployment. Capture through
`npm run capture -- <risk|wallets|browser|directFee|funding|factory> <new-absolute-directory>`
in the native contract repository. The indexer's `capture-perps-fixture.ts` delegates
to that pure-build producer. Capture directories and their complete logs are
persistent evidence and must never be recycled as build caches.

Each `tonswap-capture-producer-v1` receipt binds the complete passing suite log,
artifact bytes, compiled Cell hashes and a `tonswap-capture-build-v1` binding.
Current recorded runtime fields are Node v22.23.3, Tolk 1.4.2 and Sandbox 0.42.0.
The native capture launcher preserves the reviewed `--no-turbo-fast-api-calls`
flag in the actual Jest child; invoke Node directly with that flag, rather than
placing it in `NODE_OPTIONS`, which Node rejects.
`fixtures/capture-build/manifest.json` retains the reviewed pure build manifest,
and its producer subdirectories retain independently reviewed capture maps and all
selected compiled artifacts. Original compiler BOCs live under `artifacts/`; their
byte hashes are checked separately from captured Cell hashes. Verifiers
authenticate the manifest, each executed or embedded target's exact import closure
against current native sources, and original captured code. Unrelated targets do
not invalidate a producer. Generated opcode inputs are independently rendered
from `config/opcodes.json`; no native release helpers or ambient TypeScript
modules are executed. These receipts do not claim historical producer TypeScript
source locks or Node executable attestations.

The risk, range, funding and direct-fee adopters require complete receipts and
write `qualified-pure-build-target-closure` provenance. Range adoption checks both
risk and wallet bindings. Retain the matching manifest, reviewed producer binding, original compiler BOCs
and every selected `current-compiled` artifact when adopting a new capture; changing a retained
manifest requires reviewing all affected consumers. The verifiers work without
private staging directories or transient native build output. There is no
provisional bypass. The factory retains all nine compiler pins and independently
checks their individual closures, separately from its three observed execution
targets. Only the known Sandbox treasury and exact factory negative-code cases
can occur outside compiled targets.

The adopted transaction BOCs, state commitments and historical rejection inputs
remain unchanged. Risk, wallet and funding captures require their exact VM15
400-nanoton/gas stress configuration. Fixture provisioning costs and separate
observed-price measurements are not stress-cost evidence. Direct fees create no
automatic referral earnings. Adopters update indexer fixtures only; they do not
rewrite native release evidence.

`refresh-perps-direct-fee-web-fixture.ts` exports physical FeeRouter custody from
a complete direct-fee producer. After risk adoption,
`refresh-perps-funded-web-fixture.ts <new-absolute-projection-directory>` projects
the original operation traces and retains the receipt and projector logs.
`export-perps-browser-evidence.ts <absolute-browser-producer> <new-absolute-projection-directory>`
requires the complete five-test producer and strict projection of all five graphs.
These exports preserve native custody and indexer source checks.

Run `npm run test:capture-build`, `npm run test:ledger` and the complete `npm test`
after adoption. Truncated logs, stale target closures, omitted compiled roles,
rehashed substitutions, coordinated target omissions and altered original artifacts
must be rejected.

Current routed market evidence includes `routing.directFeeSettlement` for the
physical Router-to-FeeRouter wallet delivery, separately from the Pool-to-Router
protocol fee leg. A same-wallet beneficiary payout is tied to the fee finalizer
that advances the Router's source queue. Verify this path with
`npm run test:ledger:market`; `npm run test:ledger:liquidity` also checks the
current Pool protection mask and rejection of obsolete metadata.


## Platform service

The optional notification, public price and historical FX service is maintained in
[`services/platform`](services/platform/README.md). It has its own dependencies,
configuration and build. From that directory, run `npm ci` and `npm run verify`;
follow its README for database migrations and API/worker deployment. The indexer
build and runtime remain separate from this service.

Current Options and faucet physical evidence use `POST /api/indexer/v1/options/operation-evidence`
and `POST /api/indexer/v1/faucet/operation-evidence`. Each exact request names its
original owner TON wallet dispatch LT/hash and emitted value. The endpoint binds
that outgoing message to the actual target execution, current manifest code pins,
complete product/token-wallet histories and subsequent physical message links.
The returned original transaction and before/after ShardAccount BOCs let clients
independently verify acceptance, custody and actual token delivery. Query IDs,
receipt events, current balances and a successful dispatch alone do not prove payment.

Options accepts current buy/fund TEP74 intents, writer OSWW, factory FEXC/OFEX,
and slot0 CLMJ owed claims. Payout `queryId` names the original purchase escrow;
the OFEX exercise body carries its own query. Owed requests use `seriesId: "0"`
and null series/sourceWallet/notionalRaw/tokenId. Faucet accepts exact FCLM with
asset0 T3, asset1 USDT or asset2 TS; the grant and allocated wire come from the
original faucet execution rather than request-supplied amounts. `createdAt`
retains the local request timestamp in milliseconds. Dispatch value matches the
original wire and may be below the saved send budget after wallet fees.

Both routes share the live evidence gate and deadlines. Limits are 16 accounts,
256 aggregate history/returned transactions, 64 new archive boundaries, 1024
message edges and 8 MiB. Product/source/recipient token histories must reach
initialization; causal GRAM-return accounts need their uninterrupted current-to-
dispatch interval. Any missing history, unmatched message or exceeded limit gives
explicit incomplete coverage. No completed response cache is used. Run
`npm run test:current-product-evidence`; the capture commands accept original
native capture paths and an optional fresh absolute evidence-output path.

Current recovery discovery uses `POST /api/indexer/v1/options/wallet-claim-evidence`
with the same saved Options operation request. It returns the canonical vault T3
wallet and current sparse claim/failure witnesses only after full wallet history
and the original request's causal vault debit authenticate. Each selected record
retains its original `transferTransaction`; retries preserve recipient and all
immutable terms. Mark a journal-backed unmarked failure and resolve that operation
before retrying. The shared work limits remain explicit incomplete coverage.

`POST /api/indexer/v1/faucet/recovery-evidence` accepts the saved faucet claim and
returns current holder receipt membership or absence, original faucet/source
accounts and exact source/target failure descriptors. The direct refusal branch
uses the same positive source and target transaction; a lost holder bounce uses
the later faucet transaction. These proofs concern inventory and cooldown
recovery. A separate physical grant graph establishes receipt of tokens. Native
certificate sessions additionally require authenticated original chain anchors;
fixture proofs and synthetic sandbox heads cannot provide that authority.


`POST /api/indexer/v1/t3/faucet-proof-session` accepts the exact original T3 faucet
claim, immutable nonce, installed proof-code BOC and optional retained full
masterchain anchor. It returns authenticated account/shard/masterchain proof
cells for one bounded native verifier step, at most four original transactions,
and an explicit current `asOf` distinct from the immutable session `anchor`.
Long histories resume from the on-chain cursor. The endpoint shares the live
request gate, 192 KiB request/8 MiB response limits and exact release header;
it never submits a transaction. Run `npm run test:current-faucet-proof-session`.

`POST /api/indexer/v1/launchpad/operation-evidence` accepts current creation,
contribution/supply, sale, LP, vesting and owed-claim bodies with the exact owner
TON wallet dispatch. Current factory code pins derive canonical children;
reviewed asset entries must match installed token/code families. Original linked
transactions retain every causal creator, fee, LP and vesting leg within the
shared product bounds. `GET /api/indexer/v1/launchpad/sales` requires the installed
`factory` and `limit` from 1 to 50; optional `cursorLt` and `cursorHash` must appear
together. The inclusive cursor names the next original factory transaction.
Complete coverage means this scanned page has no gaps; only a verified history
end returns null `nextCursor`. Browser verification independently checks executed
creation announcements and canonical child state. Run
`npm run test:current-launchpad-evidence` and the original native capture checks.

`POST /api/indexer/v1/pools/operation-evidence` accepts current one-bin liquidity
adds, farm creation/actions, bounded removal and owed claims. Its original owner
dispatch and release pool identity bind the physical graph. The same saved
request at `/api/indexer/v1/pools/wallet-claim-evidence` selects only causal failed
pool-owned T3 attempts, retaining original recipient and current sparse witnesses.
Either requested side is supported because an operation may produce both assets.
Membership is recovery authority; actual recipient credit still requires the
independent operation graph. Both endpoints preserve explicit bounds and gaps.

`POST /api/indexer/v1/launchpad/token-evidence` accepts the original creator mint
and StateInit with its resolved owner TON wallet dispatch. The installed V21
minter/wallet pair, canonical initial root and same-head wallet getter restrict
the complete original root/wallet histories and causal mint graph. The browser
independently checks actual initial credit or an exact bounced supply reversal.
The endpoint shares product work/byte limits, release header and no-cache policy.
Run `npm run test:current-launchpad-token` and original native capture checks.

`POST /api/indexer/v1/perps/operation-evidence` accepts current open, increase,
margin, close and funding requests with the exact owner TON dispatch. The current
engine/RiskVault layouts, installed peers/market pools and canonical T3 wallets
bind complete product histories and original message links. Explicit recipient
intervals retain later retry credits from the same current head.
`POST /api/indexer/v1/perps/wallet-claim-evidence` uses the same saved request and
returns at most three server-derived engine, RiskVault and owner wallet groups.
Each sparse proof retains its original causal debit and immutable transfer terms;
aggregate limits are 10,000 history rows, 32 records, 32 failures and 8 MiB.
This evidence does not qualify public deployment or missing history. Run
`npm run test:current-perps-evidence` and original native execution/recovery checks.

`POST /api/indexer/v1/wallet/transfers/evidence` binds a manifest token transfer to
its original owner dispatch and canonical sender/recipient wallets. It returns
original account boundaries and complete current-to-dispatch intervals within
the shared product limits. Browser verification independently proves the debit
and credit; an accepted transfer command is insufficient.

Public project-token reads authenticate the original current master and exact
`get_jetton_data` at one head. Only the installed `JettonV21Minter`/
`JettonV21Wallet` pair or the separate stablecoin minter/wallet pair is accepted.
Known manifest roots retain their exact pair and precision. Explicit bounded
on-chain decimals are required; remote metadata and implicit precision do not
authorize token funding. The TS master must match the mandatory V21 minter pin.
Run `npm run test:current-project-token` and `npm run test:runtime-manifest`.

Current Launchpad archive discovery uses `POST /api/indexer/v1/launchpad/owed-archive-evidence` with the exact release and canonical sale identity, owner and slot. Only the current Sale contract implements CLMA. The collector reconstructs every original archive append and consumption through genesis-linked history, verifies current root/count/total/frontier and `get_owed_archive`, then returns unconsumed owner witnesses and original append transactions. The shared live gate remains20 seconds. Large histories progress through request-driven slices of at most64 newly verified boundaries and8 seconds of slice work. Until genesis and all transitions are verified, the endpoint returns retryable503, with no partial archive or ready witness. Retrying the same request resumes durable immutable boundary facts; current account/getter reads are always performed at the new exact head. Release/decoder identity, original transaction hashes and before/after account hashes isolate reuse across restarts, concurrent requests, advancing anchors and forks. The owning release schema retains checkpoints linked by foreign key to their original evidence; there is no background reconstruction loop or completed current-result cache. Coverage stays incomplete on a missing transition, more than32 candidates,10000 history rows or8MiB. Run `npm run test:current-launchpad-owed-archive`; native capture checks take absolute complete/request directories and a new durable output path via `test:current-launchpad-owed-archive:capture`. A witness does not prove physical payout.


Archive persistence and orchestration checks use the canonical SQL through
`npm run test:current-launchpad-owed-archive`. The overflow capture runner
`npm run test:current-launchpad-owed-overflow:capture -- <absolute-model-directory> <new-absolute-output.json>`
executes every request through the unchanged20-second gate and reopens an
append-only checkpoint journal next to the output between requests. It qualifies
original native append/consume/append-after-consumption under a synthetic source
and head, independently of PostgreSQL persistence checks; it is not public chain
or deployment qualification. Preserve the output and complete journal together.
Current Perps manifest bindings carry exact engine, RiskVault, proof and market
identities into the ledger. Each product uses its qualified current decoder and
refuses missing original evidence independently.

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

Confirmed current Perps operations recognize the PX, oracle, RiskVault and T3
custody message vocabulary when removing generic undecoded warnings. Original
transaction/state/economics and physical cash checks still establish settlement;
unknown grouped messages retain the warnings. The retained current native Perps
suite checks both cases. The bounded-range retry test also requires explicit
completion and releases held collectors before closing its pool, so abandoned
cleanup cannot silently exit successfully.

### Current lifecycle observations

`npm run test:ledger:protocol` verifies exact current event layouts and retained
native default/x6 producers. Owner ledger events may carry `protocolObservations`:
release-pinned Governance/supply/holder/platform facts and pool/coordinator events,
with their original transaction, body/code hashes and authenticated causal chain.
Successful calls and logged amounts never create cash movements, establish target
execution or clear incomplete settlement. These are partial observations, not an
exhaustive event feed or burned/minted supply audit.

Discovery follows only owner-connected messages into supported release identities.
Unrelated shared-contract history does not consume the 64-original boundary budget
or introduce unrelated financial dependencies. Each observation requires original
active code on both sides and unique full-message ancestry, with at most 16 ancestor
hops, 64 facts per transaction and 256 facts per projection. Missing authority omits
the observation; financial history and physical transfer qualification stay separate.
The retained producer map and its limits are in
`src/scripts/fixtures/current-protocol/README.md`.

Current Order funding may reach its canonical token wallet before the separate
order child initializes. The decoder still requires original owner CREATE and
funding messages, canonical initialization and all physical delivery boundaries.
Run `npx tsx src/scripts/ledger-current-dlmm-order-delayed-init-test.ts` for the
eight source-bound normal/x6 batch-scheduling and missing-original regressions.

Paired T3 operation evidence retains both exact collateral transfers and their
resolved original source-wallet dispatches. Reserve swaps retain the selected
output and positive minimum. Each provided first hop must link to the full
original owner message. A null basket dispatch denotes an unresolved or unsent
leg, never absence of cash; the client separately verifies wallet closure before
retiring it. All legs share one head and the existing aggregate history/response
bounds. Run `npx tsx src/scripts/current-t3-basket-evidence-test.ts` for source-bound
normal/x6 original collectors, request pins and missing-evidence refusals.

The basket collector gate is
`npx tsx src/scripts/current-t3-basket-evidence-test.ts`; its checked-in portable
package verifies the complete original producer/source/59-target build closure
before all eight default/x6 collector cases. Run
`npx tsx src/scripts/current-t3-operation-request-test.ts`,
`npx tsx src/scripts/runtime-t3-binding-test.ts`,
`npx tsx src/scripts/current-release-routes-test.ts` and `npx tsc --noEmit` as well.
The narrow optional KUSD cold-wallet case requires zero backing, pending and all
owed liabilities. Missing or impaired wallet state never becomes a zero balance.

The ordinary, current-release and current-T3 evidence gates include the portable
paired-mint and reserve-swap collector corpus. Numeric logger recovery tests retain
owned filler descriptors so unrelated runtime closes cannot change the tested
descriptor identity. Run `npx tsx src/scripts/logger-enospc-test.ts` after changes.

Current whole-order evidence requires `creations`, the exact 1–256 unique factory
first-hop cursors with original OCRT body and value for every retained create,
repair and expired recovery request. The collector walks through the successful
initialization and every selected factory attempt, retaining rejected/duplicate
originals and pre-initialization child history. Missing originals are incomplete,
never inferred rejection or successful refund. The normal current Spot/order
gates run `current-order-expired-evidence-test.ts`: all eight source-bound native
expiry cases at default/x6, both sides and both possible initialization winners.
The retained original sandbox bytes and synthetic read adapter do not qualify
public consensus or authorize deployment.
