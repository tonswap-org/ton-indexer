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

## Configuration
Environment variables (all optional):
- `PORT` (default: `8787`)
- `HOST` (default: `0.0.0.0`)
- `TON_NETWORK` (`mainnet` | `testnet`, default: `mainnet`)
- `TON_DATASOURCE` (`http` | `lite`, default: `http`)
- `TON_HTTP_ENDPOINT` (explicit TonClient4 endpoint; if unset uses `@orbs-network/ton-access`)
- `LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` (lite client pool; see below)
- `CORS_ENABLED` (`true` to enable CORS headers; default `true`)
- `CORS_ALLOW_ORIGIN` (default: `*`, or set to `reflect` to echo request origin)
- `CORS_ALLOW_METHODS` (default: `GET,POST,OPTIONS`)
- `CORS_ALLOW_HEADERS` (default: `authorization,content-type`)
- `CORS_EXPOSE_HEADERS` (default: `x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset`)
- `CORS_MAX_AGE` (default: `600`)
- `SNAPSHOT_PATH` (path to load/save in-memory snapshot)
- `SNAPSHOT_ON_EXIT` (`true` to write snapshot on shutdown; default `false`)
- `ADMIN_ENABLED` (`true` to require admin auth on metrics/snapshot endpoints; default `false`)
- `ADMIN_TOKEN` (Bearer token for admin endpoints)
- `RATE_LIMIT_ENABLED` (`true` to enable simple per-IP rate limiting; default `true`)
- `RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `RATE_LIMIT_MAX` (default: `10000`)
- `RESPONSE_CACHE_ENABLED` (`true` to enable response caching; default `true`)
- `BALANCE_CACHE_TTL_MS` (default: `2000`)
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

If the requested `PORT` is already in use, the server will bind to the next available port and log the selected one.

## API
- `GET /api/indexer/v1/accounts/{addr}/balance`
- `GET /api/indexer/v1/accounts/{addr}/balances`
- `GET /api/indexer/v1/accounts/{addr}/assets` (alias of `/balances`)
- `GET /api/indexer/v1/accounts/{addr}/txs?page=1`
- `GET /api/indexer/v1/accounts/{addr}/state`
- `GET /api/indexer/v1/health`
- `GET /api/indexer/v1/metrics`
- `GET /api/indexer/v1/metrics/prometheus`
- `GET /api/indexer/v1/openapi.json`
- `GET /api/indexer/v1/docs`
- `POST /api/indexer/v1/snapshot/save`
- `POST /api/indexer/v1/snapshot/load`
- `GET /api/indexer/v1/debug?limit=100`

Admin endpoints (`/metrics/prometheus`, `/snapshot/*`) require `Authorization: Bearer $ADMIN_TOKEN` when `ADMIN_ENABLED=true`.
Debug endpoint also requires admin auth when enabled.

Optional tx cursor query params:
- `cursor_lt`
- `cursor_hash`

Metrics payload highlights:
- `request_stats`: count, avg, p50, p95, max (ms)
- `cache_stats`: balance/tx hit rates
- `backfill_*`: pending/inflight plus batch/tx counters

## Registry Sync
If you have `tonswap_tolk` checked out next to this repo, you can refresh testnet registry data:
```bash
npm run sync-registry
```

## Notes
- This implementation supports `TonClient4` (HTTP v4) with endpoint rotation and a native liteserver adapter (`ton-lite-client`).
- Jetton balances are fetched for registry keys ending with `Root` (e.g., `T3Root`, `TSRoot`, `UsdtRoot`), with metadata pulled from on-chain content and cached in memory.
- Swap/LP decoding is opcode-based and partial; it can extract basic amounts for `OP_SWAP`, `OP_ADD_LIQ`, `OP_INCREASE_POSITION`, and `OP_DECREASE_POSITION` payloads.

### Liteserver Pool Format
`LITESERVER_POOL_MAINNET` / `LITESERVER_POOL_TESTNET` can be one of:
- URL to a TON global config JSON (e.g., `https://ton.org/global.config.json`)
- Local path to a config JSON file
- Comma-separated `ip:port:pubkey` entries (pubkey is base64); ip can be dotted or integer
