# TI Production Deployment

This service is the TON indexer backing `https://ti.soramitsu.io`.

## Required Public Contract

- `GET /api/indexer/v1/health` must return a healthy TON indexer response.
- `GET /api/indexer/v1/service-info` must identify `ti.soramitsu.io`, `ton`,
  and `ton:mainnet`.
- `GET /api/indexer/v1/openapi.json` must expose the TONSWAP Indexer API contract.
- Wallet read endpoints must stay publicly reachable:
  - `/api/indexer/v1/accounts/{addr}/balance`
  - `/api/indexer/v1/accounts/{addr}/balances`
  - `/api/indexer/v1/accounts/{addr}/assets`
  - `/api/indexer/v1/accounts/{addr}/txs`
  - `/api/indexer/v1/accounts/{addr}/state`
  - `/api/indexer/v1/markets/{market}/candles`
  - `/api/indexer/v1/runGetMethod`
  - `/api/indexer/v1/runGetMethods`
- Public write RPC must stay disabled unless an explicit release decision enables it.

## Release Manifest Gate

Every startup requires `INDEXER_RELEASE_MANIFEST`, a reviewed native-deployer
`tonswap-release-v1` file path or HTTPS URL. Loopback HTTP is allowed for local
runs. Network/globalId, singleton addresses, approved code hashes and the
manifest's canonical SHA-256 content hash must validate. No bundled registry or
secondary ledger pin source is used.

The supervisor polls the configured source every five seconds. A changed hash
stops the old child worker before starting a fresh process. Snapshot files and
PostgreSQL schemas are scoped to that manifest hash, preserving previous
releases while preventing old jobs or cached state from using new bindings.
`/contracts` and `/service-info` expose `release: { releaseId, manifestHash }`.

## Recommended Environment

```sh
INDEXER_MODE=production
TON_NETWORK=mainnet
INDEXER_RELEASE_MANIFEST=/absolute/path/to/mainnet.manifest.json
TON_DATASOURCE=lite
LITESERVER_POOL_MAINNET=https://ton.org/global.config.json
HOST=0.0.0.0
PORT=8787
TRUST_PROXY=true
CORS_ENABLED=true
CORS_ALLOW_ORIGIN=*
RATE_LIMIT_ENABLED=true
RESPONSE_CACHE_ENABLED=true
INDEXER_ENABLE_WRITE_RPC=false
LOG_LEVEL=info
```

Set `SNAPSHOT_PATH` to a durable snapshot prefix and keep
`SNAPSHOT_AUTOSAVE_ENABLED=true` when warm restart is needed. The actual filename
includes the manifest hash. Set `INDEXER_DATABASE_URL` for the durable ledger;
its release schema must not fall back to tables from another release.

## Container Contract

Build the production image from this repo root:

```sh
docker build -t ti-indexer:release .
```

Run the image with explicit mainnet settings and route
`https://ti.soramitsu.io` to port `8787`:

```sh
docker run --rm -p 8787:8787 \
  -e INDEXER_MODE=production \
  -e TON_NETWORK=mainnet \
  --mount type=bind,src=/absolute/path/to/mainnet.manifest.json,dst=/release/manifest.json,readonly \
  -e INDEXER_RELEASE_MANIFEST=/release/manifest.json \
  -e TON_DATASOURCE=lite \
  -e LITESERVER_POOL_MAINNET=https://ton.org/global.config.json \
  -e INDEXER_ENABLE_WRITE_RPC=false \
  ti-indexer:release
```

The checked-in `Dockerfile` defaults to production mainnet settings. Supply a
manifest for that network before starting it. For the testnet release, override
`TON_NETWORK=testnet`, set
`LITESERVER_POOL_TESTNET=https://ton.org/testnet-global.config.json`, and provide
the testnet manifest through `INDEXER_RELEASE_MANIFEST`. Keep
`INDEXER_ENABLE_WRITE_RPC=false`.

A registered PerpsEngine requires the reviewed native admission package on
macOS arm64 and testnet. Configure all four `PERPS_ADMISSION_BINARY_PATH`,
`PERPS_ADMISSION_BINARY_SHA256`, `PERPS_ADMISSION_CONFIG_PATH` and
`PERPS_ADMISSION_CONFIG_SHA256` values together. Startup authenticates the chain,
fresh exact-block engine state and manifest-approved engine code before
readiness. The generic Linux Docker image does not contain this package and
cannot serve a registered perps engine. Do not replace native admission with
remote getters or cached responses.

## Preflight

Run before promoting a `master` build:

```sh
npm ci
npm test
npm run build
```

Test the manifest source, restart isolation and missing/wrong-network input
failures before starting the deployment. The live service must authenticate its
configured chain and admission runtime before becoming ready.

## Smoke Checks

After deployment routing is updated and the full release-bound environment
shown below has been exported:

```sh
TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production
curl -fsS https://ti.soramitsu.io/api/indexer/v1/health
curl -fsS https://ti.soramitsu.io/api/indexer/v1/service-info
curl -fsS https://ti.soramitsu.io/api/indexer/v1/openapi.json
curl -fsS https://ti.soramitsu.io/api/indexer/v1/contracts
```

For testnet, bind the smoke to the exact release:

```sh
TON_INDEXER_BASE_URL=https://ti.soramitsu.io \
TON_INDEXER_EXPECTED_NETWORK=testnet \
TON_INDEXER_EXPECTED_RELEASE_ID="$RELEASE_ID" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH="$MANIFEST_HASH" \
TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH="$MANIFEST_PATH" \
TON_INDEXER_EXPECTED_CORS_ORIGIN=https://test.tonswap.org \
npm run smoke:production
```

`MANIFEST_PATH` must be the canonical absolute path to the retained certified
single-link regular manifest; aliases and unsafe writable modes are rejected.
The release-bound smoke verifies its canonical hash, the public
`release: { releaseId, manifestHash }`, manifest-derived contract and market
identities, confirmed market history, production CORS allowlisting (including
POST preflight), and hostile-origin denial. The manifest does not contain the certified candle
transaction IDs or time windows, so their exact release-proof binding remains
the canonical release wrapper's responsibility.

The smoke command validates service and release identity, OpenAPI shape,
required wallet routes, and the write-RPC posture. Verify service info reports
`serviceId = ti.soramitsu.io`, OpenAPI title is `TONSWAP Indexer API`, and write
RPC remains disabled unless the release explicitly requires otherwise.

Deployment evidence is tracked in
`scripts/production-deployment-evidence.json`. Keep it blocked until the Docker
image digest, deployment ID, tagged commit, exact smoke command, operator, and
UTC smoke timestamp are recorded together with the production
`/api/indexer/v1/service-info` identity payload observed by the smoke check, and
`npm run audit:deployment-evidence -- --require-ready` passes.
Generate a fill-in-ready evidence template before recording the live result:

```sh
npm run test:deployment-evidence-template
npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json
```

The offline evidence audit validates the recorded image, deployment and smoke
result without loading contract-address files. Live smoke verifies the actual
manifest-derived public identities; retained historical blockers are not a
second runtime configuration source.
