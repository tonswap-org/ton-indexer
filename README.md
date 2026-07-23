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

## Build + Run
```bash
npm run build
npm run start
```

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
not another indexer service.

## Configuration
Environment variables (all optional):
- `PORT` (default: `8787`)
- `HOST` (default: `127.0.0.1`)
- `TRUST_PROXY` / `FASTIFY_TRUST_PROXY` (`true` only when the service is behind a trusted proxy)
- `INDEXER_MODE` (`dev` | `production`, default: `dev`)
- `TON_NETWORK` (`mainnet` | `testnet`, default: `testnet`)
- `TON_DATASOURCE` (`http` | `lite`, default: `http`)
- `TON_HTTP_ENDPOINT` (explicit TonClient4 endpoint; if unset uses `@orbs-network/ton-access`)
- `INDEXER_WRITE_RPC_ENDPOINT` (optional upstream JSON-RPC endpoint for proxying write methods)
- `INDEXER_ENABLE_WRITE_RPC` (`true` to allow proxied write methods; default `false`)
- `INDEXER_WRITE_RPC_API_KEY` (optional API key passed as `X-API-Key` to `INDEXER_WRITE_RPC_ENDPOINT`)
- `INDEXER_RPC_PROXY_TIMEOUT_MS` (default: `30000`)
- `LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` (lite client pool; see below)
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
- `GET /api/indexer/v1/accounts/{addr}/state`
- `GET /api/indexer/v1/sccp/ton/burn-proof-material?jetton_master={addr}&message_id=0x...`
- `GET /api/indexer/v1/perps/{engine}/snapshot?market_ids=1,2&max_markets=64`
- `GET /api/indexer/v1/vol-index/{vol_index}/snapshot?pool={pool}&route_ids={job_ids}`
- `GET /api/indexer/v1/governance/{voting}/snapshot?owner={addr}&max_scan=20&max_misses=2`
- `GET /api/indexer/v1/farms/{factory}/snapshot?max_scan=20&max_misses=2`
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

## Notes
- This implementation supports `TonClient4` (HTTP v4) with endpoint rotation and a native liteserver adapter (`ton-lite-client`).
- `/api/indexer/v1/sccp/ton/burn-proof-material` can omit `trusted_checkpoint_seqno/hash`; when omitted, the indexer resolves the current SORA-governed TON checkpoint automatically via `SORA_RPC_HTTP_ENDPOINT` or the static checkpoint override env vars.
- Jetton balances are fetched for registry keys ending with `Root` (e.g., `T3Root`, `TSRoot`, `UsdtRoot`), with metadata pulled from on-chain content and cached in memory.
- Swap/LP decoding is opcode-based and extracts DLMM swap/add-liquidity intent from Jetton transfer forward payloads (`SWAP`, `DLAD`) where available.
- Swap classifier now also decodes optional execution hints from swap `queryId` (market/limit/twap, optional twap slice/total, and optional token symbol codes) and returns them in both `detail` and `actions` for `kind: "swap"` tx entries.
- Swap hint decoding also exposes `querySequence` + `queryNonce` (from queryId metadata) so clients can group TWAP slices by run.
- `/accounts/{addr}/swaps` provides a chart-friendly swap execution feed with server-side filters for pair direction, execution type, status, and optional `from_utime` / `to_utime` time windows.
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
`LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` can be one of:
- URL to a TON global config JSON
  - mainnet: `https://ton.org/global.config.json`
  - testnet: `https://ton.org/testnet-global.config.json`
- Local path to a config JSON file
- Comma-separated `ip:port:pubkey` entries (pubkey is base64); ip can be dotted or integer
