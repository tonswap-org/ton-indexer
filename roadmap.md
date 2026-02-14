# TONSWAP Indexer Roadmap

## Design (v1)

### Goals
- Fast balance and tx history for TONSWAP UI (sub-100ms cache hits).
- Confirmed-only data (no unconfirmed state).
- Any address lookup with pagination (10 txs/page).
- Typed txs (swap, lp_deposit, lp_withdraw, transfer, contract_call).
- Match `tonswap_web` wallet history expectations (`txId`, `txType`, `detail`).

### Constraints / Assumptions
- No self-hosted full/archive node.
- Primary data source is public liteservers (variable latency, limited history).
- Local storage budget: target <= 50GB (should be configurable lower).
- Full history may not be available for some addresses; expose that status in API.
- **Chosen for v1**: memory-only storage (no persistent DB).
- Memory-only is volatile (history lost on restart; `total_pages` unknown until re-backfill).
- Support mainnet and testnet; default is mainnet unless explicitly flagged.

### Persistence Modes
- **Memory-only (selected for v1)**:
  - Fast, simple, zero disk.
  - Loses history on restart; `total_pages` becomes unknown until re-backfill.
  - Requires aggressive in-memory caps and eviction.
- **SQLite (future option)**:
  - Small, local file-based DB; no server.
  - Enables stable `total_pages` and backfill completion across restarts.
  - Reduces repeated backfill load on public liteservers.

### Network Selection
- Default: **testnet** (current TONSWAP deployments).
- Mainnet mode is supported, but requires real registry/mainnet addresses.
  - Configuration example:
    - `TON_NETWORK=mainnet|testnet` (default `testnet`)
    - `LITESERVER_POOL_MAINNET=...` (set after mainnet deploy)
    - `LITESERVER_POOL_TESTNET=127.0.0.1:PORT` (localhost liteserver)

### High-Level Architecture
- **Lite client adapter**: queries a pool of public liteservers.
- **Indexing core**:
  - **Hot watchlist updater**: every new masterchain block, refresh balances/txs for watched addresses.
  - **On-demand backfill**: when an address is first requested, fetch recent txs immediately, then backfill older history in background if possible.
- **Memory-only state**:
  - In-process maps for accounts, jettons, txs, page index, and stats.
  - LRU/TTL eviction to cap memory.
  - No full rescan while online; incremental updates per block.
- **Storage (v1)**:
  - Memory-only maps + in-process LRU/TTL eviction.
- **Storage (future)**:
  - Optional SQLite for persistence across restarts.
- **API service**: read-through cache; never hits chain on request path unless cache miss.

### API Design (fixed page size = 10)

#### GET /api/indexer/v1/accounts/{addr}/balance
Response:
- `ton.balance`, `ton.last_tx_lt`, `ton.last_tx_hash`
- `jettons[]` (master, wallet, balance, decimals, symbol)
- `confirmed=true`, `updated_at`
- `network` (`mainnet` | `testnet`)

#### GET /api/indexer/v1/accounts/{addr}/txs?page=1
Response:
- `page`, `page_size=10`
- `total_txs` (known count)
- `total_pages` (null if history incomplete)
- `total_pages_min` (lower bound)
- `history_complete` (boolean)
- `txs[]` (typed; includes both `kind/actions` and UI-ready fields)
- `network` (`mainnet` | `testnet`)

##### txs[] entry (UI-ready)
- `txId = "{lt}:{hash}"`
- `utime`, `status`, `reason`
- `txType` (human label)
- `inSource`, `inValue`, `outCount`
- `detail` (swap/lp/mint union)
- `kind`, `actions[]` (optional debug/extended)

### TONSWAP Web Alignment
- Use `txId = "{lt}:{hash}"` (matches existing UI parsing).
- Provide `WalletHistoryEntry`-like fields so UI can skip client-side parsing:
  - `txType`, `status`, `reason`, `inSource`, `inValue`, `outCount`, `detail`.
- `detail` mirrors UI unions:
  - `swap` -> `{ kind: 'swap', payToken, receiveToken, payAmount, receiveAmount }`
  - `lp` -> `{ kind: 'lp', pair, tokenA, tokenB, amountA, amountB }`
  - `mint` -> `{ kind: 'mint', mode, inputToken, outputToken, inputAmount, outputAmount }`
- Derive `status` using the same logic as `../tonswap_web/services/toncenter.ts#getTransactionStatus`.

#### GET /api/indexer/v1/accounts/{addr}/state
- Combined balance + last_tx + last_seen_utime + last_confirmed_seqno

#### GET /api/indexer/v1/health
- `last_master_seqno`, `indexer_lag_sec`, `liteserver_pool_status`

### Typed Transaction Model
- `kind` enum: `swap | lp_deposit | lp_withdraw | transfer | contract_call | unknown`
- `actions[]` includes typed payload:
  - `swap`: pool, token_in/out, amounts, min_out, sender
  - `lp_deposit`: pool, token amounts, lp_minted
  - `lp_withdraw`: pool, lp_burned, token amounts
  - `transfer`: asset (ton/jetton), amount, from/to
- Decode based on TONSWAP router/pool/LP contracts (address or code hash registry).
- Fallback: classify standard Jetton transfer; else `contract_call`.

### Contract Registry / Opcodes (from `../tonswap_tolk`)
- Contract addresses loaded from:
  - `registry/mainnet.json` (mainnet default).
  - `registry/testnet.json` (testnet runs).
  - `../tonswap_tolk/tmp_debug/module_addresses.json` (dev/testnet sync source).
  - `../tonswap_tolk/tmp_debug/dlmm.*.address` (if DLMM pools are used).
- Opcode map loaded from `../tonswap_tolk/config/opcodes.json`:
  - `contracts/clmm/pool.tolk` → `OP_SWAP`, `OP_ADD_LIQ`, `OP_REMOVE_LIQ`, etc.
  - `contracts/clmm/router.tolk` → router ops and jetton notify opcode.
- Allow override via config for mainnet/testnet differences.
  - Note: `registry/mainnet.json` is a placeholder and must be filled with real mainnet addresses.
  - Note: `registry/testnet.json` should be refreshed after new testnet deployments.

### Pagination Strategy (page numbers)
- Store `txs` ordered by `(address, lt desc, hash desc)`.
- Create `page_index` with one row per page (every 10th tx):
  - `(address, page, lt, hash)`.
- To serve page N:
  1) Lookup `(lt, hash)` in `page_index`.
  2) Query 10 txs from `txs` with `(lt, hash) <= cursor`.
- `total_pages` only when `history_complete=true`.

### Storage Schema (memory-only structures)
- `accounts`: map keyed by address with balance + last tx pointer.
- `jetton_balances`: map keyed by (owner, master).
- `txs`: per-address list ordered by `(lt desc, hash desc)` capped by max pages.
- `page_index`: per-address page cursor array (every 10th tx).
- `account_stats`: per-address `{ tx_count, history_complete, last_backfill_lt }`.
- `watchlist`: per-address `{ last_request_at, last_update_seqno }`.

### In-Memory Limits (defaults)
- `PAGE_SIZE = 10`
- `MAX_PAGES_PER_ADDRESS = 150` (keeps 1,500 txs per address in memory)
- `MAX_ADDRESSES = 5_000`
- `IDLE_TTL_MS = 2 hours` (evict idle addresses + history)
- `GLOBAL_MAX_PAGES = 200_000` (global LRU cap across all addresses)
  - Evict coldest pages first; refetch on demand if user navigates deep history.

### Worker Flow (memory-only)
- **Request path**:
  - `/balance`: if cached -> return. If missing -> fetch account state, cache, add to watchlist.
  - `/txs?page=N`: if cached page exists -> return. If missing -> fetch recent txs, cache, start backfill.
- **Backfill worker**:
  - Walk `getTransactions` using `(lt, hash)` cursor.
  - Append txs and page_index until no older data or limit reached.
  - Update `total_txs`, `total_pages_min`, and `history_complete` when exhausted.
- **Block follower**:
  - Poll masterchain head every block.
  - For each new block, update only watchlist addresses.
  - Merge new txs to front, update `page_index`, adjust counts.
- **Restart behavior**:
  - In-memory state wiped; `history_complete=false` until re-backfill.

### Freshness Model
- Confirmed-only updates every masterchain block (~5s).
- Hot watchlist addresses updated continuously.
- Cold addresses fetched on-demand, then optionally backfilled.

### Memory Control
- Only store addresses that have been requested.
- TTL for inactive addresses (e.g., 30–90 days).
- Keep only last N pages per address.

---

## Roadmap / Tasks

### Phase 0 — Decisions & Specs
- [ ] Collect TONSWAP contract registry (router/pool/LP addresses or code hashes) from `../tonswap_tolk` (testnet synced; mainnet pending deploy outputs).
- [x] Decide persistence: **memory-only** (history lost on restart).
- [x] Decide cache: Redis vs in-process LRU (start in-process if disk is tight).
- [x] Finalize API response shapes to match `tonswap_web` types.
- [x] Define network config flags (mainnet default, testnet optional).
- [x] Create `registry/mainnet.json` and `registry/testnet.json` (testnet mirrors `../tonswap_tolk/tmp_debug/module_addresses.json` + token roots).
- [x] Add a sync note/script to refresh `registry/testnet.json` after redeploys.

### Phase 1 — Core Ingestion (MVP)
- [x] Implement lite client adapter with liteserver pool + retry/backoff.
- [x] Build block follower (masterchain polling + shard enumeration).
- [x] Parse txs and store basic fields + balance updates.
- [x] Implement watchlist refresh on each confirmed block.
- [x] Build in-memory store + eviction (max pages/address, TTL for idle addresses).

### Phase 2 — Typed Tx Classification
- [x] Implement TONSWAP ABI decoding for swap/add/remove liquidity.
- [x] Implement Jetton transfer detection (standard opcode).
- [x] Store `kind` + `actions_json` for each tx.
- [x] Add tests with sample TONSWAP txs.
- [x] Map decoded ops to `WalletHistoryEntry.detail` fields for UI.
- [x] Reuse `getTransactionStatus` logic from `tonswap_web` for status mapping.
- [x] Track pool addresses (seed from registry, then expand via ClmmPoolFactory deploy events).

### Phase 3 — Pagination + Backfill
- [x] Implement on-demand backfill worker per address.
- [x] Build `page_index` while backfilling (every 10th tx).
- [x] Track `history_complete` and `total_pages_min`.
- [x] API: `/txs?page=N` using `page_index`.

### Phase 4 — Caching & Performance
- [x] Read-through cache for `/balance` and `/txs`.
- [x] Add LRU/TTL for hot addresses and recent txs (memory-only caps).

### Phase 5 — Ops & UX
- [x] `/health` endpoint with indexer lag and liteserver status.
- [x] Metrics: request p95, lag, backfill backlog.
- [x] Background eviction for stale addresses (optional).

### Phase 6 — Integration
- [x] Wire API into `../tonswap_web` UI.
- [x] Replace client-side parsing with server-provided `WalletHistoryEntry` fields.
- [x] Add UI handling for `history_complete=false` and `total_pages_min`.
- [x] UX: show “History syncing…” until backfill completes.
