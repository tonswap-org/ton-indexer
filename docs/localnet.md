# Localnet release indexer

Localnet uses the same manifest contract and local liteserver source as testnet. Supply an absolute reviewed local global-config file or inline peer list; no public endpoint discovery or HTTP chain fallback exists.

```bash
TON_NETWORK=localnet \
LITESERVER_POOL_LOCALNET=/absolute/path/to/reviewed-global.config.json \
INDEXER_RELEASE_MANIFEST=/absolute/path/to/localnet.manifest.json \
INDEXER_ENABLE_WRITE_RPC=false \
npm run dev:localnet
```

The current `tonswap-release-v1` manifest authenticates network/globalId, release ID, exact singleton addresses/code hashes, templates, tokens, markets and `services.indexer`. The canonical manifest hash binds all these inputs. Service identity and public mount come only from that manifest. The manifest may be a retained local file, HTTPS URL or loopback HTTP URL; the pool itself must remain local configuration. A five-second manifest poll retires the old worker before starting changed bindings in a fresh process, with separate database/snapshot state.

The listener starts before chain, database and native authentication. Health must expose real component state and readiness must authenticate the compiled catalog and exact release. Missing peers, anchors or storage never produce successful empty evidence. A source-mode dev worker cannot claim authenticated compiled-ledger readiness. For a compiled durable worker, build first and use a fresh canonical database through exactly one of INDEXER_DATABASE_URL or INDEXER_DATABASE_URL_FILE. The `/ledger/readiness` qualification endpoint is restricted to the exact native testnet manifest (globalId -3); localnet must not claim that testnet qualification.

The public mount, network, release ID/hash, contracts and fresh-read context must match the manifest. Balance rows include GRAM and every manifest token with explicit status/precision; ledger incompleteness remains pending. Candle output requires actual successful token movements and exact market metadata, never minimum-output estimates.

Run release-bound smoke after startup. MANIFEST_PATH must be a canonical stable single-link retained file in a non-symlink, non-group/other-writable parent. With no transport override the manifest's URL is used; an optional TON_INDEXER_BASE_URL must have that exact mount.

```bash
TON_INDEXER_EXPECTED_NETWORK=localnet \
TON_INDEXER_EXPECTED_RELEASE_ID="$RELEASE_ID" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH="$MANIFEST_HASH" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH="$MANIFEST_PATH" \
TON_INDEXER_EXPECTED_CORS_ORIGIN=http://127.0.0.1:5173 \
npm run smoke:production
```

Current Perps uses pinned `readFresh` intake/funding getters and manifest-bound PxStorage. No retired OPEN/CLOSE worker package is required. Localnet remains distinct from public-consensus and deployed-release qualification. Gate-only native database tests use INDEXER_TEST_DATABASE_URL and an isolated loopback PostgreSQL server; they do not mutate the localnet application database.
