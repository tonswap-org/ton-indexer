import assert from 'node:assert/strict';
import { Address, beginCell, contractAddress, type TupleItem } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { WalletIdentityStore } from '../ledger/identities';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';

import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';

async function main() {
  const db = new PGlite();
  const pool: LedgerSqlPool = { query: async (sql, params) => !params && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params),
    connect: async () => pool, end: () => db.close() };
  const store = new PostgresLedgerStore(pool);
  const owner = new Address(0, Buffer.alloc(32, 1)), root = new Address(0, Buffer.alloc(32, 2));
  const code = beginCell().storeUint(1, 8).endCell(), foreign = beginCell().storeUint(2, 8).endCell(), rootCode = beginCell().storeUint(3, 8).endCell();
  const data = beginCell().storeCoins(0).storeAddress(owner).storeAddress(root).endCell();
  const wallet = contractAddress(0, { code, data }).toRawString(), impostor = new Address(0, Buffer.alloc(32, 9)).toRawString();
  const foreignOwner = new Address(0, Buffer.alloc(32, 8));
  const deployedForeign = new Address(0, Buffer.alloc(32, 7)).toRawString();
  const cycle = { boundary: fixtureHead(20), signal: new AbortController().signal };
  let offline = false, reads = 0, foreignDeclared = false;
  const addressItem = (address: Address): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(address).endCell() });
  const source = fakeChainSource({
    getAccountState: async (address, options) => {
      reads++; assert.deepEqual(options?.at, cycle.boundary); assert.equal(options?.signal, cycle.signal);
      if (offline) throw Error('offline');
      if (address === root.toRawString()) return { balance: '0', accountState: 'active', codeBoc: rootCode.toBoc().toString('base64') };
      return { balance: '0', accountState: 'active', codeBoc: (address === wallet ? code : foreign).toBoc().toString('base64'),
        dataBoc: data.toBoc().toString('base64'), lastTxLt: '1', lastTxHash: Buffer.alloc(32, 1).toString('base64') };
    },
    runGetMethod: async (address, method, args, options) => {
      reads++; assert.deepEqual(options?.at, cycle.boundary); assert.equal(options?.signal, cycle.signal);
      if (offline) throw Error('offline');
      if (method === 'get_jetton_data') return { exitCode: 0, stack: [{ type: 'int', value: 0n }, { type: 'int', value: -1n }, { type: 'null' },
        { type: 'cell', cell: beginCell().storeUint(0, 8).storeDict(null).endCell() }, { type: 'cell', cell: foreignDeclared ? foreign : code }] };
      if (method === 'get_wallet_data') return { exitCode: 0, stack: [{ type: 'int', value: 1n }, addressItem(address === deployedForeign ? foreignOwner : owner), addressItem(root), { type: 'cell', cell: address === wallet ? code : foreign }] };
      if (method === 'get_wallet_address') return { exitCode: 0, stack: [addressItem(Address.parse(foreignDeclared ? deployedForeign : wallet))] };
      throw Error('unexpected getter');
    },
  });
  const make = () => new WalletIdentityStore({ network: 'testnet', store, source,
    tokens: [{ master: root.toRawString(), masterCodeHash: rootCode.hash().toString('hex'), walletCodeHash: (foreignDeclared ? foreign : code).hash().toString('hex'), decimals: 6, symbol: 'USD' }] });
  try {
    await store.initialize();
    const identities = make();
    offline = true;
    assert.equal(await identities.resolve(wallet, cycle), null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_wallet_identities')).rows[0].count, 0, 'failure is never persisted');
    offline = false;
    const identity = await identities.resolve(wallet, cycle);
    assert(identity); assert.equal(identity.owner, owner.toRawString()); assert.equal(identity.master, root.toRawString()); assert.equal(identity.decimals, 6);
    const row = (await pool.query('SELECT * FROM ledger_wallet_identities')).rows[0];
    assert.equal(row.code_hash, code.hash().toString('hex')); assert.equal(String(row.verified_seqno), '20');
    const before = reads; offline = true;
    assert.deepEqual(await make().resolve(wallet, cycle), identity, 'another identity store uses the durable qualification during a full source outage');
    assert.deepEqual(await make().known(owner.toRawString(), root.toRawString(), cycle), identity);
    assert.equal(reads, before, 'stored identity needs no getter or account read');
    assert.equal(await identities.resolve(wallet, { ...cycle, boundary: fixtureHead(19) }), null, 'future qualification is not used in an older cycle');
    offline = false;
    assert.equal(await identities.resolve(impostor, cycle), null, 'foreign account code cannot claim a template root identity');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_wallet_identities')).rows[0].count, 1);
    foreignDeclared = true;
    assert.equal(await identities.resolve(deployedForeign, cycle), null, 'changed observed root declaration cannot enroll a new wallet implementation');
    assert.equal(await make().resolve(wallet, cycle), null, 'durable row cannot cross a changed manifest wallet pin');
    const external = await make().resolve(deployedForeign, cycle);
    assert(external, 'a foreign TEP-74 wallet is qualified only by the matching root-declared code/address and getter');
    assert.equal(external.owner, foreignOwner.toRawString());
    console.log('wallet identities: durable qualification, outage reuse, retry after failure, boundary pinning, code/address rejection and foreign root qualification passed');
  } finally { await db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
