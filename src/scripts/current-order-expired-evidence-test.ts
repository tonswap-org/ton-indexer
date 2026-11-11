/** Original default/x6 sandbox cases; transport anchors remain synthetic. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Cell, serializeTuple, type TupleItem } from '@ton/core';
import { parseRuntimeReleaseManifest } from '../config/runtimeManifest';
import { collectSpotOperationEvidence } from '../runtime/spotOperationEvidence';
import { readSpotOperationRequest } from '../runtime/spotOperationRequest';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';

const bytes = readFileSync(join(__dirname, 'fixtures/current-order-expired-native/originals.json.gz'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '6344ba030eb6d1c9cebf409f788b7268bf539a5beb7cc2d0d8ffe767a6625d3d');
const pooled = JSON.parse(gunzipSync(bytes).toString());
assert.equal(pooled.schema, 'tonswap-current-order-expired-recovery-originals-pooled-v1');
function expand(v: any): any {
  if (Array.isArray(v)) return v.map(expand);
  if (!v || typeof v !== 'object') return v;
  if (Object.keys(v).length === 1 && Number.isInteger(v.originalString)) { const s = pooled.strings[v.originalString]; assert.equal(typeof s, 'string'); return s; }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
}
function item([kind, value]: any): TupleItem {
  if (kind === 'num') return { type: 'int', value: BigInt(value) };
  if (kind === 'null') return { type: 'null' };
  assert(['cell', 'slice', 'builder'].includes(kind)); return { type: kind, cell: Cell.fromBase64(value.bytes) };
}
const key = (row: OrderTransactionEvidence) => { const v = verifyOrderTransaction(row); return `${row.account}:${v.tx.lt}:${v.hash}`; };
async function main() {
  const realNow = Date.now;
  try {
    for (const selected of pooled.cases) {
      const c = expand(selected.original), p = c.original;
      assert.equal(createHash('sha256').update(JSON.stringify(c, null, 2) + '\n').digest('hex'), selected.sha256);
      const manifest = parseRuntimeReleaseManifest(c.manifest, 'localnet');
      const rows = c.completeTransactions as OrderTransactionEvidence[];
      const getters = new Map<string, any>();
      for (const snapshot of c.readSnapshots) for (const [i, call] of snapshot.calls.entries()) if (call.kind === 'getter') {
        const args = (call.args ?? []).map((a: any): TupleItem => a.type === 'int' ? { type: 'int', value: BigInt(a.value) } : { type: a.type, cell: Cell.fromBase64(a.cellBoc) });
        const result = snapshot.response.results[i], argsBoc = serializeTuple(args).toBoc().toString('base64');
        getters.set(`${call.address}:${call.method}:${argsBoc}`, { address: call.address, method: call.method, argsBoc,
          exitCode: result.exitCode, resultBoc: serializeTuple(result.stack.map(item)).toBoc().toString('base64') });
      }
      const a = spotEvidenceFixtureAdapter(manifest, c.currentAccounts.map((r: any) => ({ address: r.address, shardAccountBoc: r.originalShardAccountBoc })), rows, c.unixTime, [...getters.values()]);
      const f = c.actions.find((a: any) => a.kind === 'fund'); assert(f);
      const creations = c.actions.filter((a: any) => ['create', 'repair', 'recover-create'].includes(a.kind)).map(({ valueNano, bodyBoc, bodyHash, lt, hash }: any) => ({ valueNano, bodyBoc, bodyHash, lt, hash }));
      assert(creations.length >= 2);
      const terms = c.recovery.winner === 'recovery-init-wins' ? c.recovery : p;
      const request = { kind: 'order-settlement', network: 'localnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
        owner: p.wallet, pool: p.pool, factory: p.factory, order: p.order, nonce: p.nonce, inputRoot: p.payRoot,
        termsBoc: terms.termsBoc, termsHash: terms.termsHash, creations,
        funding: { sourceWallet: f.destination, valueNano: f.valueNano, bodyBoc: f.bodyBoc, bodyHash: f.bodyHash, lt: f.lt, hash: f.hash } };
      Date.now = () => c.unixTime * 1000;
      const parsed = readSpotOperationRequest(request, manifest), result = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
      assert.equal(result.coverage.complete, true, `${selected.file}: ${JSON.stringify(result.coverage)}`);
      const returned = new Set(result.transactions.map(key));
      for (const creation of creations) assert(returned.has(`${p.factory}:${creation.lt}:${creation.hash}`), 'Every retained creation, including rejection/duplicate, is original evidence');
      const originalChild = rows.filter(r => r.account === p.order);
      for (const row of originalChild) assert(returned.has(key(row)), 'Pre-initialization child history is retained');
      const first = creations[0]; a.control.missingBoundary = `${p.factory}:${first.lt}:${first.hash}`;
      const missing = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
      assert.equal(missing.coverage.complete, false, 'An absent original cannot become successful recovery'); a.control.missingBoundary = '';
      const changed = readSpotOperationRequest({ ...request, creations: [{ ...first, valueNano: String(BigInt(first.valueNano) + 1n) }, ...creations.slice(1)] }, manifest);
      const wrong = await collectSpotOperationEvidence(manifest, a.source, a.store, changed);
      assert(wrong.coverage.gaps.some(g => g.code === 'original_creation_dispatch_unobserved'));
      console.log(selected.file, result.transactions.length, 'originals; missing/wrong creation refused');
    }
    assert.equal(pooled.cases.length, 8);
  } finally { Date.now = realNow; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
