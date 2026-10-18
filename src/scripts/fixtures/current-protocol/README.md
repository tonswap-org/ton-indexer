# Current lifecycle producer corpus

These are unchanged outputs of the maintained native capture runner on contracts
80ae2cda, Tolk1.5.0 and sandbox0.42.0, with their original logs, completion receipts,
build bindings, compiler BOCs and compiled cell serializations. `packages.json`
pins each original receipt and binding. The shared original build manifest and
physical Tolk/import/vendor inputs are retained in `source-closure`; generated
virtual imports are reconstructed and checked by `current-capture-build.ts`.
The unchanged build hash is 639a09ce4da115b89df5bfbf2e7f9a0a36eef78689e2023f7f0fae6e4664e26d.

| Producer | Complete producer tests | Current decoder exercised |
| --- | ---: | --- |
| claims |2| Merkle claim facts |
| remint |2| Remint accounting logs |
| route |8| Pool SWE3 and coordinator RTE3 logs |
| gasVault |2| Successful GVTK and FRFL calls |
| owed |2| Pool JOWC and successful CLMJ |

Governance GHEV/GPEV/GVEV/GLEV originals are shared from the separate
`current-governance` corpus. Other exact current library/supply layouts have
bounded wire vectors in `current-protocol-events-test.ts`; those vectors are not
native execution evidence. Existing current DLMM, T3, Options, Perps and Launchpad
corpora separately prove their implemented physical/economic operations.

Each row retains the original transaction and original before/after ShardAccount.
The producer filters on opcode, so these files do not contain complete histories
or every intermediate token-wallet transaction. The route producer uses its own
explicit injected native test world; it is not the production-Hub financial route
corpus. SWE3/RTE3 alone never establish final wallet credit. Existing exact current
SWP3/SWR3/RCT3 parsers remain in `currentDlmmState.ts`.

The test transport/head/coverage adapters are synthetic and marked as such. They
exercise role/code/original-cell authentication, failure and missing-evidence
refusals, owner causality, unrelated-history budget isolation and unchanged cash
projection. This corpus does not qualify public consensus, a deployed release,
complete event coverage or target execution. No historical TypeScript producer
source lock or compiler-binary lock is invented by the capture verifier.

Run `npm run test:ledger:protocol` from the indexer root. Operational originals
remain separately retained under the contracts repo's ignored `.local/state`.
