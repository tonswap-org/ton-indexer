import type { TupleItem } from '@ton/core';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const { Cell } = createRequire(resolve(__dirname, '../../../package.json'))('@ton/core');
import { currentGovernanceFixture } from '../../../src/scripts/support/currentGovernanceFixture';
import { createGovernanceSnapshotReader } from '../../../src/runtime/governanceSnapshot';
import { readGovernanceStorage } from '../../../src/utils/governanceStorage';
import { fakeChainSource } from '../../../src/scripts/support/fakeChainSource';
import { fixtureHead } from '../../../src/scripts/support/chainFixture';
import type { RuntimeReleaseManifest } from '../../../src/config/runtimeManifest';
import { currentNativeDexManifest, signDexManifest } from './dexFixtures.js';
import { parseDexReleaseManifest } from '../src/dexPrices.js';
import { config } from './helpers.js';

/** Unchanged source-qualified default/x6 states and actual current snapshot reader.
 * The manifest network, HTTP envelope and chain heads are synthetic test inputs;
 * neither this fixture nor the tests establish public-consensus qualification. */
export function nativeGovernanceFixture(worldIndex = 0) {
  const original = currentGovernanceFixture();
  const worlds = original.cases.map(world => ({ ...world, rows: world.rows.filter((row: any) =>
    row.after.codeBoc && Cell.fromBase64(row.after.codeBoc).hash().toString('hex') === original.codeHash) }));
  const sample = worlds[worldIndex]!.rows.find((row: any) => readGovernanceStorage(Cell.fromBase64(row.after.dataBoc)).props.proposals.size > 0)!;
  const base = currentNativeDexManifest();
  const manifest = signDexManifest({ ...base, contracts: { ...base.contracts,
    Governance: { address: sample.account, codeHash: original.codeHash } } }) as unknown as RuntimeReleaseManifest;
  const release = parseDexReleaseManifest(manifest);
  const cfg = config({ dexRelease: release, indexerUrls: { testnet: release.indexerUrl } });
  let selected = sample, head = fixtureHead(100, sample.utime);
  const source = fakeChainSource({ head: async () => head, read: async (calls, options) => {
    if (options?.at !== head) throw Error('Snapshot did not retain its exact test head.');
    const state = { balance: String(selected.after.balance), accountState: 'active' as const,
      codeBoc: selected.after.codeBoc, dataBoc: selected.after.dataBoc, shardAccountBoc: selected.after.originalShardAccount,
      lastTxLt: selected.after.lastTxLt, lastTxHash: selected.after.lastTxHash, sourceMasterchain: head,
      anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: selected.utime } };
    const params = original.probe.rows.find((row: any) => row.params).params as string[][];
    return { head, results: calls.map((call, index) => call.kind === 'account'
      ? { kind: 'account' as const, address: call.address, state }
      : { kind: 'getter' as const, address: call.address, exitCode: 0,
        stack: params[index - 1]!.map(value => ({ type: 'int', value: BigInt(value) })) as TupleItem[] }) };
  } });
  const read = createGovernanceSnapshotReader(manifest, source);
  return { original, worlds, sample, cfg, manifest, release, selectedWorld: worlds[worldIndex]!,
    proposal(row: any, id: string) { return readGovernanceStorage(Cell.fromBase64(row.after.dataBoc)).props.proposals.get(Number(id)); },
    async page(row = sample, now = row.utime, startId = '1', seqno = head.seqno + 1) {
      selected = row; head = fixtureHead(seqno, now);
      return read(row.account, { startId, maxScan: 64 });
    },
  };
}
