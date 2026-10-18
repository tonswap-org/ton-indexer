import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyOrderTransaction } from '../../orders/evidence';
import { assertCurrentCaptureProducer, currentCaptureSha256, readCurrentCaptureManifest } from '../current-capture-build';

/** Original maintained producers, with their own byte-exact completion receipts.
 * The filtered rows qualify current wire facts, not complete account histories,
 * public consensus or two-pool physical settlement. */
export function currentProtocolFixture() {
  const root = join(__dirname, '../fixtures/current-protocol'), closure = join(root, 'source-closure');
  const metadata = readFileSync(join(root, 'packages.json'));
  assert.equal(currentCaptureSha256(metadata), '9b1b90450246939c887bc10525789cfec20f13a05fc8655a8beba760b27eb301');
  const snapshot = readCurrentCaptureManifest({ nativeRoot: join(closure, 'source'), artifactRoot: join(closure, 'artifacts'),
    manifestPath: join(closure, 'manifest.json'), expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
  return Object.entries(JSON.parse(metadata.toString('utf8'))).map(([producer, meta]) => {
    const { binding } = assertCurrentCaptureProducer(snapshot, { ...(meta as { suite: string; tests: number; receiptSha256: string; bindingSha256: string }),
      producer, directory: join(root, producer), log: readFileSync(join(root, `${producer}.log`)) });
    const cases = Object.keys(binding.captures).map(name => {
      const captured = JSON.parse(readFileSync(join(root, producer, name), 'utf8'));
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
    return { producer, cases, targets: binding.targets };
  });
}
