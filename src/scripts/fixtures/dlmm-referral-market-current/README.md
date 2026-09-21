# Current referral-release DLMM market evidence

Local sandbox executions from the current production contracts, regenerated on 2026-09-14. The source exporters preserve every original transaction cell, message cell and before/after ShardAccount boundary; their assertions verify hashes and cash movements. These files do not certify live-chain deployment or fiat prices. Prior fixture files remain unchanged outside this directory.

The market and precision scenarios deliberately leave an earlier protocol fee unfunded. A later funded partial swap must deliver its exact refund and output while that older fee remains pending. No sponsor pays the older fee to make this regression pass. The queued scenario proves actual output finalization dispatches the next accepted output, including a previously uninitialized recipient and allocator collision avoidance. Precision metadata is explicitly set at genuine root deployment.

Reproduce from `ton-indexer` with `npx tsx ../output/referral-first-release/dlmm-receipt-current/{market,queued-market,precision}/export.ts` (one script per invocation), then the adjacent `publish-fixtures.py`. Run `npm run test:ledger:market` for current strict qualification.

| Runtime | Cell hash |
| --- | --- |
| `contracts/shared/jetton/jetton_root.tolk` | `9179b93f680689eec338989cf23966ac485a327452f2da61984e22f11e6b5cf8` |
| `contracts/shared/jetton/jetton_wallet.tolk` | `502baf5750f575615645dd5d7899971dd15f4d78dc37978396d19148c16b8732` |
| `contracts/dlmm/pool.tolk` | `cce255be276c271bac5218fac83099da6186adb40e8f411cf994e689388e0760` |

| File | SHA-256 |
| --- | --- |
| `dlmm-market-settlements.json` | `bf05be05e27c06bcb9cd156c535181750dba62242e339a556f7870d885117f80` |
| `dlmm-market-queued-settlements.json` | `3765d81802d68a464e732edb3ec4d58ded3ec5fafeeb13ce0be8638e78d95bee` |
| `dlmm-market-precision.json` | `9fdd366ad4925a64796d91ac3f5c67604d692ef7b9d5312bcfab791fbb759a8f` |
