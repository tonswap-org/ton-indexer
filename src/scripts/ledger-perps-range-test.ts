import { Address, beginCell } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { testPerpsRangeWalletIdentity } from './ledger-perps-range-wallet-test';
import { readFileSync } from 'node:fs';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import assert from 'node:assert/strict';
import { LiteClientDataSource } from '../data/liteClientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';
import { findTransactionState } from '../ledger/archive';
import { capturePerpsRangeChain, discoverPerpsRangePeers, ledgerFailureCode } from '../ledger/perpsRange';
import type { TonDataSource, RawTransaction } from '../data/dataSource';
const hash = (n: number) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').toString('base64');
const tx = (n: number, utime: number): RawTransaction => ({ lt: String(n), hash: hash(n), prevTransactionLt: String(n - 1),
  prevTransactionHash: hash(n - 1), utime, success: true, outMessages: [] });
const bounds = { fromUtime: 100, toUtime: 200 }, head = { balance: '0', accountState: 'active' as const, lastTxLt: '5', lastTxHash: hash(5) };
const budget = () => ({ pages: 10, deadline: Date.now() + 5000 });
async function main() {
  const engine = `0:${'1'.repeat(64)}`, engineWallet = `0:${'2'.repeat(64)}`;
  const peer = (n: number) => `0:${n.toString(16).padStart(64, '0')}`;
  const rvlt = beginCell().storeUint(0x52564c54, 32).storeUint(1, 64).storeUint(1, 16).storeUint(5, 256)
    .storeCoins(5).storeCoins(10).storeCoins(0).endCell();
  const outgoing = (destination: string, body = rvlt, source = engine) => ({ source, destination, body: body.toBoc().toString('base64') });
  const valid = discoverPerpsRangePeers([{ ...tx(1, 150), outMessages: [outgoing(peer(10))] }], engine, engineWallet);
  assert.deepEqual([...valid.peers], [peer(10)]);
  assert.deepEqual([...valid.custodyOwners], [peer(10)]);
  for (const invalid of [
    outgoing(peer(10), beginCell().storeSlice(rvlt.beginParse()).storeUint(0, 1).endCell()),
    outgoing(peer(10), rvlt, peer(11)),
    { ...outgoing(peer(10)), bounced: true },
  ]) assert.equal(discoverPerpsRangePeers([{ ...tx(1, 150), outMessages: [invalid] }], engine, engineWallet).peers.size, 0);
  assert.equal(discoverPerpsRangePeers([{ ...tx(1, 150), success: false, outMessages: [outgoing(peer(10))] }], engine, engineWallet).peers.size, 0);
  assert.throws(() => discoverPerpsRangePeers([{ ...tx(1, 150), outMessages: Array.from({ length: 33 }, (_, i) => outgoing(peer(i + 10))) }], engine, engineWallet), /protocol_account_limit/);
  const policy = beginCell().storeUint(0x52505251, 32).storeUint(1, 32).storeUint(7, 64).endCell();
  const credit = beginCell().storeUint(0x43524544, 32).storeUint(1, 64).storeUint(2, 32).storeAddress(Address.parse(peer(20))).storeCoins(5).storeAddress(null).endCell();
  const services = discoverPerpsRangePeers([{ ...tx(1, 150), outMessages: [outgoing(peer(12), policy), outgoing(peer(13), credit)] }], engine, engineWallet);
  assert.deepEqual([...services.peers], [peer(12), peer(13)]);
  assert.equal(services.custodyOwners.size, 0, 'Policy and referral accounting are not token custody');
  console.log('PASS current typed peer discovery rejects malformed/forged outputs and enforces a finite account bound');
  await testPerpsRangeWalletIdentity();
  const liteInfo = LiteClientDataSource.prototype.getMasterchainInfo;
  const info = await liteInfo.call({call: async (fn: any) => fn({getMasterchainInfoExt: async () => ({last: {seqno: 10}, lastUtime: 150, now: 999})})} as any);
  assert.deepEqual(info, {seqno: 10, timestamp: 150}, 'upper bound uses canonical block time, not server clock');
  const missing = await liteInfo.call({call: async (fn: any) => fn({getMasterchainInfoExt: async () => ({last: {seqno: 10}, now: 999})})} as any);
  assert.equal(missing.timestamp, undefined);
  const httpInfo = await TonClient4DataSource.prototype.getMasterchainInfo.call({getLastBlockCached: async () => ({last: {seqno: 10}, now: 999})} as any);
  assert.equal(httpInfo.timestamp, undefined, 'missing canonical HTTP block time is not fabricated from server time');
  const data = [tx(5, 220), tx(4, 199), tx(3, 100), tx(2, 99), tx(1, 50)];
  let calls = 0;
  const source = { getTransactions: async (_a: string, _limit: number, lt: string) => { calls++; return data.filter(t => BigInt(t.lt) <= BigInt(lt)).slice(0, 2); } } as TonDataSource;
  const result = await capturePerpsRangeChain(source, 'account', head, bounds, budget());
  assert.deepEqual(result.transactions.map(t => t.lt), ['4', '3']);
  assert.deepEqual(result.headTransactions.map(t => t.lt), ['5', '4', '3', '2']);
  assert.equal(result.boundary?.lt, '2');
  assert.equal(calls, 2, 'stops at lower witness without unrelated old tail');
  const bad = (mutate: (values: RawTransaction[]) => RawTransaction[]) => ({ getTransactions: async () => mutate(data.slice(0, 2)) }) as unknown as TonDataSource;
  await assert.rejects(() => capturePerpsRangeChain(bad(v => [{...v[0], hash: hash(8)}, v[1]]), 'account', head, bounds, budget()), /chain_unverified/);
  await assert.rejects(() => capturePerpsRangeChain(bad(v => [{...v[0], prevTransactionHash: hash(8)}, v[1]]), 'account', head, bounds, budget()), /chain_unverified/);
  await assert.rejects(() => capturePerpsRangeChain(bad(v => [v[0], {...v[1], utime: 221}]), 'account', head, bounds, budget()), /time_unverified/);
  await assert.rejects(() => capturePerpsRangeChain(source, 'account', head, bounds, { ...budget(), pages: 1 }), /capacity_exceeded/);
  await assert.rejects(() => capturePerpsRangeChain({getTransactions: async () => []} as any, 'account', head, bounds, budget()), /chain_unverified/);
  assert.deepEqual(await capturePerpsRangeChain(source, 'account', {balance: '0', accountState: 'uninitialized'}, bounds, budget()), {transactions: [], headTransactions: [], boundary: null});
  await assert.rejects(() => capturePerpsRangeChain(source, 'account', {balance: '0', accountState: 'uninitialized'}, bounds, {pages: 10, deadline: Date.now() - 1}), /capacity_exceeded/, 'Empty custody peers cannot bypass the shared work deadline');
  assert.equal(ledgerFailureCode({code: '22P05'}), 'ledger_storage_unavailable');
  assert.equal(ledgerFailureCode(Error('provider unavailable')), 'history_source_unavailable');
  assert.equal(ledgerFailureCode(Error('perps_range_chain_unverified')), 'perps_range_chain_unverified');
  const probes: number[] = [];
  let wrongReplay = false;
  const archival = { getMasterchainInfo: async () => ({seqno: 1000}),
    getAccountStateAtSeqno: async (_a: string, seq: number) => {
      probes.push(seq);
      if (seq < 800) throw Error('unrelated ancient archive unavailable');
      return {balance: '0', lastTxLt: seq < 900 ? '40' : '60', lastTxHash: hash(seq < 900 ? 40 : 60)};
    }, getAccountStateAtTransaction: async (_a: string, cursor: any, seq: number) => {
      assert.equal(seq, 900); assert.equal(cursor.lt, '50');
      return {balance: '0', lastTxLt: '50', lastTxHash: hash(wrongReplay ? 51 : 50)};
    } } as TonDataSource;
  assert.equal((await findTransactionState(archival, 'account', {lt: '50', hash: hash(50)}))?.seqno, 900);
  assert(probes.every(seq => seq >= 800), 'recent exact replay does not depend on ancient archives');
  probes.length = 0;
  assert.equal((await findTransactionState({...archival, getMasterchainInfo: async () => { throw Error('must retain captured head'); }}, 'account', {lt: '50', hash: hash(50)}, 910))?.seqno, 900);
  assert(probes.every(seq => seq <= 910), 'replay stays within the immutable captured head');
  wrongReplay = true;
  assert.equal(await findTransactionState(archival, 'account', {lt: '50', hash: hash(50)}), null, 'incorrect replay hash is never interpolated');
  assert.equal(await findTransactionState({...archival, getAccountStateAtTransaction: undefined}, 'account', {lt: '50', hash: hash(50)}), null);
  const db = new PGlite();
  const pool: LedgerSqlPool = { query: async (q, p) => !p && q.includes(';') ? { rows: (await db.exec(q)).at(-1)?.rows ?? [] } : db.query(q, p),
    connect: async () => pool, end: () => db.close() };
  try {
    const schema = readFileSync('sql/ledger.sql', 'utf8');
    await db.exec(schema);
    await db.query("INSERT INTO ledger_accounts(network,account,error_code) VALUES('testnet','retained','history_source_unavailable')");
    await db.query("INSERT INTO ledger_runs(generation,network,account,head_lt,next_lt) VALUES('11111111-1111-4111-8111-111111111111','testnet','retained',96066824000008,52040825000001)");
    const before = (await db.query('SELECT * FROM ledger_runs')).rows;
    const store = new PostgresLedgerStore(pool);
    await store.initialize();
    await store.initialize();
    assert.deepEqual((await db.query('SELECT * FROM ledger_runs')).rows, before, 'repeat canonical startup preserves existing cursor evidence');
    assert.equal(((await db.query('SELECT error_code FROM ledger_accounts')).rows[0] as any).error_code, 'history_source_unavailable');
    await db.exec(schema);
    assert.deepEqual((await db.query('SELECT * FROM ledger_runs')).rows, before, 'canonical schema initialization is idempotent');
    await db.query('SELECT generation,generation_order,status,snapshot,backoff_seconds,retry_after FROM ledger_perps_ranges LIMIT 0');
    await db.query('ALTER TABLE ledger_perps_ranges DROP COLUMN retry_after');
    await assert.rejects(store.initialize(), /retry_after/, 'an obsolete range schema fails instead of defaulting missing retry metadata');
  } finally { await db.close(); }
  console.log('Perps interval head, boundary, chain, capacity and storage failure regressions passed.');
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
