/** Original native factory derivation only. This is not operation settlement. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { activeOrderAccount, orderShard } from '../orders/evidence';
import { publicPoolIdentity } from '../runtime/poolOperationEvidence';
import { poolCaptureAdapter } from './current-pool-operation-evidence-test';

async function main() {
  const dir = process.argv[2], output = process.argv[3]; assert(dir && isAbsolute(dir));
  const cases: unknown[] = [], originalNow = Date.now;
  try {
    for (const file of readdirSync(dir).filter(f => /^public-factory.*\.json$/.test(f)).sort()) {
      const bytes = readFileSync(join(dir, file)), c = JSON.parse(bytes.toString());
      assert.equal(c.schema, 'tonswap-browser-public-pool-native-evidence-v1'); Date.now = () => c.unixTime * 1000;
      const a = poolCaptureAdapter(c), state = a.states.get(c.pool); assert(state?.shardAccountBoc);
      const data = activeOrderAccount(orderShard(state.shardAccountBoc, c.pool).shard, a.manifest.templates.DlmmPool).data;
      const read = () => publicPoolIdentity(a.manifest, a.source, a.head, c.pool, data);
      const identity = await read(); assert.equal(identity.market.pool, c.pool);
      assert.equal(identity.identityManifest.tokens.find(t => t.symbol === identity.market.symbol)?.root, c.root);
      const pin = a.manifest.contracts.DlmmPoolFactory!.codeHash;
      a.manifest.contracts.DlmmPoolFactory!.codeHash = 'f'.repeat(64); await assert.rejects(read); a.manifest.contracts.DlmmPoolFactory!.codeHash = pin;
      a.control.missingProof = c.factory; await assert.rejects(read); a.control.missingProof = '';
      await assert.rejects(publicPoolIdentity(a.manifest, a.source, a.head, `0:${'f'.repeat(64)}`, data));
      cases.push({ file, sourceSha256: createHash('sha256').update(bytes).digest('hex'), nativeHead: a.nativeHead,
        manifest: a.manifest, pool: c.pool, root: c.root, market: identity.market });
      console.log(file, 'original factory, token and canonical PoolId identity passed');
    }
    assert(cases.length > 0);
    if (output) { assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-public-pool-identity-test-v1',
      qualification: 'Original current factory/master/pool cells and native same-head getters; synthetic head/source adapter. Factory derivation only; no public operation, outside-manifest token, or payment claim.',
      sourceDirectory: dir, cases }, null, 2) + '\n', { flag: 'wx' }); }
  } finally { Date.now = originalNow; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
