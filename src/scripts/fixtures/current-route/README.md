# Current coordinator route originals

These archives retain the production-Hub native producer's nine original cases: success, first-pool refund and second-pool refund under default, stress and x6 fee configurations. They are sandbox evidence, not public consensus, deployment or a release qualification.

`originals.json.gz` is the unchanged pooled capture export from `current-route-native-20261018-v1/run-6/portable`. Expanding each case restores its exact JSON bytes and hash from the producer completion receipt, including transaction/account BOCs, final-head getter observations, unrelated coordinator transactions and all setup predecessors. No financial cell is reconstructed. The collector uses only the 15 original route account envelopes; unrelated setup accounts are not asserted to be route state.

`source-closure.json.gz` is a lossless base64 map of that producer's source/virtual snapshots, complete compiled-artifact directory, native worker, source lock, successful completion receipt and log. The fixture verifier extracts a temporary physical verification cache, checks every locked byte and compiler input, and runs the maintained source-closure verifier for all 59 current build-manifest targets. Historical extra build files are retained but never used as current target authority. Nothing in the archive is executed.

The native producer source is `tests/wire/currentSpotRoute.native.test.ts` in the retained web closure. It uses the real factory, both real pools, coordinator and production T3 Hub. The indexer source/head transport adapter is explicitly synthetic; actual native original getter observations and account envelopes supply the tested identity bindings.

Run `tsx src/scripts/current-spot-route-evidence-test.ts` for the portable qualification. Supplying an absolute capture directory instead is diagnostic input and does not replace the reviewed source-bound portable fixture.
