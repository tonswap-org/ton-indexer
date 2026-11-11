# Current Order recovery originals

Twelve fresh native sandbox captures exercise production `T3Hub`, factory-created
immutable Orders, and actual T3/stablecoin wallets under default and x6 fee
profiles. For each profile they cover never-funded cancel/expiry on both input
sides, a failed T3 owner refund, and a failed T3 first leg followed by owner
recovery. The producer is `tests/wire/currentOrderLedgerRecovery.native.test.ts`
at web commit `d05e2822ce763b817313bf0c0b4862b1af46aa01`.

Never-funded completion requires the original closing owner dispatch, withdrawal
and bounce plus authenticated same-head absence or an exact empty ShardAccount.
The native captures retain the failed wallet transaction and its real cursor;
they do not erase history to manufacture dictionary absence. The ledger reports
zero custody, consumption, output and refund without inventing cash. Historical
active wallet state, incomplete history or unavailable current absence remains
unresolved.

Protected input recovery requires the original physical source debit, failed
recipient transaction and rich bounce, exact failure and claim membership at
MARK, closed-order owner OWDR and dispatch, a zero-delta wallet RETRY, and the
actual later owner credit. Cash retains the original source debit as its identity
and the later delivered credit as its destination. Failed and merely marked
stages are unresolved. Certificate-only recovery without the original recipient
failure/rich bounce, and any other missing-original path, remain unresolved;
these cases do not grant settlement authority from a certificate or SENT status.

`originals.json.gz` pools repeated strings and reconstructs each original JSON
byte-for-byte; it never reserializes cells. `inventory.json`, `source-lock.json`,
`completion.json`, `native.log` and `producer-runner.py` are original producer
records. `source-bytes.json.gz` retains every original source/virtual/artifact byte
in those records, including the native worker. The verifier checks all 386
physical lock entries, all 165 compiler inputs, passing unchanged-source receipt
and log, all 12 original outputs, and the maintained complete import/artifact
closure for all 59 current build targets. Temporary materialization of archived
source is only for reading; the archived worker and producer are never run.

This is native sandbox evidence, with explicit synthetic block/source and SQL
adapters. It is not public-consensus, continuous-history, deployment or activation
qualification. The producer lock does not claim installed npm dependency bytes
from package-lock metadata. Unexecuted manifest roles are not qualified merely
because their pins occur in the fixture. The original run and preceding failed
attempts remain under the web repository's ignored
`.local/state/order-ledger-recovery-native-20261018-v1/`.

Run `npm run test:ledger:orders`. It includes ordinary projection, discovery,
missing-original and same-head absence negatives, alongside the existing funded
Order/TWAP corpus. Current release admission and public capture gates remain
separate.
