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
  - `/api/indexer/v1/runGetMethod`
  - `/api/indexer/v1/runGetMethods`
- Public write RPC must stay disabled unless an explicit release decision enables it.

## Mainnet Gate

`TON_NETWORK=mainnet` in `INDEXER_MODE=production` is intentionally blocked until
`registry/mainnet.json` contains real deployed TON contract addresses.

The startup guard rejects:

- Missing required registry keys.
- Values beginning with `REPLACE_WITH_MAINNET_`.
- Values that do not look like TON base64 or raw addresses.

Do not replace placeholders with guessed addresses. Mainnet values must come from
the contract deployment owner and be reviewed before release.

## Recommended Environment

```sh
INDEXER_MODE=production
TON_NETWORK=mainnet
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

Set `SNAPSHOT_PATH` and keep `SNAPSHOT_AUTOSAVE_ENABLED=true` when the deployment
needs warm restart behavior.

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
  -e TON_DATASOURCE=lite \
  -e LITESERVER_POOL_MAINNET=https://ton.org/global.config.json \
  -e INDEXER_ENABLE_WRITE_RPC=false \
  ti-indexer:release
```

The checked-in `Dockerfile` defaults to those production values. It is expected
to fail startup while `registry/mainnet.json` still contains placeholders; that
failure is the release guard, not a container failure.

## Preflight

Run before promoting a `master` build:

```sh
npm ci
npm test
npm run build
INDEXER_MODE=production TON_NETWORK=mainnet npm test
```

The final command does not start the server; it ensures the mainnet registry
guard remains part of the test suite. Actual startup with `TON_NETWORK=mainnet`
will fail until `registry/mainnet.json` is populated.

## Smoke Checks

After deployment routing is updated:

```sh
TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production
curl -fsS https://ti.soramitsu.io/api/indexer/v1/health
curl -fsS https://ti.soramitsu.io/api/indexer/v1/service-info
curl -fsS https://ti.soramitsu.io/api/indexer/v1/openapi.json
curl -fsS https://ti.soramitsu.io/api/indexer/v1/contracts
```

The smoke command validates service identity, OpenAPI shape, required wallet
routes, and the write-RPC posture. Verify service info reports
`serviceId = ti.soramitsu.io`, OpenAPI title is `TONSWAP Indexer API`, and write
RPC remains disabled unless the release explicitly requires otherwise.

Deployment evidence is tracked in
`scripts/production-deployment-evidence.json`. Keep it blocked until the Docker
image digest, deployment ID, tagged commit, exact smoke command, operator, and
UTC smoke timestamp are recorded and
`npm run audit:deployment-evidence -- --require-ready` passes.
Generate a fill-in-ready evidence template before recording the live result:

```sh
npm run test:deployment-evidence-template
npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json
```

The ready deployment-evidence audit also inspects `registry/mainnet.json`.
Readiness is rejected while required mainnet keys are missing, values still use
`REPLACE_WITH_MAINNET_` placeholders, values are malformed TON addresses, or
the manifest still carries the stale `mainnet-registry-placeholders-remain`
blocker after the registry is fixed.
