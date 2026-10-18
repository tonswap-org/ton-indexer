/** Complete original production-Hub native route facts. The source/head adapter
 * is explicitly synthetic and never establishes public consensus or deployment. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Address, Cell, beginCell, loadShardAccount, serializeTuple, storeShardAccount, type TupleItem } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { validateReleaseManifest } from '../config/runtimeManifest';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState, canonicalPhysicalMessage } from '../runtime/physicalEvidence';
import { collectSpotOperationEvidence } from '../runtime/spotOperationEvidence';
import { readSpotOperationRequest, type ParsedRouteSpotOperationRequest } from '../runtime/spotOperationRequest';
import { SPOT_EVIDENCE_LIMITS } from '../runtime/spotEvidenceIdentity';
import { collectSpotRouteEvidence } from '../runtime/spotRouteEvidence';
import { spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';
import { currentRouteFixture } from './support/currentRouteFixture';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function stack(items: any[]): TupleItem[] {
  return items.map(([type, value]) => {
    if (type === 'num' || type === 'int') return { type: 'int', value: BigInt(value) };
    if (type === 'null') return { type: 'null' };
    if (type === 'tuple') return { type: 'tuple', items: stack(value) };
    assert(['cell', 'slice', 'builder'].includes(type)); return { type, cell: Cell.fromBase64(value.bytes ?? value) };
  });
}
export function routeCaptureAdapter(c: any) {
  assert.equal(c.schema, 'tonswap-current-route-native-v1');
  const manifest = c.manifest as RuntimeReleaseManifest, valid = validateReleaseManifest(manifest);
  assert(valid.ok, JSON.stringify(valid));
  const rows = c.completeTransactions as OrderTransactionEvidence[], latest = new Map<string, OrderTransactionEvidence>();
  for (const row of rows) {
    const t = verifyOrderTransaction(row), previous = latest.get(row.account);
    if (!previous || verifyOrderTransaction(previous).tx.lt < t.tx.lt) latest.set(row.account, row);
  }
  // Setup also includes accounts outside the route, some explicitly funded by
  // the native world before capture. Only the exact 15 route identities enter
  // this current-head adapter; every retained transaction remains original.
  const scope = new Set<string>([c.request.owner, c.request.pool, c.request.pool2, c.request.coordinator,
    c.request.payRoot, c.request.receiveRoot, manifest.contracts.T3Hub!.address,
    ...Object.values(c.binding.wallets).map((wallet: any) => wallet.address)]);
  assert.equal(scope.size, 15);
  const current = new Map<string, string>();
  for (const a of c.currentAccounts) {
    if (!scope.has(a.address)) continue;
    assert.equal(Address.parse(a.address).toRawString(), a.address); assert(!current.has(a.address));
    boundaryState(a.address, a.shardAccountBoc, 1);
    const row = latest.get(a.address);
    if (row) assert(Cell.fromBase64(row.afterShardAccountBoc).equals(Cell.fromBase64(a.shardAccountBoc)), `current envelope follows complete originals: ${a.address}`);
    current.set(a.address, a.shardAccountBoc);
  }
  assert.equal(current.size, scope.size, 'all route account envelopes are original');
  const head = c.readSnapshots.at(-1).response.head;
  assert.equal(c.unixTime, head.utime);
  assert.equal(c.binding.minSeqno, head.seqno); assert.equal(c.binding.minBlockRootHash, head.rootHashHex);
  const getters = new Map<string, any>();
  for (const snapshot of c.readSnapshots) {
    if (snapshot.response.head.seqno !== head.seqno) continue;
    assert.deepEqual(snapshot.response.head, head); assert.equal(snapshot.calls.length, snapshot.response.results.length);
    snapshot.calls.forEach((call: any, index: number) => {
      const result = snapshot.response.results[index]; assert.equal(call.kind, result.kind);
      if (!scope.has(call.address)) return;
      if (call.kind === 'account') {
        const original = current.get(call.address); assert(original, `Missing original current ${call.address}`);
        if (result.originalShardAccountBoc) assert(Cell.fromBase64(original).equals(Cell.fromBase64(result.originalShardAccountBoc)));
        const state = boundaryState(call.address, original, 1).state;
        assert.equal(result.state === 'uninit' ? 'uninitialized' : result.state, state.accountState);
        assert.equal(String(result.balance), state.balance);
        if (result.lastTx) {
          assert.equal(result.lastTx.lt, state.lastTxLt);
          assert.equal(result.lastTx.hash, Buffer.from(state.lastTxHash!, 'base64').toString('hex'));
        }
        for (const [originalBoc, observedBoc] of [[state.codeBoc, result.codeBoc], [state.dataBoc, result.dataBoc]])
          if (originalBoc || observedBoc) assert(originalBoc && observedBoc && Cell.fromBase64(originalBoc).equals(Cell.fromBase64(observedBoc)));
      } else {
        const args = serializeTuple((call.args ?? []).map((a: any) => a.type === 'int'
          ? { type: 'int', value: BigInt(a.value) } : { type: a.type, cell: Cell.fromBase64(a.cellBoc) }));
        const key = `${call.address}:${call.method}:${args.hash().toString('hex')}`;
        const getter = { address: call.address, method: call.method, argsBoc: args.toBoc().toString('base64'),
          exitCode: result.exitCode, resultBoc: serializeTuple(stack(result.stack)).toBoc().toString('base64') };
        const previous = getters.get(key); if (previous) assert.deepEqual(getter, previous); getters.set(key, getter);
      }
    });
  }
  for (const root of [c.request.payRoot, c.request.receiveRoot, manifest.contracts.T3Hub!.address])
    assert([...getters.values()].some(g => g.address === root && g.method === 'get_jetton_data'), 'retain actual native master getter');
  const accounts = [...current].map(([address, shardAccountBoc]) => ({ address, shardAccountBoc }));
  const adapter = spotEvidenceFixtureAdapter(manifest, accounts, rows, c.unixTime, [...getters.values()]);
  Object.assign(adapter.head, { seqno: head.seqno, rootHashHex: head.rootHashHex, fileHashHex: head.fileHashHex ?? adapter.head.fileHashHex, utime: head.utime });
  return { ...adapter, manifest, nativeHead: head };
}

async function main() {
  const directory = process.argv[2], output = process.argv[3]; assert(!directory || isAbsolute(directory));
  const inputs = directory ? readdirSync(directory).filter(file => /^route-(success|first-refund|second-refund)-(default|stress|x6)\.json$/.test(file)).sort()
    .map(file => { const bytes = readFileSync(join(directory, file)); return { file, bytes, capture: JSON.parse(bytes.toString()) }; })
    : currentRouteFixture().cases();
  const cases: unknown[] = [], originalNow = Date.now;
  try {
    for (const { file, bytes, capture: c } of inputs) {
      Date.now = () => c.unixTime * 1000;
      const a = routeCaptureAdapter(c), parsed = readSpotOperationRequest(c.request, a.manifest) as ParsedRouteSpotOperationRequest;
      const read = () => collectSpotOperationEvidence(a.manifest, a.source, a.store, parsed);
      const response = await read(); assert.equal(response.schema, 'tonswap-spot-route-evidence-v1');
      assert(response.coverage.complete, `${file}: ${JSON.stringify(response.coverage)}`);
      assert(response.transactions.length <= SPOT_EVIDENCE_LIMITS.returnedTransactions);
      assert(Buffer.byteLength(JSON.stringify(response)) <= SPOT_EVIDENCE_LIMITS.responseBytes);
      const first = response.transactions.find(row => row.account === parsed.request.sourceWallet && verifyOrderTransaction(row).hash === parsed.request.dispatch.hash);
      assert(first); const physical = verifyOrderTransaction(first);
      const owner = response.transactions.filter(row => row.account === parsed.request.owner && [...verifyOrderTransaction(row).outgoing.values()]
        .some(message => physical.incoming && canonicalPhysicalMessage(message).equals(canonicalPhysicalMessage(physical.incoming))));
      assert.equal(owner.length, 1, 'original owner dispatch is mandatory');
      const originalHashes = new Set(c.completeTransactions.map((row: OrderTransactionEvidence) => verifyOrderTransaction(row).hash));
      const responseHashes = new Set(response.transactions.map(row => verifyOrderTransaction(row).hash));
      for (const row of response.transactions) assert(originalHashes.has(verifyOrderTransaction(row).hash), 'no reconstructed originals');
      assert(c.unrelatedTransactions.some((row: OrderTransactionEvidence) => row.account === parsed.request.coordinator
        && verifyOrderTransaction(row).tx.lt > physical.tx.lt), 'retain actual later shared-contract history');
      for (const row of c.unrelatedTransactions as OrderTransactionEvidence[]) {
        const unrelated = verifyOrderTransaction(row); assert(!responseHashes.has(unrelated.hash), 'unrelated shared transactions are never route evidence');
        if (![...a.states.keys()].includes(row.account)) {
          a.control.missingAccount = row.account;
          try { assert.deepEqual(await read(), response, 'unrelated owner history cannot poison route evidence'); }
          finally { a.control.missingAccount = ''; }
        }
      }
      for (const [key, value] of Object.entries(response.wallets)) assert.equal(value, c.binding.wallets[key].address);

      for (const address of [parsed.request.owner, parsed.request.sourceWallet, parsed.request.pool,
        ...(c.mode === 'first-refund' ? [] : [parsed.request.coordinator, parsed.request.pool2])]) {
        a.control.missingAccount = address; const missing = await read(); assert(!missing.coverage.complete, `${file}: missing ${address}`);
      }
      a.control.missingAccount = '';
      for (const patch of [{ dispatch: { ...parsed.request.dispatch, hash: '0'.repeat(64) } },
        { valueNano: (BigInt(parsed.request.valueNano) + 1n).toString() }]) {
        const wrong = readSpotOperationRequest({ ...parsed.request, ...patch }, a.manifest);
        assert(!(await collectSpotOperationEvidence(a.manifest, a.source, a.store, wrong)).coverage.complete);
      }
      const before = a.control.reads; await read(); assert(a.control.reads > before, 'no completed response cache');
      for (const role of ['SwapCoordinator'] as const) {
        const pin = a.manifest.contracts[role]!; const hash = pin.codeHash; pin.codeHash = 'f'.repeat(64);
        try { await assert.rejects(read); } finally { pin.codeHash = hash; }
      }
      const poolHash = a.manifest.templates.DlmmPool; a.manifest.templates.DlmmPool = 'f'.repeat(64);
      try { await assert.rejects(read); } finally { a.manifest.templates.DlmmPool = poolHash; }
      for (const root of [parsed.request.payRoot, parsed.request.receiveRoot, a.manifest.contracts.T3Hub!.address]) {
        a.control.wrongCode = root;
        try { await assert.rejects(read); } finally { a.control.wrongCode = ''; }
      }
      for (const address of [parsed.request.pool, parsed.request.pool2, parsed.request.coordinator]) {
        a.control.missingProof = address;
        try { await assert.rejects(read); } finally { a.control.missingProof = ''; }
        // Deliberately invalid negative envelope: retain the exact current code
        // but replace its storage with an empty layout. Never positive evidence.
        const saved = a.states.get(address)!;
        const shard = loadShardAccount(Cell.fromBase64(saved.shardAccountBoc!).beginParse());
        assert(shard.account?.storage.state.type === 'active'); shard.account.storage.state.state.data = Cell.EMPTY;
        a.states.set(address, boundaryState(address, beginCell().store(storeShardAccount(shard)).endCell().toBoc().toString('base64'), 1).state);
        try { await assert.rejects(read); } finally { a.states.set(address, saved); }
      }
      for (const method of ['get_pool_info', 'get_jetton_data', 'get_wallet_address']) {
        for (const fail of ['missing', 'exit', 'layout']) {
          const source = { ...a.source, runGetMethod: async (...args: Parameters<typeof a.source.runGetMethod>) => {
            if (args[1] !== method) return a.source.runGetMethod(...args);
            if (fail === 'missing') throw Error('Deliberately unavailable native getter');
            return { exitCode: fail === 'exit' ? 9 : 0, stack: [] };
          } };
          await assert.rejects(collectSpotOperationEvidence(a.manifest, source, a.store, parsed));
        }
      }
      const emptyBytes = Buffer.byteLength(JSON.stringify({ ...response, transactions: [] }));
      for (const budget of [{ historyTransactions: 1 }, { returnedTransactions: 1 }, { messageEdges: 1 }, { responseBytes: emptyBytes + 512 }]) {
        const limited = await collectSpotRouteEvidence(a.manifest, a.source, a.store, parsed, undefined, budget);
        assert(!limited.coverage.complete && limited.coverage.gaps.length > 0, 'limits cannot return truncated-complete evidence');
        if ('responseBytes' in budget) assert(Buffer.byteLength(JSON.stringify(limited)) <= budget.responseBytes!);
      }
      const clamped = await collectSpotRouteEvidence(a.manifest, a.source, a.store, parsed, undefined,
        Object.fromEntries(Object.entries(SPOT_EVIDENCE_LIMITS).map(([key, value]) => [key, value + 1])));
      assert.deepEqual(clamped, response, 'internal overrides cannot raise production maxima');
      for (const budget of [{ messageEdges: 0 }, { messageEdges: -1 }, { messageEdges: 1.5 }, { messageEdges: Number.MAX_SAFE_INTEGER + 1 }])
        await assert.rejects(collectSpotRouteEvidence(a.manifest, a.source, a.store, parsed, undefined, budget));
      const abort = new AbortController(); abort.abort(); await assert.rejects(collectSpotOperationEvidence(a.manifest, a.source, a.store, parsed, abort.signal));
      Date.now = () => (c.unixTime + 31) * 1000; await assert.rejects(read); Date.now = () => c.unixTime * 1000;
      cases.push({ file, sourceSha256: sha(bytes), request: c.request, nativeHead: a.nativeHead, response });
      console.log(file, response.transactions.length, 'original owner and physical branches retained; missing/wrong/abort/stale refused');
    }
    assert.equal(cases.length, 9, 'default/stress/x6 profiles of success and each-hop refund');
    if (output) {
      assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-current-route-collector-test-v1',
        qualification: 'Unchanged production-Hub native originals and native getters; synthetic head/source adapter. No public consensus, deployment or event-only payout claim.',
        sourceDirectory: directory ?? 'reviewed portable current-route fixtures', cases }, null, 2) + '\n', { flag: 'wx' });
    }
  } finally { Date.now = originalNow; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
