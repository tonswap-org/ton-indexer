# TONSWAP platform service

Node.js/TypeScript service in `ton-indexer/services/platform` for public price observations and optional wallet notifications. Trading and browser-local tax reports must remain usable when this service is unavailable. This service has no transaction submission, tax-record upload, income-record storage, or client-supplied chain-event endpoint.

## Run and verify

Requires Node 22+ and PostgreSQL 16+. Install with `npm ci`, copy `.env.example` to `.env`, supply the encryption key, then:

```sh
npm run verify
node --env-file=.env dist/migrate.js
node --env-file=.env dist/main.js
```

`PLATFORM_MODE=all` runs API and durable workers; `api` and `worker` run separate processes against the same database. Migrations are an explicit deployment step. The service fails startup if its schema has not been initialized. `npm run verify` typechecks, runs tests against PGlite's PostgreSQL engine, and produces `dist/`. Tests mock external services; no paid API keys or real browser subscriptions are required. A real Frankfurter v2 request was also checked during development. No real push delivery or production rollout is implied by the mock tests.

`npm run test:native-options` repeats the option lifecycle worker regressions against an owned temporary native PostgreSQL 16 cluster. Set `TONSWAP_POSTGRES_BIN_ROOT` to the PostgreSQL binaries directory if it differs from `/opt/homebrew/opt/postgresql@16/bin`. The script binds only to a random loopback port, creates its own test database, and stops and removes that cluster afterward. Its cases cover exercise and recipient payouts, partial and delayed owner-requested abort returns across committed, failed and unobserved original vault deposits, automatic initial-buy bounce refunds, factory-only returns, generation completeness, cursor continuation, worker replacement and lease fencing, atomic rollback, deduplication with preserved read state, and inbox retention after mocked push-provider 503/410 responses. It does not start background provider pollers, contact push providers, or qualify a production deployment.

The initial migration creates sessions/challenges, preferences, encrypted device subscriptions, rules with durable monitoring observations, inbox events, source checkpoints, quote caches, immutable historical source revisions and leased jobs. Apply the complete current schema before starting the matching API, worker and frontend release. Startup verifies the price-monitoring relation; saved rules cannot fall back to an older response format. Use a dedicated database role. Back up PostgreSQL and `DATA_ENCRYPTION_KEY` separately; changing the encryption key without re-encrypting saved subscriptions makes those devices unusable.

## Static frontend and deployment

Recommended production layout: static frontend at `https://test.tonswap.org`, reverse proxy `/platform/` to `127.0.0.1:18787/`, and `VITE_PLATFORM_API_URL=/platform`, `VITE_APP_ORIGIN=https://test.tonswap.org` in the frontend build. `deploy/nginx.conf` strips the prefix and overwrites forwarded client addresses. Run the API with `HOST=127.0.0.1`, `PORT=18787`, `TRUST_LOOPBACK_PROXY=1`. Only the exact IPv4/IPv6 loopback proxy addresses are trusted; direct untrusted peers cannot choose their forwarded identity. `deploy/tonswap-platform.service` is a systemd template; set its user, Node path, checkout path and protected environment file to actual host values before installation.

Cookies are HttpOnly, Secure, `__Host-` prefixed, path `/`, and SameSite=Lax by default. For a separate HTTPS API origin set `COOKIE_SAME_SITE=none`, `PLATFORM_URL`, and exact `APP_ORIGIN` values; the frontend must send credentials. Third-party-cookie restrictions can still prevent this topology, so the same-origin proxy is preferred. Origins are exact, credentialed CORS is explicit, and every authenticated mutation requires Origin, `X-CSRF-Token`, `X-Wallet-Address` and `X-Wallet-Network`. The wallet headers must equal the cookie session, preventing a delayed request from crossing a wallet/session change.

`ALLOW_INSECURE_LOCAL=1` enables an explicitly named development cookie and HTTP only for localhost URLs. It must not be used for public deployments. Browser push enrollment requires the frontend's stable HTTPS origin and dedicated `/notification-worker.js`. On iOS the app must be launched after Add to Home Screen. Embedded/unsupported browsers retain the inbox path. Successful permission and browser subscription are insufficient: the server registration must complete before the UI shows enabled.

`Dockerfile` supplies an unprivileged runtime. `compose.yaml` provides PostgreSQL, one-shot migration, API and worker for local smoke/staging setup; set `POSTGRES_PASSWORD` and `.env` first. Its Docker bridge API has proxy trust disabled, so requests forwarded through the bridge share that peer's rate budget. Use the native loopback/systemd topology above for production per-client proxy limiting, or explicitly design a separately reviewed trusted-proxy topology. PostgreSQL is not published by the compose stack. No deployment or purchase is performed by these files.

The first-release browser runner also starts this exact production `dist/main.js` in API-only mode against an owned temporary native PostgreSQL 16 cluster. It uses an ephemeral encryption key/database password, the resolved loopback UI origin, empty testnet asset mappings, and no VAPID, worker, indexer binding or provider credentials. Frankfurter remains a real read-only provider; absent prices return null/unavailable. `PLATFORM_INSTANCE_ID` is an optional UUID exposed by health so the supervisor verifies the exact API instance. This local navigation proof does not establish public provider, governance, ledger-worker or push delivery readiness.

## Configuration

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated PostgreSQL connection string |
| `DATA_ENCRYPTION_KEY` | Base64 32-byte AES-GCM key; generate with `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"` |
| `APP_ORIGIN` | Comma-separated exact allowed frontend origins |
| `PLATFORM_URL` | Public service URL, including proxy prefix when used |
| `NETWORKS` | `testnet`, `mainnet`, or both; only enable networks with valid deployment identities |
| `INDEXER_URL_TESTNET`, `INDEXER_URL_MAINNET` | Authoritative indexer base including `/api/indexer/v1` |
| `INDEXER_API_KEY` | Optional server-to-server bearer credential |
| `TON_RPC_URL_TESTNET`, `TON_RPC_URL_MAINNET` | Configured JSON-RPC endpoint for unknown wallet code public-key resolution |
| `TON_RPC_API_KEY` | Optional RPC key; never sent to the browser |
| `INDEXER_RELEASE_MANIFEST` | Absolute path to the exact live release manifest; binds DEX markets, roots, code hashes, precision and indexer URL |
| `COINGECKO_API_KEY`, `COINGECKO_TIER` | Optional explicitly dated historical archives only; never current DEX pricing |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | All three or none; generate keys with `npx web-push generate-vapid-keys --json`; subject is `mailto:` or HTTPS |
| `GOVERNANCE_CONTRACT_TESTNET`, `GOVERNANCE_CONTRACT_MAINNET` | Verified deployed Voting contract per network |
| `ASSET_VALUATION_PATHS_JSON` | Optional listed-asset bindings for the explicit historical-anchor endpoint; ignored for current prices |
| `SESSION_HOURS` | 168 default, maximum 720 |
| `POLL_SECONDS`, `PRICE_SECONDS` | Wallet polling 30s default; price scan 120s default |
| `WORKER_CONCURRENCY` | 4 leased jobs by default |
| `RETENTION_DAYS` | Inbox retention 90 days by default |

## Public API

All amounts/rates are decimal strings; missing observations are null. `status: available` means an observation exists, not that it is fresh. Check `stale`, `observedAt`, `observationDate`, `requestedDate`, source and issues. Identity conversion USD/USD=1 is mathematical identity; no stablecoin or test token is assumed to trade at $1.

| Endpoint | Response |
| --- | --- |
| `GET /v1/health` | DB readiness, worker heartbeat, failed delivery count and configured provider capabilities |
| `GET /v1/capabilities` | Enabled networks, categories, rule defaults, indexer/governance availability, `taxDataAccepted:false` |
| `GET /v1/currencies` | `{currencies:[{code,name}],source,stale}` |
| `GET /v1/assets/search?network=testnet&q=USDT` | Release-bound DEX asset catalogue and explicit quote denomination; no external listings |
| `GET /v1/rates?base=USD&symbols=JPY,EUR,BTC,XOR,GRAM&network=testnet&date=YYYY-MM-DD` | `{base,requestedAt,quotes,issues,historicalFx?,historicalPrices?}` |
| `GET /v1/rates/revisions/<sha256>` | Immutable public daily FX revision `{revisionId,evidence}` |
| `GET /v1/ptax?currency=USD&date=YYYY-MM-DD` | Direct Banco Central daily BRL buy/sell quotations, request identity and freshness |
| `GET /v1/ptax/revisions/<sha256>` | Immutable public Banco Central source revision `{revisionId,evidence}` |
| `GET /v1/prices?ids=bitcoin,ethereum&vs=usd&date=YYYY-MM-DD` | `{currency,requestedAt,quotes,issues,historicalPrices?}` |
| `GET /v1/prices/revisions/<sha256>` | Immutable public daily CoinGecko revision `{revisionId,evidence}` |
| `GET /v1/prices?network=testnet&assets=0:<root>` or `/v1/dex-prices` | Exact release-bound T3 pool quotes, observed head, source and evidence |
| `GET /v1/asset-valuations?network=testnet&assets=native,0:<root>` | USD monetary fields remain unavailable; `dex` contains correctly denominated pool quotes |
| `GET /v1/historical-anchor?network=mainnet&asset=native&at=<timestamp>` | `{network,assetId,anchor}` for an explicitly configured listed asset |
| `GET /v1/historical-anchor/revisions/<sha256>` | Immutable public provider revision `{revisionId,evidence}` |

FX quote: `{symbol,rate,observedAt,observationDate,requestedDate,source,providers,providerObservations?,stale,status,precision}`. Source is `identity` for dated same-currency conversion, `frankfurter-v2`, `coingecko`, or `unavailable`. Frankfurter v2's aggregate date and the component observations are distinct: `providerObservations` retains each source key, date, rate and exclusion flag; `providers` contains included keys. Earlier observations are explicitly identified. Current daily FX becomes stale after 96 hours; precise trading/intraday FX is not claimed.

Current token prices come only from the manifest-bound TONSwap DEX. `GET /v1/prices?network=testnet&assets=<canonical roots>` returns `currency:'T3'`, the exact `quoteAssetId`, release identity and per-asset decimal prices with `source:'tonswap-dex'`. A single current-head indexer read verifies the release, deployed pool/root code hashes, token precision, pool configuration, active-bin Q64 price and usable liquidity. Evidence retains the raw Q64 value, exact ratio, head and separate last market activity timestamp. These are indicative pool-state prices, not completed trades or guaranteed execution amounts. A head older than two minutes or mismatched evidence cannot admit a current price. No external current-price requests or old external spot-cache fallback exist.

The r2 release contains USDT/T3 and USDC/T3 pools. These testnet roots do not establish USD value. Monetary USD fields stay null; the `dex` member carries T3 quotes separately. GRAM and other unconnected assets remain unavailable. A T3/T3 identity is not a market observation. Percentage changes remain unavailable without qualified history at the 24-hour boundary.

Target alert definitions must include `currency:'T3'`, canonical `quoteAssetId` and `releaseManifestHash` from the DEX catalogue. API admission, database storage, worker evaluation and notification text preserve that binding. Clients must display the denomination and send it explicitly; a previous USD-form request is rejected instead of silently becoming a T3 threshold. No current external listed-asset alerts are supported.

Explicitly dated historical requests retain the original source observations, immutable revisions and decimal precision. They cannot substitute for a current DEX quote. Fiat FX remains a separate Frankfurter source. Current BTC/XOR/GRAM USD conversions are unavailable without DEX evidence establishing that denomination.

## Wallet verification and private API

Request `POST /v1/auth/challenge` with `{address,network}`. The nonce is bound to canonical wallet, network and requesting origin domain, expires in five minutes, and is consumed atomically once. Supply its `payload` to TonConnect's proof request, then post to `/v1/auth/verify`:

```ts
{address, network, publicKey, walletStateInit,
 proof:{timestamp,domain:{lengthBytes,value},signature,payload}}
```

The server derives the address from state-init, matches recognized wallet code before extracting its public key, verifies domain byte length, signed payload, timestamp, key and Ed25519 signature, and uses only configured network RPC for an unfamiliar wallet code. It returns `{walletAddress,network,expiresAt,csrfToken}` plus the secure cookie. `GET /v1/auth/session` restores that response. `POST /v1/auth/logout` revokes that session and its registered devices. Signing/reconnecting is an explicit notification action and must never be required before a trade. Failure must not disconnect an already reconnected trading wallet.

Every authenticated write sends the captured session's CSRF token and canonical wallet/network headers. Do not substitute the currently selected wallet halfway through enrollment. Reads with wallet headers also reject a mismatched cookie. The frontend cancels pending enrollment and ignores stale results when the connected wallet changes.

| Endpoint | Body / response |
| --- | --- |
| `GET/PATCH /v1/notifications/preferences` | PATCH any subset of `{priceAlerts,activity,governance,walletProtocol}` booleans; returns `{preferences}`; defaults all off |
| `GET /v1/notifications/price-rules` | `{rules}` |
| `PUT /v1/notifications/price-rules` | `{asset,currency,quoteAssetId,releaseManifestHash,enabled,kind:'percent'|'target',thresholdPercent?,targetPrice?,direction?}` → `{rule}`; exact decimal strings, tagged identity below |
| `DELETE /v1/notifications/price-rules/:id` | Wallet/network-scoped deletion |
| `GET /v1/notifications/inbox?limit=30&cursor=...` | `{notifications,nextCursor}`; stable newest-first keyset pagination |
| `POST /v1/notifications/inbox/:id/read` | Wallet/network-scoped read state |
| `GET /v1/push/config` | Public `{available,publicKey}` |
| `GET /v1/push/subscriptions` | `{subscriptions:[{id,deviceName,active,createdAt,lastSentAt,retirementReason,endpointHash,applicationServerKey}]}`; SHA-256 fingerprint matches the current browser endpoint without returning endpoint secrets |
| `POST /v1/push/subscriptions` | `{endpoint,expirationTime?,applicationServerKey,keys:{p256dh,auth},deviceName?,replacesSubscriptionId?}` → `{id,active:true,applicationServerKey}`; replacement retires only a prior device owned by this wallet/network, in the same transaction |
| `DELETE /v1/push/subscriptions/:id` | Retires one device; other devices keep receiving |
| `POST /v1/push/test` | `{subscriptionId}` → `{queued:true,notificationId,delivery:'pending'}`; queued is not delivered |

Current alert identities are `{kind:'ton',network:'testnet'|'mainnet',assetId:'native'|'<raw token root>'}`. Valid address presentations normalize to the canonical root. A rule must match the authenticated wallet network and the manifest's quote asset/release. Only manifest assets with qualified DEX liquidity support targets. Native GRAM remains identifiable but has no r2 price market.

Target rules require a positive decimal-string T3 threshold and an above/below direction. The catalogue and saved rules expose `capabilities:{target,percent}`. Enabling a rule requires a fresh, correctly scoped DEX observation. Percentage rules remain unsupported until qualified 24-hour observations exist; no percentage is synthesized from mismatched snapshots.

Editing resets the observation baseline while retaining the cooldown. A first valid observation establishes state without flooding an already-crossed alert. A fresh transition from inside/opposite direction triggers once, with a 24-hour cooldown. Remaining outside never repeatedly alerts. Moving inside and crossing again re-arms after the cooldown. Stale/missing/out-of-order prices cannot trigger.

The first-release database schema stores canonical asset identity, `currency`, `quote_asset_id` and `release_manifest_hash`. Monitoring sources admit only `tonswap-dex`. Startup rejects a database missing these columns. A deployment must preserve existing data and explicitly qualify schema changes before switching API and worker; rerunning the initialization script does not upgrade an existing database.

Every returned rule includes `monitoring: {state,checkedAt,observedAt,evaluatedAt,validUntil,source,issue}`. States distinguish disabled rules, a disabled price-alert category, a rule waiting for its first check, active monitoring, stale observations and an unavailable feed. `checkedAt` records the worker's latest attempt; `observedAt` is the price provider's observation; `evaluatedAt` records the last observation applied to crossing detection. These timestamps are not interchangeable. Validity expires at the earlier of the two-minute observation limit and the worker-check deadline (three configured scan intervals, at least five minutes). The browser also expires the status without depending on a successful refresh.

Each attempted rule receives a durable outcome, including a missing price, unavailable provider, invalid scope, stale observation or missing 24-hour change. A target alert can use a valid price without percentage-change data. Repeated cached prices update check time without extending market freshness or re-evaluating a crossing. Failures retain the last valid baseline; a definition edit or price-category transition clears it, retains the notification cooldown and requires a new observation. Rule revisions, scan start times and job leases fence delayed responses. Monitoring persistence, baseline updates and inbox creation are atomic. These states describe price checks; browser push remains a separately verified delivery setting.

## Durable delivery and chain evidence

PostgreSQL jobs use `FOR UPDATE SKIP LOCKED`, 90-second leases, 20-second heartbeats and fencing tokens. Crashed leases are recovered. Inbox insertion, deduplication and delivery-job enqueue are atomic. Transient failures use exponential backoff with jitter; push delivery stops after eight attempts and is visible in health. Recurring source jobs retry indefinitely with backoff. Push 404/410 or expired browser subscriptions retire the device. Browser endpoints/keys are encrypted at rest; sessions are stored as hashes. Endpoint hosts are restricted to supported FCM, Mozilla, Apple and Windows browser push services. HTTPS, no credentials/fragments/custom ports, and connection-time public-IP DNS checks block private endpoint/redirect/rebinding access.

Delivery is at least once: a crash after a push provider accepts but before marking a job done can retry. Stable notification IDs become browser tags so retries replace the same visible notification. Push payloads include a declarative Web Push envelope and service-worker-compatible visible fields. Users can disable individual devices, recover expired subscriptions, and keep the inbox if push is unsupported or unavailable.

Enrollment renews expired browser subscriptions and those bound to an old VAPID key after an explicit user gesture. Browser permission and worker activation waits are bounded and abort on wallet changes; a failed server registration remains incomplete and can be retried. Device fingerprints prevent a remembered wallet/device ID from unsubscribing a different current browser endpoint. `provider_expired` devices display Expired; deliberate disable, logout and replacement display Disabled. The browser's operating system may still deliver a push already accepted before a disable request; queued future jobs check the device's current active state and wallet/network binding.

Wallet polling reads only the configured indexer's durable `/accounts/:wallet/ledger/discoveries` feed. Exact per-wallet publication revisions capture later settlement of requests made before enrollment, without repeatedly widening a request-time window. The first scan uses the earliest active category epoch; later scans resume the last consumed revision. A fixed `throughRevision` and immutable coverage generation pin pagination. Complete root coverage requires a dependency-head check within five minutes; continuation pages retain that original verified boundary. Incomplete indexing, malformed evidence and expired/changed cursors preserve the last consumed revision. Notification insertion and checkpoint advancement share a transaction fenced by the live worker lease.

A successful wallet request, classifier action or minimum-output hint is never called a fill. DLMM product activity requires `settlement.status='confirmed'`, `protocol='dlmm'`, canonical pool/query/transaction evidence and matching real asset movements: distinct swap input/output, minted LP position plus paid assets, or burned LP position plus received assets. Option purchases require `protocol='options'`, `operation='option_buy'`, exact factory/series/position/wire identity, matching premium/collateral/protocol-fee movements, the activation round trip, and an `option_position` right with the buyer's active `position_info` evidence and no abort flags. The position's `sourceWallet` is the factory's collateral wallet; the original debit retains the buyer's source wallet and the exact factory-wallet receipt. Funding or reservation alone remains pending. Settlement identity deduplicates later merged ledger projections. Links include `/wallet?tx=<encoded indexer txId>` with LT/hash/account evidence. The indexer tx ID is its opaque `lt:hash` identity; do not assume it is a bare explorer hash. Inbox items survive both transient and terminal delivery failures.

Option exercise and payout are independent notices. `Option exercise confirmed` requires the exact retired right and matching historical factory/product state; it does not claim cash delivery. `Option payout confirmed` additionally requires the actual recipient credit, matching typed transfer evidence, and the vault's exact journal progression through finalization. Exercise identity uses its original request body hash, without inventing a user query ID. Each stage has a separate stable deduplication key. Later payout evidence publishes a new durable revision even when the original request is old. Unverified RiskVault/protocol accounting remains explicit and does not produce a reimbursement notice.

When the holder designates another payout recipient, the holder receives the retirement notice and the recipient receives the cash notice from their own ledger credit. A completed designated-recipient payout never claims a credit to the holder. Missing final cash proof does not suppress an independently verified retired right.

`Option refund received` covers a verified ingress or excess-funding **individual claim**. It does not claim that an entire aborted purchase has unwound.

An owner-requested `OBAR` cancellation has separate `Option factory refund received` and `Option vault refund received` notices. Each requires the original exact funding and owner/position identity, historical cancellation proof, and its own actual recipient credit and completed cash journal. The factory-only path proves that custody never transferred. With proven vault custody, the canonical abort boundary carries explicit receipt hashes, exact tracked balances and nullable before/after buckets. A committed deposit requires its original receipt, released bucket amounts and unchanged tracked balance. A failed or unobserved deposit requires an explicitly absent receipt before abort, the expected tombstone afterward, the exact principal added to tracked balance and unchanged complete bucket state. Failed commits also require unchanged historical state; an unobserved commit retains only its actual dispatch evidence. Missing boundary fields never stand in for an orphan receipt. Each observed commit and abort binds its own historical transaction; unrelated intervening vault activity does not invalidate the position receipt. Vault cash requires a DELIVERED journal with accounting unapplied (0) becoming FINAL with accounting applied (1), alongside the physical credit and balance conservation. An independently completed leg can be notified while the other remains pending; for example, a 37-atomic factory return never describes the much larger vault return as delivered. Cancellation flags, released liabilities and an aggregate `completed` label without actual credits cannot produce a cash notice.

`Option purchase refund complete` requires every required return to have separately completed, with exact conservation of the original gross token funding. It does not promise network-fee repayment or RiskVault reimbursement; separate unverified protocol accounting remains stated in the notice. Each cash leg and full completion use distinct stable identities derived from the original funding and actual transfer identities. Later return evidence is discovered through durable revisions across cursors and worker replacement. Rebuilt projections preserve existing notification IDs and read state.

The required `unwind.trigger` distinguishes `owner_abort` from `initial_series_buy_bounced`. The bounded automatic path requires a failed transaction on the qualified Shout or Outperformance product with no position before or after, its actual emitted 288-bit bounce, and the exact factory recovery transaction. The consumer reconstructs the original assigned buy from the proven principal, checks the captured bounce prefix, and requires the factory wire index to clear while open notional and locked collateral decrease by the purchase amounts. It uses the factory recovery boundary as cancellation evidence; it does not invent an owner abort or a product cancel acknowledgement. Only the independently finalized full factory return produces cash and completion notices, described as a failed purchase. A later verified cash return creates new discovery evidence.

Other automatic NACK/bounce triggers, unreachable-product recovery, keeper/RiskVault paths, and unsupported lifecycle evidence remain unresolved without a generic success notice; new qualified evidence is processed when its revision is published. Producer fixtures are retained unchanged in `test/fixtures/option-*.json`; negative regressions remove or mismatch individual proof boundaries. The abort notification consumer covers the explicit initial-buy bounce and owner-requested factory-only, committed-custody and orphan-custody paths represented by these fixtures, including populated buckets and independently partial factory/vault cash. Canonical trigger and boundary fields are required; there is no older-format reader or all-protocol-aborts completeness claim.

Governance polling requires the updated indexer's `start_id` / `next_start_id` and explicit range/page coverage. That range is read from the current Voting contract's persisted monotonic proposal counter. Every allocated ID in a page must be present exactly once, and the next cursor must advance by the requested bounded range. All pages are scanned, a complete first cycle establishes the baseline, and subsequent new proposals/status changes link to `/earn/vote?proposal=<id>`. Unknown storage layouts or failed getters remain incomplete and retry; errors are never counted as absent proposals. Notice insertion and checkpoint advancement share one transaction fenced by the live job lease.

The worker processes public observations only. It does not claim global tax rules, infer final tax bills, upload local cost basis, or reconstruct unresolved protocol settlement. Operational launch still requires real provider credentials, verified deployed identities/paths, VAPID keys and browser/device checks.

SCCP burn/mint evidence produces wallet/protocol notices about the verified TON-local stage only. The principal and local fee evidence remain in the inbox record; the opposite-chain stage stays explicitly unverified. A TON burn is never presented as destination receipt or a completed bridge transfer.

## Primary protocol references

- [Frankfurter v2](https://frankfurter.dev/) — current/historical daily FX and expanded source observations.
- Explicit dated [CoinGecko historical data](https://docs.coingecko.com/reference/coins-id-history).
- [TON proof verification](https://docs.ton.org/applications/ton-connect/how-to/ton-proof).

### VAPID registration binding

API and worker startup verify that the configured canonical P-256 public and
private keys form one signing pair. A malformed scalar or mismatched pair fails
before push is advertised as available or users can register devices. Diagnostics
contain configuration names only. This local check does not prove provider
acceptance, correct contact details, or real browser delivery.

Every subscription and queued delivery carries the exact canonical, unpadded base64url P-256 `applicationServerKey` supplied by the browser’s `PushSubscription.options.applicationServerKey`. Enrollment and test delivery reject a different current service key with HTTP 409 `push_key_changed`; enrollment never assigns today’s key to an unverified browser endpoint. Device reads return the public binding with the endpoint fingerprint, without exposing endpoint URLs or encryption secrets.

The browser shows Enabled only after the browser, saved registration and current configuration keys agree. Refresh performs reads only. Renewal requires an explicit user gesture and may unsubscribe the old browser endpoint, subscribe with the current key, then register that actual binding. A config-read/POST rotation leaves setup incomplete and refreshes delivery settings; inbox and read state remain available.

The worker retires a proven old-key registration as `vapid_key_changed` before provider transport. Other HTTP 403 failures retain normal retries. Before and after sending, the worker verifies its lease and the exact captured registration identity, public key, wallet and network. A late response cannot stamp or retire a replacement registration. The inbox remains authoritative even when push cannot be sent.

This is the canonical first-release schema, including required `platform_subscriptions.application_server_key` and delivery payload key. There is no old-format reader, key inference, migration adapter or legacy signing-key ring. Deployment must initialize/qualify this schema before starting the matching API and workers; an old database is not made compatible by rerunning `CREATE TABLE IF NOT EXISTS`. Stop old-key workers before a coordinated key rotation; enroll affected devices again. This source update does not deploy, reset any live data or prove real OS delivery.

The binding follows [RFC 8292 sections 4.1–4.2](https://www.rfc-editor.org/rfc/rfc8292.html#section-4.2): a restricted subscription must use its registration key, and key replacement requires a new subscription.

### Wallet-event enrollment boundaries

The canonical fresh schema requires separate `activity_enabled_at` and `wallet_protocol_enabled_at` columns. Each false-to-true category transition records a new activation epoch; repeated enables and unrelated preference edits preserve it. Disabling clears that category’s epoch. Enrollment, preference updates and recurring job scheduling commit together, with consistent job-identity-before-preference locking. Advisory transaction locks protect recurring dedupe identities even before a job row exists; workers and enqueue use the same identity lock. No previous-format reader or timestamp inferred from `preferences.updated_at` is supported. This schema change is a coordinated API/worker deployment input, not an instruction to reset an existing database.

A first wallet scan uses the earliest active category epoch even after a delayed worker start. Inbox insertion checks the individual category epoch again, and queued push delivery checks it before transport, so a later category enable cannot admit older events from another category’s polling window. Re-enabling starts a new epoch and re-evaluates candidate revisions against each current category boundary. Activation and indexed transaction timestamps use whole seconds: events in the activation second are eligible; this does not establish millisecond ordering.

Ledger events remain anchored to original requests, while discovery order and notification stage time are explicit independent fields. The indexer atomically records a revision when an owner's published event evidence changes. Initial discovery includes publication at/after enrollment or canonical chain evidence reaching enrollment; every later revision is cursor-addressable even when its request and settlement timestamps are old. The worker uses the latest **required chain transaction for that particular qualified stage**, rejects future/contradictory/unbound time evidence, and retains both `requestOccurredAt` and `stageTransactions` in the inbox evidence alongside discovery revision/generation/publication time. A later payout cannot re-date an earlier engine booking or option-right retirement. Publication is never invented as a confirmation timestamp. Existing stable source-event keys preserve deduplication and read state across rebuilt owner projections.

The matching indexer fresh schema/API and platform worker must be released together. No old time-window reader or checkpoint adapter is provided. Missing discovery support fails visibly and retries while ordinary trading remains independent. This implementation neither resets a database nor enrolls devices. Real desktop and installed-iOS background delivery, production HTTPS origin/manifest/worker configuration and provider credentials remain separate release checks.

Focused regressions are `test/notificationDiscovery.test.ts` (actual indexer SQL and route through the notification worker/store), `test/notificationEvidence.test.ts`, `test/notificationEnrollmentBoundary.test.ts`, and the existing ledger, option and Launchpad worker suites. Historical synthetic fixtures used for present enrollment tests must move all physical transaction times by the same documented offset, preserving transaction order and time differences.

### Receita ordinary foreign-work conversion tables

Public `GET /v1/receita-work-rates?month=2025-06` returns the selected **receipt-month Compra** rate from Receita's official [2025](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/conversao/2025) or [2026](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/conversao/2026) table. `GET /v1/receita-work-rates/revisions/:id` returns its immutable original UTF-8 HTML, hash, source/year/month identity, fetch/expiry times and exact original Compra/Venda cells. The table already applies the previous-month statutory reference: callers select the actual receipt month without another shift. Compra is the selected work-income rate; this endpoint is not a PTAX trade-date, foreign-investment, deduction or arbitrary origin-currency converter.

`available`, `missing` (a blank monthly row) and `unavailable` (no valid source response) are distinct; missing rates remain null. Six-hour cached observations can be marked stale after refresh failure. Existing archived historical bytes remain available and locally replayable after cache expiry. Corrections append immutable revisions in the existing `platform_historical_fx_revisions` archive, using separate Receita source/method/request keys and existing mutation guards; no database migration or compatibility reader is added. Allow outbound HTTPS to `www.gov.br`; redirects are rejected, content is bounded and strictly decoded as UTF-8, and no credential is required. These public routes accept no wallet, taxpayer, journal or imported-record data. The browser worker shares the same pure parser and replays all derived fields and hashes before calculation; archived evidence is never rendered as HTML.

Run `npx vitest run test/receitaWorkRates.test.ts` for original 2025/2026 table, cache, immutable archive and route checks. The tests accept the existing isolated loopback `PLATFORM_TEST_DATABASE_URL` convention. Complete ordinary work-income classification, first legal receipt, any original non-USD authority conversion and report admission belong to the country executor; this rate provider alone does not complete Brazil or worldwide reporting.

### Notification delivery scope and destinations

Each delivery reads its inbox item by the mandatory notification ID, canonical wallet and network of the captured device. A corrupt outbox reference to another wallet or network completes without loading private notification content, contacting the provider, retrying, retiring the valid device or changing either inbox/read state. Existing lease and exact-registration fences still surround provider transport. `test/pushBinding.test.ts` exercises persisted corrupt references through real worker leasing and completion, including the same wallet on another network.

`src/notificationLinks.ts` defines the current app destinations: transactions open `/wallet?tx=<encoded opaque ID>`, price alerts open `/swap`, proposals open `/earn/vote?proposal=<uint64 ID>`, and notification proof/test events open `/settings/notifications`. The navigation contract regression imports the workspace frontend `../../../tonswap_web/routes.mjs` only during tests and fails if that manifest is absent or its destinations differ. Service typecheck/build/runtime remain independent of the frontend checkout. No obsolete route aliases or old inbox rewrites are provided.

Run `npx vitest run test/notificationLinks.test.ts test/pushBinding.test.ts test/governanceWorker.test.ts test/server.test.ts test/worker.test.ts` and `npm run typecheck` after changes to this boundary. The current scoped-delivery tests also support the owned loopback `PLATFORM_TEST_DATABASE_URL` convention. Provider transport remains mocked; these checks do not prove deployment, browser permission, OS background receipt, installed-iOS delivery or worldwide report readiness.
