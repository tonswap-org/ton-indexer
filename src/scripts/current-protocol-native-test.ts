import assert from 'node:assert/strict';
import { boundaryState, boundaryTransaction } from '../runtime/physicalEvidence';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalLedgerHash } from '../ledger/normalize';
import { projectOwnerLedger, type ProjectionInput, type Node } from '../ledger/project';
import { projectCurrentProtocolObservations, ownerConnectedProtocolNodes, type CurrentProtocolRole } from '../ledger/currentProtocolEvents';
import { verifySpotMessageLink } from '../ledger/currentDlmmPhysical';
import { LedgerGraphBuilder } from '../ledger/graph';
import type { PostgresLedgerStore } from '../ledger/store';
import type { WalletIdentityStore } from '../ledger/identities';
import type { LedgerStateSnapshot } from '../ledger/archive';
import type { LedgerEvent } from '../ledger/types';
import { loadOpcodes } from '../utils/opcodes';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { currentGovernanceFixture } from './support/currentGovernanceFixture';
import { currentProtocolFixture } from './support/currentProtocolFixture';
import { currentRouteFixture } from './support/currentRouteFixture';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';

const key = (a: string, l: string, h: string) => `${a}:${l}:${canonicalLedgerHash(h)}`;
// Source/coverage adapters are explicitly synthetic. Only the transaction and
// account cells below are native originals; this does not qualify public history.
function adapt(evidence: OrderTransactionEvidence[], owner: string, role: CurrentProtocolRole, codeHash: string, account: string) {
  const states = new Map<string, LedgerStateSnapshot>(), chains: ProjectionInput['chains'] = new Map(), nodes: Node[] = [];
  for (const e of evidence) {
    const raw = boundaryTransaction({ evidence: e, seqno: 1 });
    for (const boc of [e.beforeShardAccountBoc, e.afterShardAccountBoc]) {
      const state = boundaryState(e.account, boc, 1);
      states.set(key(e.account, state.state.lastTxLt!, state.state.lastTxHash!), state);
    }
    let chain = chains.get(e.account);
    if (!chain) { chain = { account: e.account, role: e.account === owner ? 'owner' : 'counterparty', generation: null,
      historyComplete: true, atBoundary: true, transactions: [] }; chains.set(e.account, chain); }
    chain.transactions.push(raw);
    nodes.push({ account: e.account, raw, id: key(e.account, raw.lt, raw.hash), ...(e.account === owner ? { event: {} as LedgerEvent } : {}) });
  }
  const base = runtimeManifestFixture(), release = runtimeManifestFixture({ network: 'ton:localnet', globalId: -3,
    ...(role === 'DlmmPool' ? { templates: { ...base.templates, DlmmPool: codeHash }, spotMarkets: [{ ...base.spotMarkets[0], pool: account }] }
      : { contracts: { ...base.contracts, [role]: { address: account, codeHash } } }) });
  const input: ProjectionInput = { network: 'localnet', owner, chains, wallets: new Map(), pools: new Map(), opcodes: loadOpcodes(),
    currentProtocolRelease: release, stateAt: async (a,l,h) => states.get(key(a,l,h)) ?? null };
  return { input, nodes };
}
const rowEvidence = (row: any): OrderTransactionEvidence => ({ account: row.account, transactionBoc: row.boc,
  beforeShardAccountBoc: row.before.originalShardAccount, afterShardAccountBoc: row.after.originalShardAccount });

async function disconnectedGraphRegression(input: ProjectionInput, nodes: Node[]) {
  const owner = nodes[0], child = nodes[1], release = input.currentProtocolRelease!, unrelated = release.contracts.Treasury!.address;
  const disconnected = { ...child.raw, inMessage: { ...child.raw.inMessage, createdLt: '99999999' },
    outMessages: [{ source: child.account, destination: unrelated, createdLt: '100000000', value: '1' }] };
  const histories = new Map([[owner.account, [owner.raw]], [child.account, [...Array.from({length:80}, () => disconnected), child.raw]]]);
  const reads: string[] = [];
  const store = { pool: { query: async () => ({ rows: [{ source_complete: true, complete: true, head_lt: owner.raw.lt,
    head_hash: owner.raw.hash, head_observed_at: new Date(0) }] }) }, rawHistory: async (account: string) => {
    const rows = histories.get(account); assert(rows, `Unrelated archive read: ${account}`); return rows.map(raw => ({ raw }));
  } } as unknown as PostgresLedgerStore;
  const identities = { resolve: async () => null, known: async () => null } as unknown as WalletIdentityStore;
  const graph = new LedgerGraphBuilder('localnet', fakeChainSource({ network: 'localnet' }), store, [], undefined, identities, async account => {
    reads.push(account); const rows = histories.get(account);
    return { account, generation: rows ? account : null, complete: !!rows, atBoundary: !!rows,
      head: rows ? {lt:rows.at(-1)!.lt,hash:rows.at(-1)!.hash} : null, errorCode: rows ? null : 'unavailable' };
  }, 256, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], [], undefined,
  undefined, {release,pools:[]});
  const result = await graph.build(owner.account, owner.account, { boundary: fixtureHead(1, owner.raw.utime) });
  assert(result.chains.has(child.account)); assert(!result.chains.has(unrelated)); assert(!reads.includes(unrelated));
  assert.equal(result.pendingAccounts.length, 0, 'An unrelated singleton outage cannot degrade owner coverage');
}

async function qualifyRows(role: CurrentProtocolRole, codeHash: string, rows: any[]) {
  const names = new Set<string>(); let positives = 0, refused = 0;
  let checkedNegatives = false;
  for (const row of rows) {
    const evidence = rowEvidence(row), original = verifyOrderTransaction(evidence);
    const state = original.before.account?.storage.state;
    if (state?.type !== 'active' || state.state.code?.hash().toString('hex') !== codeHash) continue;
    const { input, nodes } = adapt([evidence], row.account, role, codeHash, row.account);
    const facts = [...(await projectCurrentProtocolObservations(input, nodes)).values()].flat();
    if (!original.succeeded) { assert.equal(facts.length, 0); refused++; continue; }
    for (const fact of facts) { names.add(fact.name); assert.equal(fact.codeHash, codeHash); assert.equal(fact.role, role);
      assert.equal(fact.transaction.hash, canonicalLedgerHash(row.hash)); assert.equal(fact.evidence.length, 1); }
    if (!facts.length) continue;
    positives += facts.length;
    if (checkedNegatives) continue;
    checkedNegatives = true;
    const without = await projectOwnerLedger({ ...input, currentProtocolRelease: undefined });
    const withFacts = await projectOwnerLedger(input);
    assert.deepEqual(withFacts.events.flatMap(e => e.protocolObservations ?? []), facts);
    const stripped = { ...withFacts, events: withFacts.events.map(({ protocolObservations: ignored, ...event }) => event) };
    assert.deepEqual(stripped, without, 'Lifecycle facts never create cash, change settlement or clear missing-evidence issues');
    assert.equal((await projectCurrentProtocolObservations({ ...input, currentProtocolRelease: undefined }, nodes)).size, 0);
    assert.equal((await projectCurrentProtocolObservations({ ...input, stateAt: async () => null }, nodes)).size, 0);
    assert.equal((await projectCurrentProtocolObservations(input, nodes.map(n => ({ ...n, raw: { ...n.raw, rawBoc: undefined } })))).size, 0);
    assert.equal((await projectCurrentProtocolObservations(input, nodes.map(n => ({ ...n, raw: { ...n.raw, utime: n.raw.utime+1 } })))).size, 0);
    const wrongCode = structuredClone(input.currentProtocolRelease!);
    if (role === 'DlmmPool') wrongCode.templates.DlmmPool = 'f'.repeat(64); else wrongCode.contracts[role]!.codeHash = 'f'.repeat(64);
    assert.equal((await projectCurrentProtocolObservations({ ...input, currentProtocolRelease: wrongCode }, nodes)).size, 0);
    input.chains.get(row.account)!.historyComplete = false;
    assert.equal((await projectCurrentProtocolObservations(input, nodes)).size, 0);
  }
  return { names, positives, refused };
}

async function main() {
  // Use the production-Hub route corpus: all three lifecycle events must join
  // the same original owner dispatch through physical wallet message edges.
  // Synthetic head/coverage adapters still do not establish public consensus.
  for (const { file, capture: c } of currentRouteFixture().cases()) {
    const { input, nodes } = adapt(c.transactions, c.request.owner, 'DlmmPool', c.manifest.templates.DlmmPool, c.request.pool);
    input.currentProtocolRelease = c.manifest;
    const facts = await projectCurrentProtocolObservations(input, nodes), all = [...facts.values()].flat();
    const swaps = all.filter(f => f.name === 'pool-swap'), routes = all.filter(f => f.name === 'route-continuation');
    assert.equal(swaps.length, c.mode === 'first-refund' ? 1 : 2, `${file}: original pool events`);
    assert.equal(routes.length, c.mode === 'first-refund' ? 0 : 1, `${file}: original coordinator event`);
    assert(facts.size === 1 && facts.has(nodes[0].id), `${file}: one original owner dispatch`);
    assert(all.every(f => f.evidence.at(-1)!.account === c.request.owner && f.evidence.length >= 4));
    assert.equal((await projectCurrentProtocolObservations(input, nodes.filter(n => n.account !== c.request.owner))).size, 0,
      `${file}: event query IDs never substitute for the original owner`);
    if (c.mode !== 'first-refund') {
      const incomplete = await projectCurrentProtocolObservations(input, nodes.filter(n => n.account !== c.request.coordinator));
      const remaining = [...incomplete.values()].flat();
      assert.equal(remaining.filter(f => f.name === 'pool-swap').length, 1);
      assert(!remaining.some(f => f.name === 'route-continuation'), `${file}: missing continuation cannot join downstream events`);
    }
    console.log(file, 'original owner-linked route observations', all.length);
  }
  const governance = currentGovernanceFixture();
  for (const c of governance.cases) {
    const result = await qualifyRows('Governance', governance.codeHash, c.rows);
    assert(result.positives > 0);
    for (const name of ['governance-handoff','governance-proposal','governance-vote','governance-lock']) assert(result.names.has(name), `${c.name} missing ${name}`);
    console.log(c.name, 'Governance native lifecycle facts', result.positives, 'failed boundaries refused', result.refused);
    const originals: Array<{row:any;evidence:OrderTransactionEvidence;original:ReturnType<typeof verifyOrderTransaction>&{account:string}}> =
      c.rows.map((row: any) => ({ row, evidence: rowEvidence(row), original: { account: row.account, ...verifyOrderTransaction(rowEvidence(row)) } }));
    let causal = false;
    for (const child of originals) {
      const state = child.original.before.account?.storage.state;
      if (state?.type !== 'active' || state.state.code?.hash().toString('hex') !== governance.codeHash) continue;
      const parent = originals.find(p => p.row.account !== child.row.account && verifySpotMessageLink(p.original, child.original));
      if (!parent) continue;
      const { input, nodes } = adapt([parent.evidence, child.evidence], parent.row.account, 'Governance', governance.codeHash, child.row.account);
      const facts = await projectCurrentProtocolObservations(input, nodes);
      if (!facts.size) continue;
      assert.equal(facts.size, 1); assert(facts.has(nodes[0].id));
      assert(facts.get(nodes[0].id)!.every(f => f.evidence.length === 2 && f.evidence[1].account === parent.row.account));
      assert.equal((await projectCurrentProtocolObservations(input, nodes.slice(1))).size, 0, 'A missing original owner dispatch cannot be supplied by query ID');
      assert.equal((await projectCurrentProtocolObservations(input, [{ ...nodes[0], raw: { ...nodes[0].raw, rawBoc: undefined } }, nodes[1]])).size, 0);
      const disconnected = Array.from({ length: 80 }, (_, i) => ({ ...nodes[1], id: `disconnected:${i}`, raw: { ...nodes[1].raw,
        inMessage: { ...nodes[1].raw.inMessage, createdLt: String(999999+i) } } }));
      const reads: string[] = [], stateAt = input.stateAt;
      const crowded = await projectCurrentProtocolObservations({ ...input, stateAt: async (...args) => {
        reads.push(args[0]); return stateAt(...args);
      } }, [...disconnected, ...nodes]);
      assert.deepEqual(crowded, facts, 'Unrelated earlier shared-contract events cannot exhaust the original-boundary budget');
      assert(reads.length <= 4);
      const frontier = ownerConnectedProtocolNodes([...disconnected, ...nodes]);
      assert.equal(frontier.size, 2); assert(!disconnected.some(n => frontier.has(n)), 'Shared history is not an owner root');
      await disconnectedGraphRegression(input, nodes);
      causal = true; break;
    }
    assert(causal, `${c.name}: no original linked owner/Governance pair qualified`);
  }
  const expected: Record<string, CurrentProtocolRole[]> = { claims: ['MerkleClaim','Treasury'], remint: ['Remint'],
    route: ['DlmmPool','SwapCoordinator'], gasVault: ['GasVault','FeeRouter'], owed: ['DlmmPool'] };
  for (const producer of currentProtocolFixture()) {
    let facts = 0; const names = new Set<string>();
    for (const c of producer.cases) for (const role of expected[producer.producer]) {
      const codeHash = producer.targets[role]?.codeHash; assert(codeHash, `Missing ${producer.producer}/${role} original code`);
      const result = await qualifyRows(role, codeHash, c.rows);
      facts += result.positives; result.names.forEach(name => names.add(name));
    }
    assert(facts > 0); console.log(producer.producer, 'native original facts', facts, [...names].sort().join(', '));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
