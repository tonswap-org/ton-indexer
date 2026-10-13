# Verified native admission source

This directory maintains the native admission changes as a small patch and source overlay on official TON. `source-lock.json` pins the exact upstream commit, recursive submodule identities, four original and modified files, and all 23 added source/test/fixture files. It contains no compiled worker or private configuration. The indexer uses this worker for explicit proof-verified admission; it has no remote-getter fallback or older business ABI branch.

The supported deployment is macOS arm64, minimum macOS13. The worker uses the official tonlib signature-chain verifier, exact same-master account/config proofs, official getter context, fixed hard1,000,000 gas, and bounded persistent processes. See `overlay/tonlib/ADMISSION.md` for the implementation boundaries and limits. That file retains the original qualification-stage description; current release qualification receipts are separate authorities.

## Prepare and inspect the dependency

Use a fresh private checkout of `https://github.com/ton-blockchain/ton.git`, detached at the lock's exact commit. Initialize only the submodules marked `initialized: true`, at their pinned commits; the disabled optional dependencies remain uninitialized. Do not replace this pin with a tag, branch, latest network head, installed binary, or library found on PATH.

Before applying changes, require a clean checkout and exact upstream and submodule identities. Apply `patches/verified-admission.patch` with `git apply --check`, then `git apply`, and copy each file from `overlay` to an absent path. Do not overwrite existing upstream files with the overlay. Run:

```sh
node native/verify-source.cjs /absolute/prepared-ton-source
node --test native/verify-source.test.cjs
```

The read-only inspector checks exact patch and overlay bytes, official original blobs, all27 resulting source hashes, complete tracked/untracked delta, initialized submodule content and every recursive commit. It rejects source aliases, hardlinks, traversal, unexpected files, dirty submodules and missing fixtures. Its result is source inspection, not a build or live-execution qualification. Full release source inventory must additionally include every actual source, generated import, dependency and toolchain input.

## Build and qualify

Use a fresh out-of-source build directory and the reviewed pinned toolchain: CMake3.31.10, Ninja1.13.0, Apple clang, SDK26.5. Record the actual executable/toolchain hashes, not just their version strings. Use the exact CMake definitions and target list in the lock. The source patch adds Apple-only `ton-admission-worker` installation and `test-verified-admission`. Build both targets and run the actual test binary; its18 groups cover authenticated OPEN/CLOSE decisions, exact state and context binding, malformed proofs and inputs, readiness refresh and deadline boundaries, opcode initialization and an ACCEPT-resistant hard gas ceiling. Tests use adjacent immutable BOC fixtures and need no network.

Inspect the final Mach-O binary for arm64/minOS13 and only the system C++ and System dylibs. Retain the generated build graph, compiler/linker inputs, full source inventory, build/test logs, binary digest and dependency output. A single successful build does not establish byte reproducibility across toolchains.

Qualification also requires actual authenticated startup and warm two-worker execution with precise proofs, c7, arguments, gas and output. Cold startup shares at most three rounds across network failures and authenticated past-stale readiness. Each refresh reuses the same LastBlock trust state and obtains a new verified sync, exact header and exact account; future/missing/inconsistent clocks, proof/identity/code failures remain terminal. The 30-second age and three-second future-skew bounds are unchanged, and private numeric readiness diagnostics expose both authenticated ages. Cold startup is bounded at600s total/120s without validated progress; parent startup610s and publication health gate650s. Public requests have one attempt within5s. Do not use a stale historical payload as positive live acceptance. The retained ba7 engine fixture proves that historical engine only; a new generation needs explicit qualification against its own code/address and current ABI.

## Qualify and install the separate native runtime

Native qualification and installation are separate from the current deployer's JavaScript ledger qualification. The current deployer has no native admission artifact loader. Retain an immutable native package and explicit source review, toolchain/build/test evidence, binary/configuration hashes and current live readiness/execution qualification. An existing binary or a prior-generation receipt does not qualify changed native source.

The reviewed TON service cutover must bind the exact native package path and all four `PERPS_ADMISSION_BINARY_PATH`, `PERPS_ADMISSION_BINARY_SHA256`, `PERPS_ADMISSION_CONFIG_PATH` and `PERPS_ADMISSION_CONFIG_SHA256` values alongside the indexer source/build identity. Use a new immutable native package path for changed binaries; preserve earlier packages and operational evidence. Missing or mismatched native pins must fail closed when the release requires perps admission. The ordinary indexer clean build does not install this separate native runtime. Nothing in this directory authorizes a chain transaction, signer, service cutover, trust-anchor change, fallback or different gas budget.
