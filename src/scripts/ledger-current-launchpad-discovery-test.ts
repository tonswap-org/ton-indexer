import assert from 'node:assert/strict';
import { currentLaunchpadCaptures } from './support/currentLaunchpadCaptures';
import { currentLaunchpadProjectionFixture } from './support/currentLaunchpadFixture';
import { discoverCurrentLaunchpad, discoverCurrentLaunchpadSupplies } from '../ledger/currentLaunchpadDiscovery';
import { currentLaunchpadBindingFromManifest, launchpadChild, maybe, raw, receives, tokenTransfer, verifyLaunchpadTransaction } from '../ledger/currentLaunchpadProof';
import { decodeCurrentLaunchpadOperations } from '../ledger/currentLaunchpad';
import { projectOwnerLedger } from '../ledger/project';
import { LedgerGraphBuilder } from '../ledger/graph';
import type { PostgresLedgerStore } from '../ledger/store';
import type { WalletIdentityStore } from '../ledger/identities';
import type { OrderTransactionEvidence } from '../orders/evidence';
import { boundaryState } from '../runtime/physicalEvidence';
import { canonicalLedgerHash } from '../ledger/normalize';
import { fixtureHead } from './support/chainFixture';
import { fakeChainSource } from './support/fakeChainSource';
import { originalProductCaptureAdapter } from './current-launchpad-native-evidence-test';

async function positiveGraph(capture: any, owner: string) {
  const binding = currentLaunchpadBindingFromManifest(capture.release), adapter = originalProductCaptureAdapter(capture);
  const input = currentLaunchpadProjectionFixture({ binding, request: { owner }, completeTransactions: capture.completeTransactions });
  const originalByAccount = new Map<string, ReturnType<typeof verifyLaunchpadTransaction>[]>();
  for (const e of capture.completeTransactions as OrderTransactionEvidence[]) {
    const t = verifyLaunchpadTransaction(e); originalByAccount.set(t.account, [...originalByAccount.get(t.account) ?? [], t]);
  }
  const qualify = async (account: string) => {
    const state = await adapter.source.getAccountState(account, { at: adapter.head });
    const history = [...originalByAccount.get(account) ?? []].sort((a, b) => a.tx.lt < b.tx.lt ? -1 : 1);
    let lt = 0n, hash = 0n;
    for (const t of history) { assert.equal(t.tx.prevTransactionLt, lt); assert.equal(t.tx.prevTransactionHash, hash); lt = t.tx.lt; hash = BigInt('0x' + t.hash); }
    assert.equal(state.lastTxLt, String(lt)); assert.equal(canonicalLedgerHash(state.lastTxHash!), canonicalLedgerHash(hash.toString(16).padStart(64, '0')));
    if (!history.length) assert.equal(state.accountState, 'uninitialized', 'empty history requires original current absence, not a fabricated account');
    return state;
  };
  const store = { rawHistory: async (account: string) => (input.chains.get(account)?.transactions ?? []).map(raw => ({ raw })),
    pool: { query: async (sql: string, values: string[]) => {
      if (sql.startsWith('SELECT source_complete')) { const state = await qualify(values[0]); return { rows: [{ source_complete: true, head_lt: state.lastTxLt, head_hash: state.lastTxHash, head_observed_at: new Date(adapter.head.utime * 1000).toISOString() }] }; }
      if (sql.startsWith('SELECT snapshot')) { const snapshot = await input.stateAt(values[1], values[2], values[3]); return { rows: snapshot ? [{ snapshot }] : [] }; }
      throw Error(`Unexpected positive graph SQL: ${sql}`);
    } } } as unknown as PostgresLedgerStore;
  const identities = { resolve: async (account: string) => input.wallets.get(account) ?? null,
    known: async () => null, reader: { wallet: async () => { throw Error('No configured fixture roots'); } } } as unknown as WalletIdentityStore;
  const graph = new LedgerGraphBuilder('localnet', adapter.source, store, [], undefined, identities,
    async account => { const state = await qualify(account); return { account, generation: account,
      head: { lt: state.lastTxLt!, hash: state.lastTxHash! }, complete: true, atBoundary: true, errorCode: null }; },
    256, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], [], undefined, undefined, undefined, binding);
  const now = Date.now; Date.now = () => adapter.head.utime * 1000;
  try {
    const result = await graph.build(owner, owner, { boundary: adapter.head });
    assert(result.currentLaunchpadBinding, 'all current canonical getters and original cold-account envelopes qualify the actual graph');
    assert(result.currentLaunchpadBinding.discoveredChildren!.length >= 2);
    assert(!result.issues.includes('launchpad_current_discovery_unavailable'));
    assert.equal(result.bindings[`current-launchpad:${binding.manifest.contracts.SaleFactory!.address}`], true);
    const cold = [...result.chains.values()].filter(chain => !chain.transactions.length);
    assert(cold.length > 0, 'native cold-wallet originals are exercised');
    for (const chain of cold) { assert(chain.historyComplete && chain.atBoundary); await qualify(chain.account); }
    return 5 + cold.length;
  } finally { Date.now = now; }
}

async function main() {
  let checks = 0;
  for (const { file, capture, requests } of currentLaunchpadCaptures()) {
    const originals: OrderTransactionEvidence[] = capture.completeTransactions;
    const binding = currentLaunchpadBindingFromManifest(capture.release);
    if (file === 'complete/0-default-complete.json') {
      const first = capture.originalCurrentAccounts[0];
      assert.throws(() => originalProductCaptureAdapter({ ...capture, originalCurrentAccounts: [{ ...first, head: { ...first.head, seqno: first.head.seqno + 1 } }] }), /exact captured head/);
      assert.throws(() => originalProductCaptureAdapter({ ...capture, originalCurrentAccounts: [first, first] }), /Duplicate original current account/);
      assert.throws(() => originalProductCaptureAdapter({ ...capture, originalCurrentAccounts: [{ ...first, address: capture.originalCurrentAccounts[1].address }] }), /account address mismatch/);
      checks += 3;
    }
    const txs = originals.map(verifyLaunchpadTransaction), latest = new Map<string, typeof txs[number]>();
    for (const t of txs) if (!latest.has(t.account) || latest.get(t.account)!.tx.lt < t.tx.lt) latest.set(t.account, t);
    const read = async (account: string) => { const t = latest.get(account); assert(t, `original current account ${account}`); return t.after; };
    const supplies = txs.flatMap(origin => origin.tx.outMessages.values().flatMap(message => {
      if (message.info.type !== 'internal' || message.info.bounced) return [];
      const transfer = maybe(() => tokenTransfer(message.body));
      if (!transfer || transfer.payload.bits.length || transfer.payload.refs.length) return [];
      const target = latest.get(transfer.owner), child = target && maybe(() => launchpadChild(target, binding, true));
      if (!child?.config || ![0, 2].includes(child.identity.role)) return [];
      return [{ origin, message, transfer, child }];
    }));
    assert(supplies.some(s => s.child.identity.role === 0)); assert(supplies.some(s => s.child.identity.role === 2));
    const owner = supplies[0].origin.account;
    checks += await positiveGraph(capture, owner);
    console.log(`${file}: actual graph qualified from exact native current account/getter observations`);
    if (!file.startsWith('complete/0-')) continue;
    const targets = [...new Set(supplies.map(s => s.transfer.owner))];
    const selected = await discoverCurrentLaunchpadSupplies([...targets, owner], binding, read, 256);
    assert.deepEqual(new Set(selected), new Set(targets), 'generic owner recipient is not admitted as a product');
    const discovered = await discoverCurrentLaunchpad(owner, selected, binding, read, 256);
    assert(targets.every(t => discovered.children.includes(t)));
    await assert.rejects(discoverCurrentLaunchpadSupplies(targets, binding, read, 0));
    const wrong = { ...binding, manifest: { ...binding.manifest, templates: { ...binding.manifest.templates, SaleFixed: 'f'.repeat(64), VestingVault: 'e'.repeat(64) } } };
    assert.deepEqual(await discoverCurrentLaunchpadSupplies(targets, wrong, read, 256), [], 'observed code cannot authorize another template'); checks += 4;

    // Exercise the actual graph with only an empty-forward supply in the owner
    // history. Getter outage is deliberate: discovery must reach the canonical
    // child, while incomplete wallet qualification must not publish a binding.
    for (const supply of [supplies.find(s => s.child.identity.role === 0)!, supplies.find(s => s.child.identity.role === 2)!]) {
      const input = currentLaunchpadProjectionFixture({ binding, request: { owner: supply.origin.account }, completeTransactions: originals });
      const histories = new Map([...input.chains].map(([a, c]) => [a, c.transactions]));
      histories.set(supply.origin.account, histories.get(supply.origin.account)!.filter(t => BigInt(t.lt) === supply.origin.tx.lt));
      const loaded: string[] = [], head = fixtureHead(1, Math.floor(Date.now() / 1000));
      const store = { rawHistory: async (a: string) => (histories.get(a) ?? []).map(raw => ({ raw })),
        pool: { query: async (sql: string) => { assert(sql.startsWith('SELECT source_complete')); return { rows: [{ complete: true, head_observed_at: new Date().toISOString() }] }; } } } as unknown as PostgresLedgerStore;
      const source = fakeChainSource({ network: 'localnet', getAccountState: async (a, options) => {
        assert.deepEqual(options?.at, head); const t = latest.get(a); assert(t);
        const original = originals.find(e => e.account === a && verifyLaunchpadTransaction(e).hash === t.hash)!;
        return boundaryState(a, original.afterShardAccountBoc, 1).state;
      }, runGetMethod: async () => { throw Error('Explicit unavailable wallet getter'); } });
      const identities = { resolve: async (a: string) => input.wallets.get(a) ?? null,
        known: async () => null, reader: { wallet: async () => { throw Error('No configured roots'); } } } as unknown as WalletIdentityStore;
      const graph = new LedgerGraphBuilder('localnet', source, store, [], undefined, identities,
        async a => { loaded.push(a); return { account: a, generation: a, head: null, complete: true, atBoundary: true, errorCode: null }; },
        256, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], [], undefined, undefined, undefined, binding);
      const result = await graph.build(supply.origin.account, supply.origin.account, { boundary: head });
      assert(loaded.includes(supply.transfer.owner), 'supply-only graph loads independently canonical child');
      assert.equal(result.currentLaunchpadBinding, undefined, 'missing getter retains configured-but-unqualified exclusion');
      assert(result.issues.includes('launchpad_current_discovery_unavailable')); checks += 3;
      const onlyOrigin = originals.filter(e => e.account === supply.origin.account && verifyLaunchpadTransaction(e).hash === supply.origin.hash);
      const hint = { ...binding, discoveredChildren: discovered.children };
      const missing = decodeCurrentLaunchpadOperations(supply.origin.account, hint, onlyOrigin).find(o => o.economics.requestBodyHash === supply.message.body.hash().toString('hex'));
      assert(missing); assert.equal(missing.economics.outcome, 'unresolved'); assert.equal(missing.economics.creator, null); assert.deepEqual(missing.economics.cash, []); checks += 4;
    }

    for (const request of requests.filter(r => r.kind === 'claim' || r.kind === 'contribute')) {
      const full = decodeCurrentLaunchpadOperations(request.owner, binding, originals).find(o => o.economics.dispatch.hash === request.dispatch.hash && o.economics.requestBodyHash === request.bodyHash);
      assert(full); assert.notEqual(full.economics.outcome, 'unresolved');
      const origin = txs.find(t => t.hash === request.dispatch.hash)!;
      const message = origin.tx.outMessages.values().find(m => m.body.hash().toString('hex') === request.bodyHash)!;
      const first = txs.find(t => receives(origin, message, t)); assert(first);
      for (const removed of [new Set([first.hash]), new Set(txs.filter(t => t.account === request.target).map(t => t.hash))]) {
        const rows = originals.filter(e => !removed.has(verifyLaunchpadTransaction(e).hash));
        const missing = decodeCurrentLaunchpadOperations(request.owner, binding, rows).find(o => o.economics.dispatch.hash === request.dispatch.hash && o.economics.requestBodyHash === request.bodyHash);
        assert(missing, 'original current intent survives missing original recipient'); assert.equal(missing.economics.outcome, 'unresolved');
        assert(missing.economics.issues.includes('launchpad_current_evidence_incomplete')); assert.deepEqual(missing.economics.cash, []); checks += 4;
      }
      if (request.kind === 'claim') {
        const uncovered = currentLaunchpadProjectionFixture({ binding, request, completeTransactions: originals });
        const root = full.economics.projectRoot!;
        assert(full.economics.evidenceHashes.some(hash => txs.some(t => t.account === root && t.hash === hash)), 'exact original master boundary is an operation dependency');
        const rootChain = uncovered.chains.get(root)!; rootChain.historyComplete = false; rootChain.atBoundary = false;
        const rootProjection = await projectOwnerLedger(uncovered);
        const rootEvent = rootProjection.events.find(e => e.settlement?.currentLaunchpad?.dispatch.hash === request.dispatch.hash);
        assert(rootEvent); assert.equal(rootEvent.settlement!.status, 'incomplete', 'present original master bytes do not imply covered master history'); checks += 3;
        const input = currentLaunchpadProjectionFixture({ binding, request, completeTransactions: originals });
        input.chains.get(request.target)!.transactions = input.chains.get(request.target)!.transactions.filter(t => canonicalLedgerHash(t.hash) !== canonicalLedgerHash(first.hash));
        const projection = await projectOwnerLedger(input);
        const event = projection.events.find(e => e.settlement?.currentLaunchpad?.dispatch.hash === request.dispatch.hash);
        assert(event); assert.equal(event.settlement!.status, 'incomplete'); assert.equal(event.settlement!.currentLaunchpad!.outcome, 'unresolved'); checks += 3;
      }
    }
    console.log(`${file}: canonical supply-only graph and missing-original current-intent checks passed`);
  }
  console.log(`Current Launchpad discovery/intent ${checks} checks passed; current hints never qualify missing historical economics.`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
