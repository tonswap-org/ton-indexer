# ton-indexer
Indexer for faster/more reliable data from TON.

This repo now contains a minimal TypeScript service that follows the design in `roadmap.md` and exposes the v1 API.

## Requirements
- Node.js 18+

## Setup
```bash
npm install
```

## Run (dev)
Default dev now runs on testnet with the lite client enabled.
```bash
npm run dev
```

Run dev on mainnet (lite client):
```bash
npm run dev:mainnet
```

Run against a local TON network:
```bash
LITESERVER_POOL_LOCALNET=../tonswap_tolk/tmp_mylocalton/global.config.json \
INDEXER_REGISTRY_PATH=../tonswap_tolk/tmp_release/localnet.registry.json \
INDEXER_RELEASE_MANIFEST_PATH=../tonswap_tolk/tmp_release/localnet.manifest.json \
npm run dev:localnet
```
Localnet never falls back to a public TON endpoint: the lite datasource requires
`LITESERVER_POOL_LOCALNET`, while the HTTP datasource requires
`TON_HTTP_ENDPOINT`.

## Build + Run
```bash
npm run build
npm run test:historical-replay
npm run start
```

## Test
```bash
npm test
npm run build
```

The regression suite covers transaction-chain continuity, reorg replacement,
snapshot integrity, datasource fallbacks, classifier decoding, and public API
validation/streaming behavior.

## Durable account ledger

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
Do not publish the connection URL in the frontend bundle. The container includes
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
decoder `exact-ledger-v15` fingerprint, and preserved by older cursors. A scope
change creates a new generation even when both generations have no events.
This describes represented accounts; it does not certify discovery of every
owned asset or complete history. Published projections with explicit history or
decoding gaps retain their actual scope and available events. Unpublished runs
return a null scope and no events. Missing or invalid published scope metadata
also suppresses events and cursors, sets completeness flags false, and reports
`owner_projection_metadata_invalid`; consumers must not substitute the owner as
an inferred scope.

Two workers run concurrently. `LEDGER_MAX_WATCHED_ACCOUNTS` defaults to 1,000
(maximum 100,000); admission overflow returns `watch_capacity_reached` and creates
no watch/account row. `LEDGER_MAX_PAGES_PER_SYNC` defaults to 20 (maximum 100),
shared across the owner and its related-account crawl; each page has at most 100
transactions. Exhausted budgets persist the next exact cursor with
`backfill_capacity_deferred`, then resume the same run on a later pass. No old
transactions are discarded. The fair scheduler revisits only explicitly admitted
owners, ordered by last attempt. `LEDGER_MAX_RELATED_ACCOUNTS` defaults to 256
(maximum 1,024); discovery overflow is an explicit coverage gap. Operators must
set these admission/crawl limits for their upstream and PostgreSQL capacity.

Configured jetton roots and observed transfers/notifications identify controlled
wallets. Root/wallet getters, owner identity, and active wallet code are verified.
A never-deployed wallet is empty only when the root getter and an explicit
uninitialized, history-free account state agree. Observed counterpart wallets and
registered DLMM pools are crawled too. `coverage.relatedAccounts` records each
account, physical generation, role and chain coverage. This discovery scope does
not enumerate arbitrary unconfigured tokens that never notify the owner.

Quiet polling compares the decoded projection and complete dependency evidence
(including identities, related generations, projection scope, coverage and decoder version) before
creating a generation. Unchanged evidence reuses the published snapshot without
copying memberships or events. A changed custody-wallet head still creates a new
projection even when the owner head is unchanged. `generation`, `publishedAt`,
and `headObservedAt` identify the immutable snapshot. `checkedAt` records the
conservative head-observation time of its latest full dependency recheck;
`publishedAt`/`syncedAt` are publication times and must not be used as chain
watermarks. Consumers pin `checkedAt` from the root page while paging that
generation. Later root polling can advance it after unchanged dependencies have
been checked again. Failed backfills do not mutate already-published evidence.

All amounts are unsigned atomic decimal **strings** with an explicit `in`, `out`
or `fee` direction. Native assets use `<network>:native` and nine decimals;
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
outgoing forwarding/IHR fees. `totalFeesRaw` aggregates transaction fees already
represented by `transaction_fee` movements; **never add it again**. Forwarding/IHR
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
The `exact-ledger-v15` projection fingerprint forces fresh decoder generations
on recheck, including quiet accounts, while preserving previous cursor snapshots.
Run `npx tsx src/scripts/ledger-test.ts` for persisted decoder invalidation.

### Historical market execution ledger

`LEDGER_MARKET_BINDINGS_JSON` enables a separate durable DLMM market projection.
Supply a JSON array whose entries have exactly `network`, `pool`, `poolCodeHash`,
`walletCodeHash`, `tokenT`, `tokenX`, `tokenTCodeHash`, and `tokenXCodeHash`.
Addresses must use canonical raw TON
form; code hashes must be deployment-qualified lowercase 64-character Cell
hashes. The network must match `TON_NETWORK`. Empty/unset means no qualified
historical markets. Never copy a live RPC code hash into this allowlist merely
because an address appears in a registry.

Use `INDEXER_DATABASE_URL` and the existing ledger database initialization. The
canonical `sql/ledger.sql` also creates independent `market_heads`,
`market_generations`, `market_observations`, `market_candidates`, and
`market_root_archive_states` tables.
Configured pools refresh through the durable account backfill every 30 seconds;
work is serialized locally, coordinated by a PostgreSQL advisory lock, and
published with an expected-generation fence. `LEDGER_MAX_RELATED_ACCOUNTS` and
`LEDGER_MAX_PAGES_PER_SYNC` bound each pass. Missing archives, incomplete backfill,
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
The owner decoder fingerprint is `exact-ledger-v15`; the separate market schema
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
minimum is substituted. This requires an archive-capable HTTP4/lite source and
does not claim every historic LP event can be resolved by all providers.

Option purchases use the configured `OptionFactory`, its collateral root and
registered shout/outperformance series code. Proof follows the original owner's
exact jetton funding query into the factory, its unique assigned position and
wire ID, and the delivered factory-to-series activation plus consumed series ACK.
The immutable position hash binds owner, series, position, notional, net premium,
collateral and wire ID. Exact factory state before and after the original activation
ACK must preserve those values and prove the transition to ACTIVE without
abort/cancel/refund flags. Current position getters cannot prove this historical
acquisition. A reservation, global notional change or ACK alone never confirms
ownership. All contributing account chains must be complete. Historical position
fields, data/code hashes, block boundaries and physical transaction evidence remain
in the export.

Confirmed `kind: option_buy` events have `settlement.protocol: options` and
`operation: option_buy`, the original query ID, canonical factory/series addresses,
series/position/wire IDs, position hash and exact notional/net premium/collateral/
protocol fee amounts. The acquired internal right uses `kind: option_position`,
ID `<network>:option-position:<factory>:<seriesId>:<positionId>`, owner and zero
decimals, with one unit. Funding is split exactly into `option_premium`,
`option_collateral`, `protocol_fee` and any `option_excess` movements; their sum
is the actual debit. Excess refund attribution remains explicit and unresolved.
This proves purchase activation, not a cash-equivalent asset valuation, taxation,
or a later exercise, settlement, payout, cancellation or refund.

SCCP asset bindings are explicit backend release inputs. Set
`LEDGER_SCCP_ASSETS_JSON` to a JSON array (at most 16 entries), each containing
`network` (`mainnet`, `testnet`, or `localnet`), canonical `master`,
`masterCodeHash` (lowercase 32-byte hex), and `soraAssetId` (lowercase
`0x`-prefixed 32-byte hex). To attribute inbound TON mints, also pin `verifier`
and `verifierCodeHash` together. There are no default bridge masters or symbol
mappings. Invalid, duplicate, cross-network, or partial bindings fail startup.
The master and verifier must have the pinned active code and the master getter
must expose the exact bound asset ID. Bound wallets are discovered even when an
incoming mint sends no owner notification. Their master/verifier histories use
the same bounded, resumable durable crawl and explicit incomplete coverage.

SCCP `bridge_burn` proves a delivered authenticated owner→wallet→master burn,
its unique master-owned nonce/message ID, and an exact stored burn record.
The message ID is independently recomputed from canonical SCALE bytes using
Keccak-256; quantity, root, initiator, destination, recipient and nonce all bind.
The existing burn-status endpoint and ledger share the strict burn notification
and record parsers. A wallet request, global supply delta, or receipt alone cannot
certify a completed burn. Unproven requested amounts remain in bridge metadata;
they never become fabricated settled asset debits.

`bridge_mint` proves the pinned verifier→master→canonical recipient wallet
message chain, exact source domain/nonce/quantity/recipient/message ID and actual
successful wallet credit. Both events retain their physical evidence and exact
canonical jetton out/in movements. Replay repeats preserve physical processing
fees and deduplicate principal by network/master/message ID. Source and return
native movements remain exact. `settlement.bridge.localNetworkFees` is
informational: owned transaction fees already exist as fee movements; observed
nonowned contract fees must not be added as separate user debits. Remote fees are
unavailable and are not synthesized.

For `settlement.protocol: sccp`, `status: confirmed` certifies only
`bridge.localStage: burned|minted` **on TON**. Every event keeps
`counterpartyStatus: unverified` and `bridge_counterparty_unverified`. Domains,
recipient32, message ID and nonce preserve the link for a future independently
verified counterparty event. No SORA receipt, reverse-route availability, remote
source account, remote network variant, ownership continuity, tax treatment or
counterparty balance is inferred. The physical account histories can be complete
while decoding coverage remains incomplete. A missing burn notification/journal,
unsupported historical identity, incomplete master/verifier history, or mismatched
binding remains explicit. Later exercise/refund lifecycle evidence stays separate.

T3 mint and redemption use the configured `T3Hub` and `T3Root` registry roles.
The graph verifies the hub's tagged storage root, root emitter, three immutable
reserve root/vault identities, and the deterministic receiver code/address and
controller. Its related accounts include the hub, root, reserve vaults, and all
identified user-controlled receiver wallets. A receiver wallet retains its actual
`asset.owner`; `asset.controller` identifies the user and `custody: t3_receiver`
identifies that custody. Internal transfers among these owned accounts cancel;
their actual transaction and forwarding fees remain separate movements.

`t3_mint` requires exact original owner/query collateral deliveries matching the
business receipt basket and a typed root mint request, canonical recipient wallet
credit, wallet/root acknowledgements, hub consumption, and root finalization.
The root query/wire/hash is distinct from the business query. Replayed root
messages add no second mint credit. Staged deposits and failed/bounced mint
attempts retain observed gross debits and fees with incomplete settlement.
`t3_redeem` requires the original owner burn intent, authenticated root-to-hub
proof and acknowledgement round trip, durable `redemption_identity` payout ID,
and every actual receiver wallet credit and credited acknowledgement. Receipt
amounts must sum to the exact burn; delivered reserves must equal every receipt
basket, including all slices. An early receipt, queued payout, unrelated global
supply delta or incomplete custody history cannot confirm redemption.

A lost initial burn acknowledgement can be recovered by the owner's explicit
`REDM` continuation. Configure `LEDGER_T3_REDEMPTION_BINDING_JSON` with the exact
qualified release manifest's `contractBindings.T3Redemption` object: active
network, raw hub/root addresses, four approved TON Cell hashes
(`hubCodeHash`, `rootCodeHash`, `walletCodeHash`, `receiverCodeHash`), and three
ordered `reserveRoutes` containing raw `root`, `vault`, and `discovery` addresses.
`discovery` must equal its reserve root; roots and vaults must be distinct.
Missing or whitespace-only input leaves recovery unconfigured. Malformed,
extra-field, noncanonical-address, or wrong-network input fails startup. The
runtime binding must also match registry and authenticated reserve routes;
observed code is never enrolled as an approved release.

Recovery requires exact archive code/data boundaries for the original wallet
burn, root supply debit and receipt, hub's unconsumed proof, later proof
consumption, root acknowledgement, and wallet journal `4 → 5`. The original
wallet and root each debit once; acknowledgement changes neither balance nor
supply. The proof may be recorded before hub activation; the later continuation
must run while enabled. Historical and current payout identities must agree.
`settlement.t3.burnRecovery` contains all six boundaries, qualified binding,
continuation body hash and transaction references. Missing archives, changed
identities, incomplete histories and unreceived acknowledgements remain explicit
issues. Recovered burn acceptance still requires every receiver credit for
redemption confirmation; token-free journal cleanup remains a separate action.

`settlement.protocol: t3` includes `t3` metadata with authenticated hub/root,
owner/recipient, business query, root query/wire/hash or payout ID, reserve roots,
receipt basket and delivered reserve basket. `amountRaw` is null for an unresolved
mint with unknown output; confirmed mint carries `mintedRaw`. Reserve arrays use
the hub route order (USDT, USDC, KUSD) and exact atomic strings; mint's delivered
reserve basket is zero because its output is T3. Evidence includes all linked
transaction identities and the persistent redemption getter observation.
`localNetworkFees` is non-additive transaction metadata: owned fees are already
movement entries and nonowned protocol fees are not another user debit.

Exact immediate before/after archive boundaries and unchanged hub code/root allow
mint fee splitting: collateral principal plus `protocol_fee` equals each actual
gross input debit. A replay's state cannot replace the original fee-assessment
state. Healthy redemption fee math follows the contract integer invariant and
haircut rules and must reproduce the full authenticated net receipt basket.
Redemption `feeAmountsRaw` is withheld before delivery and is **metadata only**,
not an extra fee debit from the user's already-net custody balance. Missing
archive boundaries, unsupported state layouts and outage redistribution retain
`t3_protocol_fee_breakdown_unavailable`; principal settlement can still be
individually confirmed. Refund lifecycle attribution, custody-funded minting,
third-party redemption recipients and unsupported routes stay unresolved.
Known perps OPEN/ADMG/MDIF funding and unverified T3 forwarding retain their exact
wallet transfers but cannot fall through to ordinary confirmed transfer settlement.

`historyComplete` proves the discovered account graph's observed chains, not
complete ownership, tax basis or portfolio coverage. `decodingComplete` is false
when identity, fees or supported settlement evidence is missing. Unsupported perps
aggregate/recovery and separate protocol cash flows, option abort/unwind and standalone expiry/shout paths,
rewards, cover, unsupported T3 refund/custody paths, launchpad claim/refund lifecycles, remote
bridge legs, non-SCCP burns and router/multi-hop operations remain explicit
unresolved classes; raw native and
available token receipt evidence is retained. LP fee/principal tax treatment and
all country classifications belong to the tax engine. No fiat prices or user
secrets are stored here. Consumers must retain these gaps in reports.

Raw evidence and issued snapshot generations have no automatic deletion policy;
plan database capacity and backups. Use the canonical first-release schema;
legacy memory snapshots and unscoped projections are never imported. `npm run test:ledger`
runs PGlite PostgreSQL integration tests for exact large amounts, immutable
pagination, quiet snapshot reuse, new custody heads, resumable limits, admission,
deduplication, rollback and chain validation, plus numerical swap/LP/provenance
and option/SCCP/T3 owner/query/position/message attribution fixtures, including
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
disposable empty database; set `LEDGER_SCOPE_TEST_DATABASE_URL` in that test
process, then run `npx tsx src/scripts/ledger-projection-scope-postgres-test.ts`.
Never point this test at an application database. The test does not establish
production archive availability or change the ledger's explicit decoding limits.

## Production Container
```bash
docker build -t ti-indexer:release .
docker run --rm -p 8787:8787 ti-indexer:release
```

The image defaults to `INDEXER_MODE=production`, `TON_NETWORK=mainnet`, and the
lite-client mainnet pool. Startup is intentionally blocked until
`registry/mainnet.json` contains reviewed mainnet contract addresses.

## Production Smoke
```bash
npm run smoke:production
TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production
```

The smoke check verifies that the target host serves the TONSWAP API contract,
not another indexer service. The CLI is always release-bound: either command
above fails until all of the release inputs below are present in its environment.

Release-bound checks fail closed unless the network, release ID, registry hash,
canonical manifest path/hash, and allowed browser origin are all pinned. The
manifest must be a canonical absolute path to a stable, single-link regular
file in a non-symlink, non-group/other-writable parent. A release-bound check
also requires the public service to expose the manifest's exact 62-contract
map, the three discovery/root equality pairs, and exactly two complete
one-minute single-trade candles for each of its three canonical markets:
```bash
TON_INDEXER_BASE_URL=http://127.0.0.1:8787 \
TON_INDEXER_EXPECTED_NETWORK=localnet \
TON_INDEXER_EXPECTED_SERVICE_ID=tonswap-local-indexer \
TON_INDEXER_EXPECTED_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
TON_INDEXER_EXPECTED_RELEASE_ID=local-run-1 \
TON_INDEXER_EXPECTED_REGISTRY_HASH=<sha256> \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH=<sha256> \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH=/absolute/path/to/release-manifest.json \
TON_INDEXER_EXPECTED_CORS_ORIGIN=http://127.0.0.1:5173 \
npm run smoke:production
```

The smoke sends simple and POST-preflight requests for both the allowed origin
and a distinct hostile origin. Hostile responses must omit both CORS
allow-origin and credential headers.

The certified manifest binds the three market identities and query metadata,
but does not contain the certified candle transaction IDs or time windows. The
standalone smoke therefore enforces six distinct, coherent transaction-backed
candles; the canonical release wrapper remains responsible for matching those
candles to the retained release proof.

## Configuration
Environment variables (all optional):
- `PORT` (default: `8787`)
- `HOST` (default: `127.0.0.1`)
- `TRUST_PROXY` / `FASTIFY_TRUST_PROXY` (`true` only when the service is behind a trusted proxy)
- `INDEXER_MODE` (`dev` | `production`, default: `dev`)
- `TON_NETWORK` (`mainnet` | `testnet` | `localnet`, default: `testnet`)
- `TON_DATASOURCE` (`http` | `lite`, default: `http`)
- `TON_HTTP_ENDPOINT` (explicit TonClient4 endpoint; if unset uses `@orbs-network/ton-access`)
- `INDEXER_WRITE_RPC_ENDPOINT` (optional upstream JSON-RPC endpoint for proxying write methods)
- `INDEXER_ENABLE_WRITE_RPC` (`true` to allow proxied write methods; default `false`)
- `INDEXER_WRITE_RPC_API_KEY` (optional API key passed as `X-API-Key` to `INDEXER_WRITE_RPC_ENDPOINT`)
- `INDEXER_RPC_PROXY_TIMEOUT_MS` (default: `30000`)
- `LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` / `LITESERVER_POOL_LOCALNET` (lite client pool; see below)
- `INDEXER_REGISTRY_PATH` (selected network registry; defaults to `registry/{network}.json`)
- `INDEXER_RELEASE_MANIFEST_PATH` / `TONSWAP_RELEASE_MANIFEST_PATH` (canonical release manifest; when set, startup requires exact network, key, address, and registry-hash parity with the selected registry)
- `INDEXER_SERVICE_ID` (default: `ti.soramitsu.io`)
- `INDEXER_PUBLIC_BASE_URL` (default: `https://ti.soramitsu.io`)
- `SORA_RPC_HTTP_ENDPOINT` (optional SORA JSON-RPC endpoint used to resolve the on-chain TON trusted checkpoint automatically)
- `SORA_RPC_TIMEOUT_MS` (default: `10000`)
- `SORA_TON_TRUSTED_CHECKPOINT_CACHE_TTL_MS` (default: `10000`)
- `SORA_TON_TRUSTED_CHECKPOINT_SEQNO` + `SORA_TON_TRUSTED_CHECKPOINT_HASH` (optional static override for the TON trusted checkpoint; used if you do not want RPC lookup)
- `CORS_ENABLED` (`true` to enable CORS headers; default `true`)
- `CORS_ALLOW_ORIGIN` (default: `*`; `reflect` is treated as wildcard without credentials)
- `CORS_ALLOW_ORIGINS` (comma-separated exact-origin allowlist; when set, only matching origins receive credentialed CORS headers)
- `CORS_ALLOW_METHODS` (default: `GET,HEAD,POST,OPTIONS`)
- `CORS_ALLOW_HEADERS` (default: `content-type,accept`)
- `CORS_EXPOSE_HEADERS` (default: `x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset`)
- `CORS_MAX_AGE` (default: `600`)
- `SNAPSHOT_PATH` (path to load/save in-memory snapshot)
- `SNAPSHOT_ON_EXIT` (`true` to write snapshot on shutdown; default `false`)
- `SNAPSHOT_AUTOSAVE_ENABLED` (`true` to periodically persist snapshots; default `true` in production when `SNAPSHOT_PATH` is set)
- `SNAPSHOT_AUTOSAVE_INTERVAL_MS` (default: `30000`)
- `RATE_LIMIT_ENABLED` (`true` to enable simple per-IP rate limiting; default `true`)
- `RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `RATE_LIMIT_MAX` (default: `10000`)
- `RATE_LIMIT_BUCKETS_JSON` (optional endpoint-class limits override JSON)
- `RESPONSE_CACHE_ENABLED` (`true` to enable response caching; default `true`)
- `BALANCE_CACHE_TTL_MS` (default: `2000`)
- `JETTON_BALANCE_TIMEOUT_MS` (default: `2000`; caps per-root jetton balance probes so native TON balance reads stay responsive)
- `INITIAL_HISTORY_TIMEOUT_MS` (default: `10000`, range: `1..120000`; caps the first account-history source read and returns `503` if it expires)
- `TX_CACHE_TTL_MS` (default: `1000`)
- `STATE_CACHE_TTL_MS` (default: `1000`)
- `HEALTH_CACHE_TTL_MS` (default: `1000`)
- `METRICS_CACHE_TTL_MS` (default: `1000`)
- `PAGE_SIZE` (default: `10`)
- `MAX_PAGES_PER_ADDRESS` (default: `150`)
- `GLOBAL_MAX_PAGES` (default: `200000`)
- `IDLE_TTL_MS` (default: `7200000`)
- `BACKFILL_PAGE_BATCH` (default: `5`)
- `BACKFILL_MAX_PAGES_PER_ADDRESS` (default: `150`)
- `BACKFILL_CONCURRENCY` (default: `2`)
- `JETTON_METADATA_TTL_MS` (default: `86400000`)
- `WATCHLIST_REFRESH_MS` (default: `5000`)
- `BLOCK_POLL_MS` (default: `5000`)
- `OPCODES_PATH` (default: `../tonswap_tolk/config/opcodes.json`)
- `LOG_LEVEL` (default: `info`)
- `INDEXER_ADMIN_TOKEN` / `INDEXER_ADMIN_API_KEY` (required for snapshot save/load and debug endpoints; pass as `Authorization: Bearer ...` or `X-Indexer-Admin-Token`)

Explicit enum values for `INDEXER_MODE`, `TON_NETWORK`, and `TON_DATASOURCE` fail startup when unsupported instead of silently falling back.
If the requested `PORT` is already in use, the server will bind to the next available port and log the selected one.

Production safeguards:
- In `INDEXER_MODE=production TON_NETWORK=mainnet`, placeholder, malformed, or testnet-only required registry addresses fail startup.
- `npm run audit:deployment-evidence -- --require-ready` also rejects ready
  deployment evidence while `registry/mainnet.json` still has placeholder,
  missing, or malformed required mainnet addresses.
- For `https://ti.soramitsu.io` production deployment guidance, see `docs/ti-production.md`.

## API
- `GET /api/indexer/v1/accounts/{addr}/balance`
- `GET /api/indexer/v1/accounts/{addr}/balances`
- `GET /api/indexer/v1/accounts/{addr}/assets` (alias of `/balances`)
- `GET /api/indexer/v1/jettons/{jetton}/transfer/{owner}/payload`
- `GET /api/indexer/v1/accounts/{addr}/txs?page=1`
- `GET /api/indexer/v1/accounts/{addr}/swaps?limit=100&from_utime=1700000000&to_utime=1700003600&pay_token=TON&receive_token=T3&include_reverse=true`
- `GET /api/indexer/v1/markets/{market}/candles?market_address={pool}&asset_symbol=TOKEN&quote_symbol=T3&interval=1m`
- `GET /api/indexer/v1/accounts/{addr}/state`
- `GET /api/indexer/v1/sccp/ton/burn-status?jetton_master={addr}&burn_initiator={addr}&query_id={u64}&sora_asset_id=0x...&dest_domain={u32}&recipient32=0x...&amount={raw}`
- `GET /api/indexer/v1/sccp/ton/burn-proof-material?jetton_master={addr}&message_id=0x...`
- `GET /api/indexer/v1/perps/{engine}/snapshot?market_ids=1,2&max_markets=64` — `status.feeBps`
  is read from the canonical 36-field `engine_config` getter and is `null` if that tuple cannot be
  decoded exactly or the base fee is outside `0..10000`; clients must combine it with each market's
  signed `controlFeeDeltaBps` and clamp the result to `0..10000`.
- `GET /api/indexer/v1/vol-index/{vol_index}/snapshot?pool={pool}&route_ids={job_ids}`
- `GET /api/indexer/v1/governance/{voting}/snapshot?owner={addr}&max_scan=20&max_misses=2`
  - Governance pages additionally accept `start_id` (positive uint64 string) and return `next_start_id` plus `coverage` (`rangeKnown`, `pageComplete`, `scanComplete`, `nextProposalId`, `dataHash`, `issues`). The current Voting storage counter bounds proposal discovery; unsupported storage or failed getters remain incomplete, retain the same page cursor, and never imply that proposals are absent. `max_misses` no longer truncates governance pages. Run `npm run test:governance` for pagination, later proposals and transient-hole coverage; this also runs before the default test suite.
- `GET /api/indexer/v1/pools/{pool}/farms?owner={address}&start_id=1&limit=20`
- `GET /api/indexer/v1/options/{factory}/snapshot?start_id=0&max_series_id=2048&window_size=24&max_empty_windows=2&min_probe_windows=8`
- `GET /api/indexer/v1/cover/{manager}/snapshot?owner={addr}&max_scan=20&max_misses=2`
- `GET /api/indexer/v1/contracts`
- `GET /api/indexer/v1/service-info`
- `GET /api/indexer/v1/stream/balances?address={addr}` (Server-Sent Events stream)
- `GET /api/indexer/v1/stream?address={addr}` (alias of `/stream/balances`)
- `GET /api/indexer/v1/health`
- `GET /api/indexer/v1/metrics`
- `GET /api/indexer/v1/metrics/prometheus`
- `GET /api/indexer/v1/openapi.json`
- `GET /api/indexer/v1/docs`
- `POST /api/indexer/v1/runGetMethod`
- `POST /api/indexer/v1/runGetMethods`

JSON-RPC compatibility endpoints:
- `POST /jsonRPC`
- `POST /api/v2/jsonRPC`

When `INDEXER_WRITE_RPC_ENDPOINT` is set, proxied JSON-RPC methods are available through `/jsonRPC` and `/api/v2/jsonRPC`; write methods stay disabled unless `INDEXER_ENABLE_WRITE_RPC=true`.
Public read endpoints intentionally include `/jsonRPC`, `/api/v2/jsonRPC`, `/api/indexer/v1/runGetMethod`, and `/api/indexer/v1/runGetMethods` so browser-only decentralized clients such as `../tonswap_web` can use the indexer directly.

Admin endpoints require `INDEXER_ADMIN_TOKEN` / `INDEXER_ADMIN_API_KEY`:
- `POST /api/indexer/v1/snapshot/save`
- `POST /api/indexer/v1/snapshot/load`
- `GET /api/indexer/v1/debug?limit=100`

Optional tx cursor query params:
- `cursor_lt`
- `cursor_hash`

Stream query params:
- `address` (single address)
- `wallet` (single address alias)
- `addresses` (comma-separated addresses)

Metrics payload highlights:
- `request_stats`: count, avg, p50, p95, max (ms)
- `cache_stats`: balance/tx hit rates
- `backfill_*`: pending/inflight plus batch/tx counters

## Registry Sync
If you have `tonswap_tolk` checked out next to this repo, you can refresh testnet registry data:
```bash
npm run sync-registry
```
`sync-registry` prefers `tmp_debug/referral.registry.repair.address` when present so the indexer tracks the latest repaired referral registry deployment.

Release runs may instead provide the canonical
`tonswap-testnet-release-v1` manifest with `network`, `releaseId`, `contracts`,
`registryHash`, and `manifestHash`. Contract entries may be address strings or
`{ "address": "..." }` objects. The selected registry must contain exactly the
same keys and address strings. `registryHash` is SHA-256 of the sorted contract
map encoded as compact JSON plus a trailing newline; `manifestHash` is SHA-256
of the recursively key-sorted manifest with the `manifestHash` field omitted.

## Notes
- This implementation supports `TonClient4` (HTTP v4) with endpoint rotation and a native liteserver adapter (`ton-lite-client`).
- `/api/indexer/v1/sccp/ton/burn-status` is a two-step, read-only confirmation API. First call it without `after_lt`/`after_hash` to validate the SCCP master and capture `masterCursor`; poll with that exact cursor pair after wallet submission. Expected propagation returns HTTP 200 with `status: "pending"`. `status: "confirmed"` is returned only after a successful, linked master transaction emits the requested `SccpBurnedNotification` and `get_sccp_burn_record` exactly matches the initiator, asset intent, destination, amount, and authoritative nonce. Cursor discontinuities and evidence mismatches fail closed.
- `/api/indexer/v1/sccp/ton/burn-proof-material` can omit `trusted_checkpoint_seqno/hash`; when omitted, the indexer resolves the current SORA-governed TON checkpoint automatically via `SORA_RPC_HTTP_ENDPOINT` or the static checkpoint override env vars.
- Jetton balances are fetched for registry keys ending with `Root` (e.g., `T3Root`, `TSRoot`, `UsdtRoot`), with metadata pulled from on-chain content and cached in memory.
- Swap/LP decoding is opcode-based and extracts DLMM swap/add-liquidity intent from Jetton transfer forward payloads (`SWAP`, `DLAD`) where available.
- Swap classifier now also decodes optional execution hints from swap `queryId` (market/limit/twap, optional twap slice/total, and optional token symbol codes) and returns them in both `detail` and `actions` for `kind: "swap"` tx entries.
- Swap hint decoding also exposes `querySequence` + `queryNonce` (from queryId metadata) so clients can group TWAP slices by run.
- `/accounts/{addr}/swaps` provides a chart-friendly swap execution feed with server-side filters for pair direction, execution type, status, and optional `from_utime` / `to_utime` time windows.
- `/markets/{market}/candles` aggregates only successful DLMM swaps for which
  the actual outbound transfer amount was decoded and matched to the inbound
  swap query ID. It excludes `minOut` fallbacks, normalizes both directions
  into quote-per-base OHLCV, and includes the source transaction IDs in every
  candle. With a release manifest configured, the requested key, pool, symbols,
  and decimals must exactly match one of its canonical markets.
- `/accounts/{addr}/swaps` also returns chart helpers:
  - `summary` (status + execution type counters, pending limit count, twap run count)
  - `twap_runs` (run-level progress/status snapshots)
  - `pending_limits` (pending limit orders for quick UI overlays)
  - `synced_at` (server unix timestamp in seconds when the payload was generated)

### Swap `queryId` Metadata (Optional)
- Backward compatible formats:
  - `0xd1` (v1): mode + twap slice/total + timestamp/nonce.
  - `0xd2` (v2): mode + twap slice/total + pay/receive token codes + sequence/nonce.
- v2 token codes currently recognized:
  - `1=TON`, `2=T3`, `3=USDT`, `4=USDC`, `5=KUSD`, `6=TS`
- If `queryId` metadata is absent, classifier still falls back to opcode-level swap decoding.

### Liteserver Pool Format
`LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` /
`LITESERVER_POOL_LOCALNET` can be one of:
- URL to a TON global config JSON
  - mainnet: `https://ton.org/global.config.json`
  - testnet: `https://ton.org/testnet-global.config.json`
- Local path to a config JSON file
- Comma-separated `ip:port:pubkey` entries (pubkey is base64); ip can be dotted or integer

### Exact perps ledger evidence

Set `LEDGER_PERPS_ENGINE_CODE_HASH` to the qualified current-network `PerpsEngine`
artifact hash from the release manifest. Undefined, empty, or whitespace-only values
leave perps settlement unconfigured. Every nonempty value must be exactly 64 lowercase
hexadecimal characters: prefixes, uppercase, surrounding whitespace, and malformed
values fail startup. There is one registry engine and one hash, with no automatic
network fallback. Physical wallet transfers remain visible when this binding is absent.

The durable graph crawls the canonical engine and the owner's and engine's T3 wallets,
including keeper transactions that name an owner without touching the owner's wallet.
Current and exact historical engine code must match the pin. The stored T3 root,
wallet code, deterministic wallet addresses, and wallet getter identities must agree.
The decoder reads exact before/after account, full owner/market position key, and payout
journal dictionaries; current `account_state` totals and global open interest are never
historical settlement evidence. Missing archive boundaries, identity, or related chain
coverage leave the operation incomplete. Backfill and dependency limits remain explicit.

When a masterchain snapshot skips an intermediate transaction, the lite adapter
fetches the full preceding Account and up to 32 original transactions. It uses
the original shard-block random seed and the historical configuration committed
by that block's masterchain reference. The pinned production dependency
`@ton/sandbox@0.42.0` executes these inputs locally; every reconstructed full
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

### Option exercise, payout and individual refunds

Set `LEDGER_OPTIONS_CODE_HASHES_JSON` to an object containing exactly
`factoryCodeHash`, `vaultCodeHash`, `shoutCodeHash`, `outperformanceCodeHash`, and
`walletCodeHash`. Every value must be a lowercase 64-character TON Cell hash from
the qualified current-network artifacts. The registry supplies `OptionFactory`,
`OptionVault`, and `T3Root`; their observed code/configuration must match this
binding. Omitted or empty configuration is unconfigured, with no public-network
fallback. A missing/mismatched binding leaves option settlement unverified,
including historical purchases, while preserving known physical movements.

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
decoder `exact-ledger-v15`; consumers use this canonical format without an older
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
`npx tsx src/scripts/export-option-abort-fixtures.ts ../tonswap-platform/test/fixtures`.
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

Set `LEDGER_LAUNCHPAD_CODE_HASHES_JSON` to an object containing exactly
`fixedCodeHash`, `bondingCodeHash`, `auctionCodeHash` and `walletCodeHash`, all lowercase 64-character Cell hashes
qualified from the deployment artifacts for the selected network. RPC-observed
code never defines this allowlist. Without qualification, Launchpad token
movements retain exact cash and fee evidence with unresolved product settlement.
Known sale addresses come from release-manifest markets and observed claim or
contribution destinations. An empty-payload return can also be discovered through
its independently resolved source wallet owner.

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
live transactions are needed. The decoder fingerprint is `exact-ledger-v15`, so
changed decoding or evidence publishes a fresh immutable generation instead of
reusing earlier projections.

### Native DLMM farming observations

Farming campaigns live in DLMM pool storage. The pool-scoped endpoint reads a complete bounded page, accepts exact uint64 campaign cursors, and optionally includes owner shares, accrued rewards, and the last settlement ID. Rewards and shares remain atomic decimal strings. Missing or malformed getters produce an explicit error, never an empty successful farm list. These are current observations across getters, not a historical atomic snapshot. Claimed amounts are committed payouts; only the matching durable settlement proves wallet delivery. The retired CLMM factory endpoint and aggregate farm-factory binding are removed. Run `npm run test:farms` for parser, pagination, and route checks.
