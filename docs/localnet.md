# Localnet release indexer

The local release gate runs the same indexer code and registry contract as
testnet without permitting public TON fallback.

```bash
TON_NETWORK=localnet \
TON_DATASOURCE=lite \
LITESERVER_POOL_LOCALNET=/absolute/path/to/global.config.json \
INDEXER_REGISTRY_PATH=/absolute/path/to/localnet.registry.json \
INDEXER_RELEASE_MANIFEST_PATH=/absolute/path/to/localnet.manifest.json \
INDEXER_SERVICE_ID=tonswap-local-indexer \
INDEXER_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
INDEXER_ENABLE_WRITE_RPC=false \
npm run dev:localnet
```

The canonical manifest must use schema `tonswap-testnet-release-v1`, contain a
non-empty `releaseId`, a `network` of `localnet` (or `ton:localnet`), and a
non-empty `contracts` map. The registry must match that map exactly.
`registryHash` must equal SHA-256 of the key-sorted compact contract JSON
followed by a newline, and `manifestHash` must authenticate the recursively
key-sorted manifest with the `manifestHash` field omitted.

Readiness requires:

- `/health`, `/service-info`, and `/contracts` report `ton:localnet` identity.
- `/contracts` and `/service-info` expose the expected release and registry
  hashes.
- `/markets/{market}/candles` returns only confirmed swaps with real output
  amounts linked by swap query ID; `minOut` estimates are never accepted as
  execution prices, and market metadata must match the canonical manifest.
- Requests without configured local RPC/liteserver endpoints fail instead of
  discovering testnet or mainnet endpoints.

Run the parity-aware smoke after startup:

`MANIFEST_PATH` must resolve to the canonical, single-link retained manifest;
the CLI has no unbound mode.

```bash
TON_INDEXER_BASE_URL=http://127.0.0.1:8787 \
TON_INDEXER_EXPECTED_NETWORK=localnet \
TON_INDEXER_EXPECTED_SERVICE_ID=tonswap-local-indexer \
TON_INDEXER_EXPECTED_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
TON_INDEXER_EXPECTED_RELEASE_ID="$RELEASE_ID" \
TON_INDEXER_EXPECTED_REGISTRY_HASH="$REGISTRY_HASH" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH="$MANIFEST_HASH" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH="$MANIFEST_PATH" \
TON_INDEXER_EXPECTED_CORS_ORIGIN=http://127.0.0.1:5173 \
npm run smoke:production
```
