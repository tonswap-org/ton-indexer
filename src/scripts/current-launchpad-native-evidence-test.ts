/** Original native execution cells and observed getters under an explicitly
 * synthetic source/head adapter. This is not deployment/consensus authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Cell, serializeTuple, type TupleItem } from '@ton/core';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { fakeChainSource } from './support/fakeChainSource';
import { boundaryState, type PhysicalEvidenceStore } from '../runtime/physicalEvidence';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { readLaunchpadOperationRequest, collectLaunchpadOperationEvidence, type CurrentLaunchpadEvidenceRequest } from '../runtime/launchpadOperationEvidence';
import { readLaunchpadSalesRequest, collectLaunchpadSalesEvidence } from '../runtime/launchpadSalesEvidence';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function stack(values: any[]): TupleItem[] { return values.map(([type, value]) => {
  if (type === 'num' || type === 'int') return { type: 'int', value: BigInt(value) };
  if (type === 'null') return { type: 'null' };
  if (type === 'tuple') return { type: 'tuple', items: stack(value) };
  assert(['cell', 'slice', 'builder'].includes(type)); return { type, cell: Cell.fromBase64(value.bytes ?? value) };
}); }
export function originalProductCaptureAdapter(c: any) {
  assert.equal(c.calls.length, c.results.length);
  // Retain only actual observations made at this exact final head. Earlier
  // preparation reads cannot supply a missing current getter.
  const observations=c.calls.map((call:any,index:number)=>({call,result:c.results[index]}));
  for(const snapshot of c.readSnapshots??[]){
    const h=snapshot.response?.head;
    if(!h||h.seqno!==c.head.seqno||h.utime!==c.head.utime||h.rootHashHex!==c.head.rootHashHex)continue;
    assert.equal(snapshot.calls.length,snapshot.response.results.length);
    for(let i=0;i<snapshot.calls.length;i++)if(snapshot.calls[i].kind==='getter')observations.push({
      call:{...snapshot.calls[i],args:(snapshot.calls[i].args??[]).map((arg:any)=>arg.type==='int'?arg:{...arg,cell:arg.cell??arg.cellBoc})},result:snapshot.response.results[i]});
  }
  const rows = c.completeTransactions as OrderTransactionEvidence[], checked = rows.map(evidence => ({ evidence, checked: verifyOrderTransaction(evidence) }));
  const head = { ...c.head, workchain: -1, shard: '-9223372036854775808', fileHashHex: c.head.rootHashHex };
  const originals = new Map(checked.map(row => [`${row.evidence.account}:${row.checked.tx.lt}:${row.checked.hash}`, { evidence: row.evidence, seqno: head.seqno }]));
  const states = new Map<string, ReturnType<typeof boundaryState>['state']>(), refusedAccounts: unknown[] = [];
  for (let i = 0; i < c.calls.length; i++) if (c.calls[i].kind === 'account') {
    const call = c.calls[i], observed = c.results[i], latest = checked.filter(row => row.evidence.account === call.address).sort((a, b) => a.checked.tx.lt > b.checked.tx.lt ? -1 : 1)[0];
    if (!latest) continue;
    const state = boundaryState(call.address, latest.evidence.afterShardAccountBoc, head.seqno).state;
    try {
      assert.equal(observed.kind, 'account'); assert.equal(state.accountState, observed.state === 'uninit' ? 'uninitialized' : observed.state);
      assert.equal(state.lastTxLt, observed.lastTx.lt); assert.equal(Buffer.from(state.lastTxHash!, 'base64').toString('hex'), observed.lastTx.hash);
      assert.equal(state.balance, observed.balance);
      for (const [actual, expected] of [[state.codeBoc, observed.code], [state.dataBoc, observed.data]]) if (actual || expected)
        assert(actual && expected && Cell.fromBase64(actual).equals(Cell.fromBase64(expected)));
      states.set(call.address, { ...state, anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: head.utime } });
    } catch (error) { refusedAccounts.push({ account: call.address, reason: String(error) }); }
  }
  // Explicit native account envelopes also cover never-deployed canonical
  // wallets. A missing transaction history alone never supplies absence.
  const currentAccounts = new Set<string>();
  for (const original of c.originalCurrentAccounts ?? []) {
    assert(!currentAccounts.has(original.address), 'Duplicate original current account'); currentAccounts.add(original.address);
    assert.deepEqual(original.head, c.head, 'Original account must belong to the exact captured head');
    const state = boundaryState(original.address, original.shardAccountBoc, head.seqno).state;
    const prior = states.get(original.address);
    if (prior) assert(Cell.fromBase64(prior.shardAccountBoc!).equals(Cell.fromBase64(original.shardAccountBoc)), 'Conflicting original current account envelopes');
    states.set(original.address, { ...state, anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: head.utime } });
  }
  const tuple = (args: any[]): TupleItem[] => args.map(arg => {
    if (arg.type === 'int') return { type: 'int', value: BigInt(arg.value) };
    assert(['slice', 'cell', 'builder'].includes(arg.type) && typeof arg.cell === 'string', 'Original observed getter argument BOC required');
    return { type: arg.type, cell: Cell.fromBase64(arg.cell) };
  });
  const control = { missingAccount: '', missingBoundary: '', lastGetter: '' };
  const source = fakeChainSource({ network: 'localnet', head: async () => head, getAccountState: async (address, options) => {
    assert.deepEqual(options?.at, head); const state = states.get(address); assert(state, `Missing original current account ${address}`); return state;
  }, runGetMethod: async (address, method, args = [], options) => {
    assert.deepEqual(options?.at, head);
    const matches = observations.filter(({ call }: any) => call.kind === 'getter' && call.address === address && call.method === method
      && serializeTuple(tuple(call.args ?? [])).equals(serializeTuple(args)));
    control.lastGetter = `${address}:${method}:${matches.length}:${serializeTuple(args).toBoc().toString('base64')}`;
    assert(matches.length>0, `Missing exact observed ${method} at ${address}`); const result = matches[0].result;
    for(const duplicate of matches.slice(1)){assert.equal(duplicate.result.exitCode,result.exitCode);assert(serializeTuple(stack(duplicate.result.stack)).equals(serializeTuple(stack(result.stack))),'Conflicting getter observations at one exact head');}
    assert.equal(result.kind, 'getter'); return { exitCode: result.exitCode, stack: stack(result.stack) };
  } });
  const store: PhysicalEvidenceStore = { evidenceBoundary: async (account, lt, hash) => control.missingAccount === account || control.missingBoundary === `${account}:${lt}:${hash}` ? null : originals.get(`${account}:${lt}:${hash}`) ?? null,
    retain: async () => { throw Error('Read-only original native capture'); } };
  return { source, store, head, control, refusedAccounts, checked };
}
export function launchpadCaptureAdapter(c: any, request: CurrentLaunchpadEvidenceRequest) {
  assert.equal(c.schema, 'tonswap-launchpad-native-capture-v1');
  const adapter = originalProductCaptureAdapter(c);
  const b = c.bindings, base = runtimeManifestFixture(), manifest = { ...base, network: 'ton:localnet' as const, releaseId: request.releaseId, manifestHash: request.manifestHash,
    contracts: { ...base.contracts, SaleFactory: { address: b.factory, codeHash: b.factoryHash }, Governance: { ...base.contracts.Governance!, address: b.governance },
      FeeRouter: { ...base.contracts.FeeRouter!, address: b.feeSink }, Treasury: c.poolProof.identity.release.contracts.Treasury,
      DlmmPoolFactory: { address: b.dlmmFactory, codeHash: b.dlmmFactoryHash }, T3Hub: { address: b.t3Root, codeHash: b.t3MasterHash } },
    templates: { ...base.templates, SaleFixed: b.templates[0], SaleBonding: b.templates[1], SaleAuction: b.templates[2], LpVault: b.templates[3], VestingVault: b.templates[4],
      T3Wallet: b.t3WalletHash, JettonV21Minter: b.projectMasterHashes[0], JettonV21Wallet: b.projectWalletHash, DlmmPool: b.poolHash },
    tokens: [{ symbol: 'T3', root: b.t3Root, decimals: 9, masterCodeHash: b.t3MasterHash, walletCodeHash: b.t3WalletHash }] };
  return { ...adapter, manifest };
}
async function main() {
  const [completeDir, requestDir, output, mode] = process.argv.slice(2); assert(completeDir && requestDir && isAbsolute(completeDir) && isAbsolute(requestDir));
  assert(mode === undefined || mode === '--sales-only');
  const exports: unknown[] = [], pages: unknown[] = [], now = Date.now;
  try {
    for (const file of readdirSync(completeDir).filter(file => file.endsWith('-complete.json')).sort()) {
      const originalBytes = readFileSync(join(completeDir, file)), c = JSON.parse(originalBytes.toString()), prefix = file.replace('-complete.json', '-'); Date.now = () => c.head.utime * 1000;
      const requestFiles = readdirSync(requestDir).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort(); assert(requestFiles.length > 0);
      let adapter: ReturnType<typeof launchpadCaptureAdapter> | undefined;
      for (const requestFile of requestFiles) {
        const requestBytes = readFileSync(join(requestDir, requestFile)), raw = JSON.parse(requestBytes.toString()), request = raw.request as CurrentLaunchpadEvidenceRequest;
        const a = adapter = launchpadCaptureAdapter(c, request), parsed = readLaunchpadOperationRequest(request, a.manifest);
        if (mode === '--sales-only') break;
        const response = await collectLaunchpadOperationEvidence(a.manifest, a.source, a.store, parsed).catch(error => { console.error(requestFile, a.control, a.refusedAccounts); throw error; });
        assert(response.coverage.complete, `${requestFile}: ${JSON.stringify(response.coverage)}`); response.transactions.forEach(verifyOrderTransaction);
        assert(response.transactions.some(row => row.account === request.owner && verifyOrderTransaction(row).hash === request.dispatch.hash));
        a.control.missingAccount = request.factory; assert(!(await collectLaunchpadOperationEvidence(a.manifest, a.source, a.store, parsed)).coverage.complete); a.control.missingAccount = '';
        const wrong = readLaunchpadOperationRequest({ ...request, dispatch: { ...request.dispatch, hash: '0'.repeat(64) } }, a.manifest);
        assert(!(await collectLaunchpadOperationEvidence(a.manifest, a.source, a.store, wrong)).coverage.complete);
        const abort = new AbortController(); abort.abort(); await assert.rejects(collectLaunchpadOperationEvidence(a.manifest, a.source, a.store, parsed, abort.signal));
        exports.push({ file: requestFile, sourceSha256: sha(originalBytes), requestSha256: sha(requestBytes), request, manifest: a.manifest, refusedAccounts: a.refusedAccounts, response });
        console.log(requestFile, 'complete', response.transactions.length);
      }
      const a = adapter!, factoryRows = a.checked.filter(row => row.evidence.account === a.manifest.contracts.SaleFactory.address).sort((x, y) => x.checked.tx.lt > y.checked.tx.lt ? -1 : 1);
      let cursor: { lt: string; hash: string } | null = null; const seen: string[] = [];
      do {
        const query = { factory: a.manifest.contracts.SaleFactory.address, limit: '2', ...(cursor ? { cursorLt: cursor.lt, cursorHash: cursor.hash } : {}) };
        const response = await collectLaunchpadSalesEvidence(a.manifest, a.source, a.store, readLaunchpadSalesRequest(query, a.manifest));
        assert(response.coverage.complete, JSON.stringify(response.coverage)); assert(response.transactions.length <= 2);
        seen.push(...response.transactions.map(row => verifyOrderTransaction(row).hash)); assert(seen.length <= factoryRows.length);
        pages.push({ file, response }); cursor = response.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, factoryRows.map(row => row.checked.hash));
      if (factoryRows.length) {
        a.control.missingAccount = a.manifest.contracts.SaleFactory.address;
        const missing = await collectLaunchpadSalesEvidence(a.manifest, a.source, a.store, { factory: a.control.missingAccount, limit: 2, cursor: null });
        assert(!missing.coverage.complete && missing.nextCursor !== null && missing.transactions.length === 0); a.control.missingAccount = '';
      }
      console.log(file, 'factory pages retain all', seen.length, 'original transactions');
    }
    if (output) { assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-launchpad-collector-test-v1',
      qualification: 'Unchanged original native execution cells and actual same-head account/getter observations under synthetic sandbox release/head adapter. No deployment/consensus qualification.',
      scope: mode === '--sales-only' ? 'sales-discovery-only' : 'operations-and-sales-discovery',
      completeDir, requestDir, cases: exports, pages }, null, 2) + '\n', { flag: 'wx' }); }
  } finally { Date.now = now; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
