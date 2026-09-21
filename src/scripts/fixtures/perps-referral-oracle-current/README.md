# Current referral-release Perps oracle evidence

Generated from the actual production Tolk runtime on 2026-09-14. These are local sandbox executions and exact storage boundaries, not live-chain deployment evidence. Every transaction uses its original `t.raw.toBoc()` bytes and retains its original account hash links.

Engine Cell hash: `bb7bcc111b713fa135302805b83299b4d43088c4bb7c24daadcc38a7e240660a`.

Regenerate the 13 execution traces with `TONSWAP_PERPS_EXECUTION_FIXTURE_DIR=../output/referral-first-release/perps-oracle-current npx jest tests/perps/PerpsOracleRefresh.spec.ts --runInBand` in `tonswap_tolk`. The independent funding getter fixture is exported by `PerpsEngineFunding.spec.ts` test `retains fractional funding through a zero rate and offsets an opposite rate exactly`. All 23 oracle tests and the focused funding test passed.

The source-qualified referral outbox and the wallet's permanent mint/funding notification dictionaries are mandatory. The previous `perps-oracle-execution` files remain unchanged; the active tests read this directory. `close-bad-debt-accepted` labels its adversarial initial state; it does not fabricate prior trading history. `open-accepted-excess` proves the exact 113 atomic refund while its treasury liability remains queued.

Run `npx tsx src/scripts/ledger-perps-oracle-execution-test.ts` and `npx tsx src/scripts/perps-oracle-state-test.ts`, or `npm run test:ledger`.

| File | SHA-256 |
| --- | --- |
| `close-accepted.json` | `e0fde4bec858dfbbbce6bb28eab5547c9353979b4736f59dd1a45e19c5cf826f` |
| `close-bad-debt-accepted.json` | `492ef6127b47645f7966ff5045ae7f66251898bb6768444056f77cfb32b82cd0` |
| `close-intake-rejected.json` | `008a90a43a8616069537737bf893d2c0ffc9671be5ab946d97ed8441e619c7e7` |
| `close-rejected.json` | `77c3b39a7de98b56e4e5ec0bf00e0a3296f94bb302a9c3039b6b1dbfdabf96fa` |
| `funding-remainder-current.json` | `fd490b0f2220a4773928c412622973c8a1a79b1beafb04de01bf56d50bc20fef` |
| `open-accepted-excess.json` | `d85e43c0b67bbfeaaa0a4f4fb3892bdded0ef46735bdff7f58eaf385248ba540` |
| `open-accepted.json` | `a0c1d5f3da65184e2190c041c7acde42a0a663d4b497d1dedc83722a53c8cbf2` |
| `open-bounced.json` | `f83b447ea737dc02728acc1e31c754cf7f52ec66e959ca1accd3b1af9f88309c` |
| `open-duplicate.json` | `22dbfbb4688daf402d5920985dbc15d9182d972097e5b25b048338e29a893841` |
| `open-expired.json` | `0a0a40a1ec915ea7a4554f3ceac8f00d706c48d6b8a9705df463d946b5f42494` |
| `open-insurance-rejected.json` | `a695ca7f7fdf0809bf555decddda2d2ac479e8626ef79019dd0b5703713b9089` |
| `open-recovery-accepted.json` | `4bf1daf667ee6922cc72523f5ea11cc1e302a6fed28626cb250876abff5ee5ff` |
| `open-recovery-rejected.json` | `cc1a9dfdd1a102540956be74d873df6eb2c9633c216635dee9fed207454fcd1f` |
| `open-rejected.json` | `2f0577daf750ed994d323638b42bc1147940d050018fe54802cf32e94ba03c87` |
