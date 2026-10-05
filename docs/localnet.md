# Localnet release indexer

The local release gate runs the same indexer code and release manifest contract as
testnet without permitting public TON fallback.

```bash
TON_NETWORK=localnet \
TON_DATASOURCE=lite \
LITESERVER_POOL_LOCALNET=/absolute/path/to/global.config.json \
INDEXER_RELEASE_MANIFEST=/absolute/path/to/localnet.manifest.json \
INDEXER_SERVICE_ID=tonswap-local-indexer \
INDEXER_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
INDEXER_ENABLE_WRITE_RPC=false \
npm run dev:localnet
```

The canonical manifest must use schema `tonswap-release-v1`, a non-empty
`releaseId`, `network: "localnet"`, and a non-empty singleton `contracts` map of
exact address/codeHash objects. Its `manifestHash` authenticates the recursively
key-sorted content with that field omitted. All token roots, code pins and
product bindings come from this one input; there is no registry parity step.

`INDEXER_RELEASE_MANIFEST` may also be an HTTPS URL or loopback HTTP URL. The
supervisor polls every five seconds and stops the old child worker before
starting a changed release in a fresh process. Snapshot files and PostgreSQL
schemas are scoped to manifestHash, so prior jobs and snapshots cannot be loaded
under the new binding.

Readiness requires:

- `/health`, `/service-info`, and `/contracts` report `ton:localnet` identity.
- `/contracts` and `/service-info` expose the expected
  `release: { releaseId, manifestHash }`.
- `/markets/{market}/candles` returns only confirmed swaps with real output
  amounts linked by swap query ID; `minOut` estimates are never accepted as
  execution prices, and market metadata must match the canonical manifest.
- Requests without configured local RPC/liteserver endpoints fail instead of
  discovering testnet or mainnet endpoints.

Run the release-bound smoke after startup:

`MANIFEST_PATH` must resolve to the canonical, single-link retained manifest;
the CLI has no unbound mode.

```bash
TON_INDEXER_BASE_URL=http://127.0.0.1:8787 \
TON_INDEXER_EXPECTED_NETWORK=localnet \
TON_INDEXER_EXPECTED_SERVICE_ID=tonswap-local-indexer \
TON_INDEXER_EXPECTED_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
TON_INDEXER_EXPECTED_RELEASE_ID="$RELEASE_ID" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH="$MANIFEST_HASH" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH="$MANIFEST_PATH" \
TON_INDEXER_EXPECTED_CORS_ORIGIN=http://127.0.0.1:5173 \
npm run smoke:production
```

Native admission remains mandatory for any registered PerpsEngine. The current
reviewed runtime supports macOS arm64 testnet only; localnet must not invent a
perps binding or bypass that requirement. Configure all four admission artifact
path/hash values together for a supported deployment.
