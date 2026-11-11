import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { boundaryState } from '../runtime/physicalEvidence';
import { activeOrderAccount, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { readCurrentPerpsEngine, readCurrentPerpsRiskVault } from '../runtime/perpsEvidenceState';
import { collectPerpsOperationEvidence, readPerpsOperationRequest } from '../runtime/perpsOperationEvidence';
import { collectPerpsWalletClaimEvidence } from '../runtime/perpsWalletClaimEvidence';
import { originalProductCaptureAdapter } from './current-launchpad-native-evidence-test';

export function perpsNativeManifest(c: any) {
  const raw = (value: any): string => { if (typeof value === 'string') { assert(/^0:[0-9a-f]{64}$/.test(value)); return value; }
    assert(value?.workChain === 0 && value.hash?.type === 'Buffer' && value.hash.data?.length === 32); return '0:' + Buffer.from(value.hash.data).toString('hex'); };
  const base = runtimeManifestFixture(), b = c.binding, p = c.request;
  const role = (key: keyof typeof base.contracts, address: any, hash?: string) => ({ ...base.contracts[key]!, address: raw(address), ...(hash ? { codeHash: hash } : {}) });
  return { ...base, network: 'ton:localnet' as const, releaseId: p.releaseId, manifestHash: p.manifestHash,
    contracts: { ...base.contracts, PerpsEngine: role('PerpsEngine', b.engine, b.engineHash), RiskVault: role('RiskVault', b.riskVault, b.riskVaultHash),
      Governance: role('Governance', b.governance), FeeRouter: role('FeeRouter', b.feeSink), Treasury: role('Treasury', b.treasury), T3Hub: role('T3Hub', b.t3Root, b.t3MasterHash) },
    templates: { ...base.templates, T3Wallet: b.t3WalletHash, DlmmPool: b.poolHash },
    tokens: [{ symbol: 'T3', root: raw(b.t3Root), decimals: 9, masterCodeHash: b.t3MasterHash, walletCodeHash: b.t3WalletHash }],
    perpsMarkets: b.markets.map(([marketId, address]: [number, any]) => ({ ...base.perpsMarkets.find(m => m.marketId === marketId)!, marketId, pool: raw(address) })) };
}
/** Normalize only recorded transport shapes. Current ShardAccounts and getters
 * remain original producer observations; prior preparation heads are not reused. */
export function perpsOriginalAdapter(c: any) {
  assert(Array.isArray(c.currentAccounts) && c.currentAccounts.length > 0 && Array.isArray(c.readSnapshots));
  const final = c.readSnapshots.at(-1); assert(final?.response?.head && final.calls.length === final.response.results.length);
  const calls: any[] = [], results: any[] = [], head = final.response.head;
  for (const observed of c.currentAccounts) {
    assert(typeof observed.address === 'string' && typeof observed.shardAccountBoc === 'string');
    const state = boundaryState(observed.address, observed.shardAccountBoc, head.seqno).state;
    calls.push({ kind: 'account', address: observed.address }); results.push({ kind: 'account', state: state.accountState === 'uninitialized' ? 'uninit' : state.accountState,
      balance: state.balance, lastTx: { lt: state.lastTxLt, hash: Buffer.from(state.lastTxHash!, 'base64').toString('hex') }, code: state.codeBoc, data: state.dataBoc });
  }
  for (let i = 0; i < final.calls.length; i++) if (final.calls[i].kind === 'getter') {
    const call = final.calls[i]; calls.push({ ...call, args: call.args.map((arg: any) => arg.type === 'int' ? arg : { type: arg.type, cell: arg.cellBoc }) });
    results.push(final.response.results[i]);
  }
  return originalProductCaptureAdapter({ head, calls, results, completeTransactions: c.transactions });
}
async function main() {
  const [directory, output, mode] = process.argv.slice(2); assert(directory && isAbsolute(directory)); assert(mode === undefined || mode === '--state-only');
  const cases: unknown[] = [], now = Date.now;
  try {
    for (const file of readdirSync(directory).filter(f => f.endsWith('.json')).sort()) {
      const bytes = readFileSync(join(directory, file)), c = JSON.parse(bytes.toString()), manifest = perpsNativeManifest(c), parsed = readPerpsOperationRequest(c.request, manifest);
      let states = 0;
      for (const evidence of (c.completeTransactions ?? c.transactions) as OrderTransactionEvidence[]) if ([c.request.engine, c.request.riskVault].includes(evidence.account)) {
        const tx = verifyOrderTransaction(evidence), engine = evidence.account === c.request.engine, pin = manifest.contracts[engine ? 'PerpsEngine' : 'RiskVault'].codeHash;
        for (const shard of [tx.before, tx.after]) if (shard.account?.storage.state.type === 'active') {
          const data = activeOrderAccount(shard, pin).data;
          if (engine) readCurrentPerpsEngine(data, manifest); else readCurrentPerpsRiskVault(data, manifest); states++;
        }
      }
      assert(states > 0); let response: unknown = null, claims: unknown = null;
      if (mode !== '--state-only') {
        const a = c.head ? originalProductCaptureAdapter(c) : perpsOriginalAdapter(c); Date.now = () => a.head.utime * 1000;
        const operation = await collectPerpsOperationEvidence(manifest, a.source, a.store, parsed).catch(error => { console.error(file, a.control, a.refusedAccounts); throw error; }); assert(operation.coverage.complete, JSON.stringify(operation.coverage)); response = operation;
        const recovery = await collectPerpsWalletClaimEvidence(manifest, a.source, a.store, parsed).catch(error => { console.error(file, a.control, a.refusedAccounts); throw error; }); assert(recovery.coverage.complete, JSON.stringify(recovery.coverage)); claims = recovery;
        a.control.missingAccount = c.request.engine; assert(!(await collectPerpsOperationEvidence(manifest, a.source, a.store, parsed)).coverage.complete); a.control.missingAccount = '';
        const wrong = readPerpsOperationRequest({ ...c.request, dispatch: { ...c.request.dispatch, hash: '0'.repeat(64) } }, manifest);
        assert(!(await collectPerpsOperationEvidence(manifest, a.source, a.store, wrong)).coverage.complete);
        const abort = new AbortController(); abort.abort(); await assert.rejects(collectPerpsOperationEvidence(manifest, a.source, a.store, parsed, abort.signal));
      }
      cases.push({ file, sourceSha256: createHash('sha256').update(bytes).digest('hex'), request: c.request, manifest, states, response, claims }); console.log(file, states, 'original current product states', mode ?? 'operation and recovery');
    }
    if (output) { assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-perps-collector-test-v1',
      qualification: 'Original native cells with explicitly synthetic sandbox release/head binding. State-only mode does not qualify operation collection or current witness completeness. No deployment/consensus authority.',
      scope: mode === '--state-only' ? 'original-product-state-only' : 'operation-and-current-claims', directory, cases }, null, 2) + '\n', { flag: 'wx' }); }
  } finally { Date.now = now; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
