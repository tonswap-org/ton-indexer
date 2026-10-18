# Current expired-order originals

`originals.json.gz` is copied byte-for-byte from the source-bound web producer
8d90aab389c4964c461e90e1f2bd66ffe293aa87; provenance.json retains the original
source-lock, inventory and portable evidence location. The test validates the
compressed SHA-256 and each expanded original hash before collection. No cells,
transactions or original envelopes are rewritten. Getter answers are retained
from the original read snapshots. The current read/anchor adapter is synthetic,
so this is collector qualification, not public consensus or ledger admission.

Eight cases cover default/x6, each input direction, delayed original
initialization winning, and rejected original creation followed by successful
owner-only recovery initialization. Each uses the original single funding
transfer and full physical refund with no execution. The collector must retain
every selected factory original and every child original, including pre-init.
Missing-original and substituted-value cases must remain incomplete.
