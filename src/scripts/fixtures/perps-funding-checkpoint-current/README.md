# Current authenticated funding checkpoint

`funding-remainder.json` is an unchanged copy of the actual engine code/data
exported by `PerpsEngineFunding.spec.ts` after a +1 bps observation accrues for
300 seconds and a fresh zero-rate observation establishes the next checkpoint.
The carried numerator remainder is 300, the whole-bps index is zero, and the
new rate is zero. `provenance.json` pins the original bytes and engine code hash.

`perps-funding-checkpoint-test.ts` strictly decodes the 257-bit funding reference
and independently executes the six-field getter using the original code/data.
The synthetic account envelope is only for that read-only getter. This fixture
does not claim live deployment, physical payment, or transaction-history proof.
The older oracle execution archives remain unchanged and do not enable an old
layout decoder.
