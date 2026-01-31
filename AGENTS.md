# AGENTS

## Overview
This repository contains a **TypeScript TONSWAP indexer service** plus the design/roadmap reference. The authoritative design and API contract still live in `roadmap.md`, but there is now runnable code in `src/`.

## Repo Structure
- `README.md`: setup, run, and API overview.
- `roadmap.md`: detailed architecture, API shape, storage model, and phased roadmap.
- `registry/mainnet.json`: **placeholder** addresses for mainnet contracts (must be replaced).
- `registry/testnet.json`: known testnet contract addresses.
- `src/`: TypeScript implementation (server, store, data source, workers, API).
- Snapshots: optional JSON snapshots for in-memory state are supported via `SNAPSHOT_PATH` + `SNAPSHOT_ON_EXIT`.

## What This Repo Is (and Isn’t)
- **Is**: a runnable indexer service with in-memory storage and background workers, plus registry data.
- **Isn’t**: a production-hardened indexer yet (liteserver pool adapter and full swap/LP decoding remain partial).

## Registry Conventions
- JSON keys are stable contract roles (e.g., `ClmmRouter`, `ClmmPoolFactory`).
- Keep key names consistent across networks.
- `registry/mainnet.json` is intentionally a placeholder; it should be replaced with real addresses before any mainnet usage.
- `registry/testnet.json` should be refreshed whenever testnet deployments change.

## Related Context (External Repos)
The roadmap references sibling repos for contract definitions and UI alignment:
- `../tonswap_tolk`: source of opcodes and contract addresses.
- `../tonswap_web`: UI expectations for tx history fields.

## Editing Guidance
- If you add implementation code, update `README.md` with build/run instructions.
- If you add new registries or configuration, document their purpose and update this file.
- Keep `roadmap.md` as the canonical design reference unless an implementation doc supersedes it.
