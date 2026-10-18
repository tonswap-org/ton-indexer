# TONSWAP Indexer Roadmap

## Durable-ledger deployment readiness — 2026-10-06

`GET /api/indexer/v1/ledger/readiness` is a read-only native testnet deployment
gate. HTTP 200 uses `tonswap-native-ledger-readiness-v1` with exact manifest
service/release identity, the pinned compiled JS/SQL hashes, the full durable
database release identity and canonical ISO `checkedAt`. The actual configured
PostgreSQL namespace must match the generated canonical SQL catalog in one
repeatable-read snapshot. Missing storage, identity/schema drift or changed
compiled files returns HTTP 503. Requests do not initialize storage, enroll
accounts or collect history, and responses cannot be cached. The native release
producer separately qualifies the installed compiled store on its owned native
PostgreSQL runtime before its guard admits this build and endpoint.

## Current Perps qualification — 2026-09-27

The current decoder distinguishes ordinary CLOSE's empty context, MODIFY's
complete prior position and managed CLOSE/CFNG's exact position commitment plus
native sponsor. It validates pending operation kind separately from terminal
reason, preserves context identity through the oracle callback and verifies an
accepted managed exit against its actual prior position. Mesh sponsors require
job 405 and the configured control return collector; malformed, substituted or
trailing context fields are rejected.
An ordinary owner full CLOSE can supersede a pending maintenance CLOSE, even
with the same business query ID, while allocating a different wire nonce. This
exception does not allow replacement of other paid pending orders.
The indexer regression exercises that exception with synthetic intake boundaries
and an unchanged ordinary-CLOSE wire; the existing native risk suite separately
tests actual supersession. These are not a captured supersession ledger graph.

Fresh direct-owner CFNG claims use the authenticated oracle callback for economic
execution. Their native context binds the intake transaction's logical time to
direct refund kind 0, module 0 and the owner refund address. Existing pending
funding transfers keep the contract's direct retry path and original settlement
journal. Oracle acceptance, fee allocation, trader-margin returns and physical
LP-funded payment remain separate facts with independent evidence.

The managed maintenance decoder regression passed against original final14
native transaction and storage captures. A later capture-only native test change
adds accepted/rejected CFNG and exhausted-reserve-close cases. The final15 risk
producer passes all 53 native tests and independent compilation at source
closure `c93e4a60...`, with Engine `d3a74ae2...`. Targeted oracle-execution
integration passes against the authenticated 11-case staged fixture directory,
including the three new actual claim cases and missing-custody/context negatives.
The log is `../output/first-testnet/generation-20260925-g33/preparation/indexer-claim-integration-final15-01.log`.
Earlier final14 captures retain their original provenance. All six final15
native producers now pass at counts 53/7/32/5/1/1 and their current fixtures are
adopted. The complete indexer `npm test`, including pretest and all 47 ledger
scripts, passes alongside both typechecks, 592 web Perps unit tests and 13 browser
scenarios. The final provenance check verifies all six native receipts and the
exact current 234-file indexer inventory used by both web projector families.
The receipt is `../output/first-testnet/generation-20260925-g33/preparation/perps-current-precheck-final15.json`.
Frozen whole-release qualification and testnet deployment remain pending.

## Current design

The current service has one reviewed manifest and one locally configured liteserver pool. All mainnet, testnet and localnet peers are supplied through an absolute local global-config path or explicit inline peer list. Testnet is the default network. There is no HTTP provider, remote peer discovery, static address registry or opcode file loading. Native release metadata and deployment/code bindings come only from the manifest; opcodes are bundled.

Current reads pin one monotonic network-authenticated head. Account responses include real shard-block anchors and creation times. The source shares only active identical queries and bounds cancellation, retries and hedges. Current balances contain GRAM plus all manifest tokens with exact atomic values and explicit ok/not_deployed/unavailable states. No failed token read becomes zero. A single HeadFeed drives shared SSE refreshes. Completed getter/balance caches are absent; snapshot reuse is explicit, bounded and keeps its original asOfSeqno. Time-dependent farms and volatility snapshots do not reuse results.

The public surfaces are the current OpenAPI contract: balances, paginated activity, current account state, pinned readFresh, runGetMethod, selected product snapshots, candles, contracts/service identity, health and the two local-source JSON-RPC mounts. Durable owner ledger, discovery and historical market routes provide separately qualified evidence. Removed balance/asset aliases, payload construction, swap-list, Options/Perps/DeFi snapshot and multi-getter batch routes have no compatibility aliases. Activity hints never certify settlement.

REST failures are flat `{error,code}` with honest status and no-store; 429/503/504 include Retry-After. Route deadlines propagate aborts: getter/balance/JSON-RPC 5s, snapshot 10s and fresh batch 18s. The limiter authenticates the edge key plus visitor IP, otherwise uses the raw socket; forwarded-for headers have no authority. The reviewed nginx template preserves application errors and SSE, blocks operational routes and supplies only the static unavailable-backend 503. Enabled BOC sends use one attempt on the same chain source.

## Persistence and publication

Bounded in-memory activity maps and optional manifest-scoped snapshots support UI history and diagnostics. They do not supply settlement proof or durable exports. PostgreSQL retains original physical transaction chains, archives, qualified wallet identities, owner checks and immutable published projections. First-release deployments start from a fresh canonical schema; no old-schema fallback, inferred projection scope or automatic migration exists.

Each physical account gets its own page allowance and cross-process lock. Exact linked history reaches genesis independently of the observation boundary. Owner cycles acquire one head and refresh every relevant physical account at that boundary. The owner check stores server checkedAt, the chain boundary, head vector, pending accounts and current/published bindings. Every previous graph account must be present with equal-or-later LT (exact hash at equal LT), and every prior resolved binding must stay resolved before publication. A failed refresh preserves the prior generation. An eligible unchanged-head check writes only its mutable check, without history/project work.

The exact-ledger-v21 fingerprint includes economic events, represented physical scope, related account address/role/history completeness and stable issues. Related generation IDs, observed heads, timestamps and mutable refresh diagnostics are excluded. Current uncursored pages merge the latest completed check only for their matching publication; continuation cursors retain immutable snapshots. Positive evidence needs exact covered transactions. Absence-based conclusions additionally require current-boundary coverage, never just stored historyComplete. Confirmed regression counts are alarms and do not substitute for the input rule.

Ordinary ledger pagination uses immutable generation-bound cursors, exact network/owner/date bounds and limits 1–500. Activity history uses page numbers (default 10) with bounded retained pages. Market ledgers and perps ranges retain their own proof scope; a complete requested perps interval never claims all-history completeness. Raw evidence and previously published generations have no automatic deletion policy.

## Scheduling and operations

The priority scheduler has 2–8 workers (default 3), reserves a foreground slot and coalesces running requests into one follow-up. Retry backoff is 2–60s. A 30s sweep revisits watches requested within 15min or unresolved; startup physically prewarms current manifest singletons and spot pools. Each account retains its own history-page allowance. Worker SQL capacity is workers × 5 + 4, separately from 10 read connections. Perps collection/sweeps are isolated from read/admission work and retain their bounded queue, persisted 5–300s backoff, cross-process locks and 15-minute active-generation expiry.

Configuration validates before listen; the listener opens before chain/database/native initialization. Health reports actual component state; compiled ledger readiness authenticates the exact build, release, canonical schema and read permissions. Connection failures retry without resetting data; catalog/identity conflicts remain unavailable. Disk monitoring starts unknown/critical and skips snapshot writes unless ok. Snapshot serialization and logging are bounded asynchronous work. Runtime metrics expose chain and event-loop health, phase/I/O timings, scheduler depth/age, pool wait, database size and first-publication latency.

Current validation is Node 22, offline package-owned scripts/typechecks, whole-suite gates and isolated native PostgreSQL 16 tests under INDEXER_TEST_DATABASE_URL. test:ledger runs with only PATH and LANG. The native readiness body, build hash inputs, SQL identities and exported store surfaces remain a cross-repository contract.

A release uses one cutover window: ready the new build/database beside the old one if capacity permits, publish the new web, switch the proxy, then record ledger admission and run release acceptance. If parallel native runtimes cannot fit, publish the web before restarting the indexer. Rollback restores the old proxy upstream/database while keeping the new web. Operational latency, peer reliability, disk capacity and live qualification remain release-session evidence, not claims established by offline tests.

## Retained product qualification

The following requirements define exact current contract evidence independently of the read/API refactor.

## Current T3 referral identity

The first-release T3 ledger requires the mandatory invitation reference in MINT,
REDM and collateral-deposit notes, the inline inviter in the burn application,
and the current Hub referral state reference. Old wire/storage layouts remain
unsupported. Historical redemption proof and owner continuation must retain the
original inviter. Qualified mint/redemption settlement exposes that original
`referrer` (nullable); it never infers a sponsor from current registry state.

Validation: `npx tsx src/scripts/ledger-t3-test.ts`,
`npx tsx src/scripts/ledger-t3-discovery-test.ts`, `npx tsc --noEmit` and
`npx tsx src/scripts/openapi-test.ts`. Captured discovery bytes are immutable;
the old Hub layout is explicitly rejected and a separately labeled synthetic
current-layout state exercises discovery.

The Hub referral-state decoder also requires the inline completed-user-mint
dictionary and validates every archived key, finalized journal, and receipt
identity. The current fixture producer is
`T3_WEB_FIXTURES_DIR=../tonswap_web/tests/fixtures npx tsx src/scripts/ledger-t3-test.ts`;
it writes only the mint/redemption fixtures and preserves frozen old receipts.

### First-release native funding evidence (2026-09-18)

Managed control/settlement branches use current CNFW funding contexts and CNRF
actual native returns. Decode business data separately from complete outer wire
identity; exact messages, original BOCs, qualified historical code/state and
physical wallet balance transitions remain mandatory for product settlement.
Current TVM12+ `extra_flags` is metadata even where an SDK/provider calls its
serialized field `ihrFee`/`ihr_fee`. It must never be added to native expenses.
The native funding and native terminal tests cover this boundary. Full current
Perps/RiskVault journal decoder integration and new deployment qualification
remain open until their exact sources and original state captures close.
