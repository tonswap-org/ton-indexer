import assert from 'node:assert/strict';
import { Address, beginCell, Cell, Dictionary, storeShardAccount, type TupleItem } from '@ton/core';
import Fastify from 'fastify';
import { createGovernanceSnapshotReader, GOVERNANCE_ACTION_BYTES_LIMIT } from '../runtime/governanceSnapshot';
import { governanceProposalTiming, readGovernanceStorage } from '../utils/governanceStorage';
import { ChainReadError, type AccountStateResponse, type ChainHead } from '../data/dataSource';
import { orderShard } from '../orders/evidence';
import { currentGovernanceFixture } from './support/currentGovernanceFixture';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { registerRoutes } from '../api/routes';
import { IndexerService } from '../indexerService';
import { loadConfig } from '../config';
import { loadOpcodes } from '../utils/opcodes';
import { MemoryStore } from '../store/memoryStore';
const fixture = currentGovernanceFixture(), wall = Date.now;
const unavailable = (error: unknown) => error instanceof ChainReadError && error.code === 'upstream_unavailable';
const getState = (row: any) => readGovernanceStorage(Cell.fromBase64(row.after.dataBoc));
const rows = fixture.cases.flatMap(c => c.rows.filter((row: any) => row.after.codeBoc && Cell.fromBase64(row.after.codeBoc).hash().toString('hex') === fixture.codeHash));
const sample = rows.find((row: any) => getState(row).props.proposals.size > 0 && !getState(row).props.proposals.values()[0].queued)!;
assert(sample);
const defaultParams = fixture.probe.rows.find((row: any) => row.params).params as string[][];
const manifest = runtimeManifestFixture({ contracts: { ...runtimeManifestFixture().contracts, Governance: { address: sample.account, codeHash: fixture.codeHash } } });
let selected = sample, head = fixtureHead(100, sample.utime), reads = 0;
let mutate: (state: AccountStateResponse) => AccountStateResponse = value => value;
let badGetter = '', wrongHead = false, hang = false;
const source = fakeChainSource({ head: async () => head, read: async (calls, options) => {
  reads++; assert.equal(options?.at, head); assert(options?.signal); await Promise.resolve();
  if (hang) return new Promise(() => {});
  assert.equal(calls.length, 4);
  const state: AccountStateResponse = { balance: String(selected.after.balance), accountState: 'active',
    codeBoc: selected.after.codeBoc, dataBoc: selected.after.dataBoc, shardAccountBoc: selected.after.originalShardAccount,
    lastTxLt: selected.after.lastTxLt, lastTxHash: selected.after.lastTxHash, sourceMasterchain: head,
    anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: selected.utime } };
  return { head: wrongHead ? { ...head, fileHashHex: 'a'.repeat(64) } : head, results: calls.map((call, index) => {
    assert.equal(call.address, selected.account);
    if (call.kind === 'account') return { kind: 'account' as const, address: call.address, state: mutate(state) };
    assert.equal(call.method, 'get_params', 'Only the current params getter is used; locks/proposals come from verified original storage');
    assert.deepEqual(call.args, [{ type: 'int', value: BigInt(index - 1) }]);
    const stack: TupleItem[] = defaultParams[index - 1].map(value => ({ type: 'int', value: BigInt(value) }));
    return { kind: 'getter' as const, address: badGetter === 'address' ? `0:${'a'.repeat(64)}` : call.address,
      exitCode: badGetter === 'exit' ? 11 : 0, stack: badGetter === 'missing' ? [] : badGetter === 'layout' ? [{ type: 'null' as const }] : stack };
  }) };
} });
const read = createGovernanceSnapshotReader(manifest, source);
const setRow = (row: any, now = row.utime) => { selected = row; head = fixtureHead(head.seqno + 1, now); Date.now = () => now * 1000; };
const config = { ...loadConfig(), network: 'testnet' as const };
async function main() {
  // Every positive data cell belongs to an authenticated original native producer.
  let nativeComparisons = 0;
  for (const c of fixture.cases) {
    assert.match(c.testName, /default|x6/);
    for (const row of c.rows) if (row.after.codeBoc && Cell.fromBase64(row.after.codeBoc).hash().toString('hex') === fixture.codeHash) getState(row);
    const probe = fixture.probe.rows.filter((p: any) => p.case === c.name && p.observations);
    for (const p of probe) {
      const row = c.rows.find((r: any) => r.hash === p.transactionHash)!; assert(row);
      const proposal = getState(row).props.proposals.get(p.id)!; assert(proposal);
      const values = defaultParams[proposal.class].map(Number);
      const params = { bucket: values[0], minVote: values[1], maxVote: values[2], review: values[3], delay: values[4], grace: values[5] };
      for (const observation of p.observations) {
        const timing = governanceProposalTiming(proposal, params, observation.now);
        assert.equal(timing.closeAt, observation.close); assert.equal(timing.eta, observation.eta);
        assert.equal(timing.status, ['absent', 'voting', 'closed', 'queued', 'expired'][observation.status]); nativeComparisons++;
      }
    }
  }
  assert(nativeComparisons >= 60);
  setRow(sample);
  const original = getState(sample), owner = original.stake.locks.keys()[0].toRawString();
  const same = await Promise.all(Array.from({ length: 10 }, () => read(sample.account, { owner, maxScan: 1 })));
  assert.equal(reads, 1, 'Concurrent current reads share exactly one batch');
  assert(same.every(value => value.proposals.length === 1));
  assert.deepEqual(same[0].lock, original.stake.locks.get(Address.parse(owner)));
  assert.equal(same[0].dataHash, Cell.fromBase64(sample.after.dataBoc).hash().toString('hex'));
  assert.equal(same[0].codeHash, fixture.codeHash); assert.deepEqual(same[0].asOf, head);
  assert.equal(same[0].page.historyComplete, false); assert(!('passed' in same[0].proposals[0]));
  const closeAt = same[0].proposals[0].closeAt;
  setRow(sample, closeAt); const closed = await read(sample.account, { owner, maxScan: 1 });
  assert.equal(reads, 2, 'An unchanged account does not cache a time-dependent snapshot');
  assert.equal(closed.proposals[0].status, 'closed'); assert.equal(closed.lock?.amountRaw, same[0].lock?.amountRaw);
  const last = rows.at(-1)!; setRow(last);
  const nextId = getState(last).props.nextId; assert(nextId > 8);
  let cursor: string | null = '1'; const allocated = new Set<string>();
  while (cursor !== null) {
    const page = await read(last.account, { startId: cursor, maxScan: 2 });
    assert(page.page.scanned <= 2); assert.equal(page.page.complete, true);
    for (const id of [...page.proposals.map(p => p.id), ...page.prunedProposalIds]) { assert(!allocated.has(id)); allocated.add(id); }
    cursor = page.page.nextStartId;
  }
  assert.equal(allocated.size, nextId - 1);
  const beyond = await read(last.account, { startId: String(nextId), owner: `0:${'e'.repeat(64)}` });
  assert.equal(beyond.page.scanned, 0); assert.deepEqual(beyond.prunedProposalIds, []); assert.equal(beyond.lock, null);
  assert.equal(beyond.nextProposalId, String(nextId)); assert.equal(beyond.page.nextStartId, null);
  for (const change of [
    (s: AccountStateResponse) => ({ ...s, codeBoc: Cell.EMPTY.toBoc().toString('base64') }),
    (s: AccountStateResponse) => ({ ...s, dataBoc: null }),
    (s: AccountStateResponse) => ({ ...s, shardAccountBoc: undefined }),
    (s: AccountStateResponse) => ({ ...s, accountState: 'frozen' as const }),
    (s: AccountStateResponse) => ({ ...s, lastTxLt: '1' }),
    (s: AccountStateResponse) => ({ ...s, anchor: undefined }),
    (s: AccountStateResponse) => ({ ...s, sourceMasterchain: { ...head, seqno: head.seqno + 1 } }),
    (s: AccountStateResponse) => {
      const shard = orderShard(s.shardAccountBoc!, selected.account).shard;
      assert(shard.account?.storage.state.type === 'active'); shard.account.storage.state.state.data = Cell.EMPTY;
      return { ...s, dataBoc: Cell.EMPTY.toBoc().toString('base64'), shardAccountBoc: beginCell().store(storeShardAccount(shard)).endCell().toBoc().toString('base64') };
    },
  ]) { mutate = change; await assert.rejects(read(last.account), unavailable); }
  // Synthetic oversized current-layout storage is a refusal vector, never a
  // native positive. Shared cells must not amplify a small account into a huge page.
  let layer = Array.from({ length: 2500 }, (_, id) => beginCell().storeUint(id, 32).storeBuffer(Buffer.alloc(120)).endCell());
  while (layer.length > 1) {
    const next: Cell[] = [];
    for (let index = 0; index < layer.length; index += 4) {
      const b = beginCell(); layer.slice(index, index + 4).forEach(c => b.storeRef(c)); next.push(b.endCell());
    }
    layer = next;
  }
  const sharedActions = layer[0], originalProposal = getState(sample).props.proposals.values()[0];
  const amplified = Dictionary.empty(Dictionary.Keys.Uint(32), { parse() { throw Error('Write-only negative'); },
    serialize(slot: number, b: ReturnType<typeof beginCell>) {
      const p = originalProposal, t = p.tally;
      b.storeAddress(Address.parse(p.proposer)).storeUint(0, 2).storeBit(false).storeUint(slot, 4)
        .storeUint(p.start, 32).storeUint(p.decidedAt, 32).storeCoins(BigInt(p.valueTotalRaw)).storeUint(BigInt('0x' + p.descriptionHash), 256)
        .storeRef(beginCell().storeCoins(BigInt(t.quorumRaw)).storeCoins(BigInt(t.participationRaw)).storeUint(BigInt(t.yesRaw), 122).storeUint(BigInt(t.noRaw), 122).endCell())
        .storeRef(sharedActions);
    } });
  for (let id = 1; id <= 3; id++) amplified.set(id, id - 1);
  const props = beginCell().storeUint(4, 32).storeUint(3, 8).storeCoins(BigInt(originalProposal.valueTotalRaw) * 3n);
  Array.from({ length: 16 }, (_, id) => id < 3 ? id + 1 : 0).forEach(id => props.storeUint(id, 32));
  const originalData = Cell.fromBase64(last.after.dataBoc), refs = [...originalData.refs]; refs[refs.length - 1] = props.storeDict(amplified).endCell();
  const amplifiedData = new Cell({ bits: originalData.bits, refs }); assert.equal(readGovernanceStorage(amplifiedData).props.proposals.size, 3);
  assert(amplifiedData.toBoc().length < GOVERNANCE_ACTION_BYTES_LIMIT);
  assert(sharedActions.toBoc().toString('base64').length * 3 > GOVERNANCE_ACTION_BYTES_LIMIT);
  mutate = s => {
    const shard = orderShard(s.shardAccountBoc!, selected.account).shard; assert(shard.account?.storage.state.type === 'active');
    shard.account.storage.state.state.data = amplifiedData;
    return { ...s, dataBoc: amplifiedData.toBoc().toString('base64'), shardAccountBoc: beginCell().store(storeShardAccount(shard)).endCell().toBoc().toString('base64') };
  };
  assert.equal((await read(last.account, { maxScan: 1 })).proposals.length, 1, 'One bounded serialization fits');
  await assert.rejects(read(last.account, { maxScan: 3 }), unavailable, 'Repeated shared actions cannot amplify the response');
  mutate = value => value;
  for (const value of ['exit', 'missing', 'layout', 'address']) { badGetter = value; await assert.rejects(read(last.account), unavailable); }
  badGetter = ''; wrongHead = true; await assert.rejects(read(last.account), unavailable); wrongHead = false;
  const badPin = runtimeManifestFixture({ contracts: { ...manifest.contracts, Governance: { address: sample.account, codeHash: 'f'.repeat(64) } } });
  await assert.rejects(createGovernanceSnapshotReader(badPin, source)(sample.account), unavailable);
  await assert.rejects(read(`0:${'a'.repeat(64)}`), unavailable);
  const empty = beginCell().endCell(), retired = beginCell().storeRef(empty).storeUint(0, 320).storeRef(empty).storeCoins(0).storeCoins(0).storeUint(2, 64).storeRef(empty).storeRef(empty).endCell();
  assert.throws(() => readGovernanceStorage(retired));
  assert.throws(() => readGovernanceStorage(beginCell().storeSlice(Cell.fromBase64(last.after.dataBoc).beginParse()).storeBit(false).endCell()));
  hang = true; await assert.rejects(read(last.account, {}, AbortSignal.timeout(10)), error => error instanceof ChainReadError && error.code === 'upstream_timeout'); hang = false;
  setRow(last); assert.equal((await read(last.account)).nextProposalId, String(nextId), 'Cancelled work releases the in-flight entry');
  const service = new IndexerService(config, new MemoryStore(config), source, loadOpcodes(), []), app = Fastify();
  registerRoutes(app, config, service, undefined, undefined, undefined, undefined, {},
    { runtime: manifest, releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, registryHash: '' }, { source });
  const url = `/api/indexer/v1/governance/${sample.account}/snapshot`;
  const response = await app.inject({ url }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['x-tonswap-release'], manifest.manifestHash);
  assert.equal(response.json().schema, 'tonswap-governance-snapshot-v1');
  for (const query of ['start_id=4294967296', 'start_id=0', 'max_scan=65', 'owner=invalid']) assert.equal((await app.inject({ url: `${url}?${query}` })).statusCode, 400);
  assert.equal((await app.inject({ url: url.replace(sample.account, `0:${'a'.repeat(64)}`) })).statusCode, 400);
  badGetter = 'exit'; const failed = await app.inject({ url }); assert.equal(failed.statusCode, 503); assert.equal(failed.headers['cache-control'], 'no-store'); badGetter = '';
  await app.close();
  const unbound = Fastify(); registerRoutes(unbound, config, service);
  assert.equal((await unbound.inject({ url })).statusCode, 503); await unbound.close();
  console.log(`Current Governance: ${fixture.cases.length} source-bound native profiles, ${nativeComparisons} native timing comparisons; exact-head API, lock/proposal storage, pruned pagination, cache/cancellation and refusal cases passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = wall; });
