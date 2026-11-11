import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyOrderTransaction } from '../../orders/evidence';
import { assertCurrentCaptureProducer, currentCaptureSha256, readCurrentCaptureManifest } from '../current-capture-build';

/** Original default/x6 native boundaries. The HTTP heads used by consumers are
 * synthetic test anchors, not public-consensus or deployed-release evidence. */
export function currentGovernanceFixture() {
  const root = join(__dirname, '../fixtures/current-governance'), closure = join(root, 'source-closure');
  const snapshot = readCurrentCaptureManifest({ nativeRoot: join(closure, 'source'), artifactRoot: join(closure, 'artifacts'),
    manifestPath: join(closure, 'manifest.json'), expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
  const { binding } = assertCurrentCaptureProducer(snapshot, { producer: 'governance', suite: 'tests/system/ReleaseGovernance.spec.ts', tests: 2,
    directory: join(root, 'producer'), log: readFileSync(join(root, 'producer.log')),
    receiptSha256: 'fa618ecf93c499a7ed992bf9a4be8c6d809c89e9de3afb4c477bc19362270a5f',
    bindingSha256: '894351ddc414ee5bf71259e56ad7180d399ef47f01489795af21131c257649d2' });
  const cases = Object.keys(binding.captures).map(name => {
    const captured = JSON.parse(readFileSync(join(root, 'producer', name), 'utf8'));
    const rows = captured.transactions.map((row: any) => {
      const verified = verifyOrderTransaction({ account: row.account, transactionBoc: row.boc,
        beforeShardAccountBoc: row.before.originalShardAccount, afterShardAccountBoc: row.after.originalShardAccount });
      assert.equal(verified.hash, row.hash); assert.equal(verified.tx.now, row.utime);
      for (const side of ['before', 'after'] as const) {
        const state = verified[side].account?.storage.state;
        if (state?.type !== 'active') continue;
        assert.equal(state.state.code?.toBoc().toString('base64'), row[side].codeBoc);
        assert.equal(state.state.data?.toBoc().toString('base64'), row[side].dataBoc);
      }
      return row;
    });
    return { name, testName: captured.testName, rows };
  });
  for (const [file, expected] of Object.entries({'native-getters.ts.txt': '93b1d060609008a05183ca143f4fb47e817796285659f544627194438c199661', 'native-getters.json': 'e25b317516082e1b0c061cc35fe5a835c15cd778cc459e480934b7a1dce666d9', 'native-getters.log': '7763510a7eb9b56f89cb70c8af05265e3ab8c99f33eb25291652239a04ae5057'}))
    assert.equal(currentCaptureSha256(readFileSync(join(root, 'probe', file))), expected, `Original native getter probe differs: ${file}`);
  const probe = JSON.parse(readFileSync(join(root, 'probe/native-getters.json'), 'utf8'));
  assert.equal(probe.transactions, 0); assert.equal(probe.node, 'v22.23.3');
  return { codeHash: binding.targets.Governance.codeHash, cases, probe };
}
