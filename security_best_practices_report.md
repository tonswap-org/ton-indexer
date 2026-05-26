# Security Best Practices Report

Date: 2026-05-26
Repository: `/Users/mtakemiya/dev/ton-indexer`

## Current Model

The service is a public decentralized read API used directly by `../tonswap_web`.
There is no privileged-user auth layer, no bearer-token gate, and no middleware requirement for browser clients.

Public routes include:
- TONSWAP account, balance, transaction, swap, state, stream, registry, health, docs, and OpenAPI endpoints.
- `/jsonRPC` and `/api/v2/jsonRPC` compatibility endpoints.
- `/api/indexer/v1/runGetMethod` and `/api/indexer/v1/runGetMethods`.
- Metrics, debug, and snapshot service routes when their backing services are registered.

Write JSON-RPC relay remains disabled by default. If `INDEXER_ENABLE_WRITE_RPC=true` is set, write relay methods are public by design and should only be enabled for deployments that intentionally provide that public relay.

## Remediation Status

Implemented in this worktree:
- Removed the bearer-token route gate and related configuration.
- Removed privileged-token startup validation, tests, OpenAPI security schemes, and docs token UI.
- Kept decentralized read routes public for `../tonswap_web`.
- Kept route-level getter timeouts and sanitized public error responses.
- Added global security headers and nonce-based CSP on the built-in docs page.
- Replaced credentialed CORS reflection with exact-origin allowlisting via `CORS_ALLOW_ORIGINS`; `reflect` behaves as wildcard without credentials.
- Added a dependency override so transitive `ws` resolves to `8.21.0`; `npm audit --omit=dev` reports zero vulnerabilities.

## Remaining Public-Service Risks

- Public getter/RPC routes can consume upstream TON provider capacity. Mitigate with rate limits, caching, bounded concurrency, and deployment-level capacity planning.
- Public metrics/debug/snapshot routes can expose operational state if their backing services are registered. Disable those services or block those paths at the deployment layer if the deployment should not expose them.
- Public write relay is intentionally off by default. Enabling it makes the service a public relay.

## Positive Observations

- Mainnet placeholder registry addresses fail startup in production mainnet mode.
- Write JSON-RPC methods are disabled by default.
- Address, cursor, and numeric query parameters are validated before use.
- Snapshot paths are configured through environment variables, not request parameters.
- In-memory caches and stored transaction counts are bounded.
