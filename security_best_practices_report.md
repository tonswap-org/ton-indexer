# Security best practices report

Updated for the current release contract, 2026-10-13.

## Current model

Browser chain reads are public. Operational metrics, debug and snapshot routes require INDEXER_ADMIN_TOKEN and are blocked at the public proxy. The sole chain source is an operator-reviewed local liteserver pool with authenticated network identity, exact current account anchors, bounded deadlines/cancellation and typed failures. There is no external JSON-RPC forwarder or peer-discovery service. BOC submission is disabled by default; when explicitly enabled it performs one attempt through the same source without retry or hedging.

## Implemented boundaries

- One manifest supplies release identity, deployed addresses/code pins and public URL. Wrong or missing bindings cannot advertise release-bound fresh reads.
- Rate limits run in process. Only the matching X-TONSwap-Edge-Key plus a valid X-TONSwap-Client-IP choose a visitor identity; other requests use the raw socket. X-Forwarded-For is ignored. The limiter map is bounded, and the proxy adds no separate rate limit.
- Flat safe errors retain actual status, no-store and Retry-After for 429/503/504. Exception details and credentials never become public messages. CORS uses exact credentialed allowlists; wildcard/reflect mode does not grant credentials.
- Global security headers and nonce CSP protect the built-in docs. Snapshot destinations come from configuration, not request parameters; writes are serialized and skipped unless monitored capacity is ok.
- Qualified wallet/root identities and explicit unavailable rows prevent failure-to-zero balances. Display metadata never supplies accounting precision.
- Durable publication requires preserved account and resolved-binding inputs, immutable cursors and independently authenticated physical settlement evidence. Missing evidence remains unresolved; current getters and transfer requests cannot prove cash delivery.
- Logging, cache entries, request sharing and runtime metric series have bounded lifetimes/capacities. Dropped logs/series and source/database timings expose overload.

## Operational obligations

Use `config/nginx-indexer.conf` with the exact manifest mount and retained static error JSON; validate with nginx -t before installation. Configure edge-key secrecy, connection capacity across read/worker pools, disk floors, reviewed peers, PostgreSQL persistence/backups/TLS and the native admission package. Offline tests do not certify live archive availability, latency, disk headroom or economic release qualification. CI retains dependency audit on its host; this phase performs no registry audit and makes no current vulnerability-count claim.

Use a fresh canonical release database and keep old release state for rollback. Publish the new web before switching the indexer; rollback restores the old upstream/database while the web stays. Never remove release candidates, credentials, complete signing journals or capture evidence by age or path name.
