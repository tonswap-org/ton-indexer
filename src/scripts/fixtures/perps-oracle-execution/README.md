# Perps oracle execution and current funding fixtures

Generated on 2026-09-14 by `tonswap_tolk/tests/perps/PerpsOracleRefresh.spec.ts` (`saveTrace`). The 13 current execution JSON files preserve original sandbox transaction BOCs, exact engine storage boundaries and compiled engine/pool/wallet code. They are sandbox execution evidence, not live-chain archive or deployment qualification.

Current execution and funding engine Cell hash: `c597885bb894625d0be7a734ffacb0c42e10fac95199c3a60206ad278ebd981a`.

The paid order ABI has mandatory original request/notification references, native budget, outcome/reason and saved pool. Current market stats require the int64 funding remainder in [0, 3600) and `oraclePriceHealthy` flag. Accepted execution uses the healthy callback market price and funding, while protocol debt conservation starts at the independent callback before-market deficit.

`close-bad-debt-accepted.json` explicitly labels an adversarial insolvent initial entry-notional/open-interest setup. Its actual funded position and custody are retained, and all exported CLOSE, pool, callback and insurance transactions run in the current contract runtime. The accepted close creates exactly 1,000,400,000 atomic protocol debt, emits that exact LOSS amount and pays no trader tokens. No fabricated earlier market history is claimed.

`open-accepted-excess.json` proves the exact 113 atomic trader refund. Its assessed protocol fee remains a durable READY treasury liability; the fixture does not claim completed treasury delivery. Recovery cases separately cover successful fresh-price admission and preserved risk/leverage rejections.

`funding-remainder-current.json` comes from the actual current engine account and independent `funding_accrual_state` getter in `PerpsEngineFunding.spec.ts` (zero/opposite-rate regression), proving remainder 1800 with the same current engine hash. The older `funding-remainder.json` is retained unchanged solely as an explicit obsolete registration/state rejection case. The historical `../perps-intermediate-state` archive also remains immutable; neither is a decoding fallback.

All inputs are pinned below. Run `npx tsx src/scripts/ledger-perps-oracle-execution-test.ts` and `npx tsx src/scripts/perps-oracle-state-test.ts`, or `npm run test:ledger`.

| File | SHA-256 |
| --- | --- |
| `close-accepted.json` | `eaa0a337f27348483ea015e1aa061990a677f837304df032070822dc968b4aaa` |
| `close-bad-debt-accepted.json` | `970c0a35fe67b06bdd166eefe47ac8979914ea885d6a8b51fb0f2278f8a3b528` |
| `close-intake-rejected.json` | `012d431bf93c8dc3a970de339ca42a73a3faa291c62bcce734e93af8460649d8` |
| `close-rejected.json` | `2acaa1c67a6f569c1efaa559012a587616515342bd5737b269ca51713157b2d1` |
| `funding-remainder-current.json` | `46ffa8ab09e64cd3d27d9843617a9f4048b1ca86a2e39112213ceeaf95926a30` |
| `funding-remainder.json` | `17a341cc7b0f3e51eb880db8ada685e67c234eba1b6129ac7e270f488b0151b0` |
| `open-accepted-excess.json` | `b1a883575db98de3c7e9cb3fed949704cc9d419b0bdd17842634c631d4256f66` |
| `open-accepted.json` | `b6b6a3f05f879df85a7e4adb378dd7442216454617689d43b8aa919f5d0057f6` |
| `open-bounced.json` | `f7aa7f2824656ce7ed5b9eb5fd0b47733512a0e0150c3a20f75272819564366f` |
| `open-duplicate.json` | `3390f2c93687f2052f04f04cbee33611bc4523a61b3b32f1a53607e71691ba43` |
| `open-expired.json` | `014a025c933d02b45eb940d8f08e0e001ca38ca38831a8b865308c017a1f9da3` |
| `open-insurance-rejected.json` | `1801b525da966395a0f98f04604df56f73cb8336cb68404d0d69e242a165e803` |
| `open-recovery-accepted.json` | `a733884d1ed9dfafd591a7a86cc741c82267f151ecd199e90700d21fa846ce5f` |
| `open-recovery-rejected.json` | `084047faf1849d1d5a9fbecb3d06c7fde52e944d5dfe9dc90fb52ea78ce124da` |
| `open-rejected.json` | `3e2e141e379b2ec369c76feb19d9465ab55fce5f690caee97e5fae3cf9746b7e` |
