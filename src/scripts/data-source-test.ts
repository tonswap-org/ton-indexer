import assert from 'node:assert/strict';
import test from 'node:test';
import { Address, beginCell, Dictionary, serializeTuple, storeTransaction, type TupleItem } from '@ton/core';
import { ResilientTonDataSource } from '../data/resilientSource';
import { TonClient4DataSource } from '../data/tonClient4Source';
import { LiteClientDataSource } from '../data/liteClientSource';
import type { TonDataSource } from '../data/dataSource';

const owner = Address.parseRaw(`0:${'1'.repeat(64)}`), master = Address.parseRaw(`0:${'2'.repeat(64)}`);
const wallet = Address.parseRaw(`0:${'3'.repeat(64)}`), address = owner.toRawString();
const hash = Buffer.alloc(32, 4).toString('base64');
const cell = beginCell().storeUint(0x12345678, 32).endCell();
const tuple = (items: TupleItem[]) => serializeTuple(items).toBoc().toString('base64');
const unavailable = async (): Promise<any> => { throw new Error('transport unavailable'); };
function source(overrides: Partial<TonDataSource> = {}): TonDataSource {
  return { network: 'testnet', getMasterchainInfo: unavailable, getAccountState: unavailable,
    getTransactions: unavailable, runGetMethod: unavailable, getJettonBalance: unavailable,
    getJettonMetadata: unavailable, close: async () => {}, ...overrides };
}

test('resilient source fails over only on unavailable data and preserves empty transaction history', async () => {
  let fallbackCalls = 0;
  const fallback = source({ getMasterchainInfo: async () => { fallbackCalls++; return { seqno: 2 }; },
    getTransactions: async (who, limit, lt, h) => { assert.deepEqual([who, limit, lt, h], [address, 2, '9', hash]); return []; } });
  const primary = source({ getMasterchainInfo: async () => ({ seqno: 1 }), getTransactions: async () => [] });
  const value = new ResilientTonDataSource(primary, fallback);
  assert.equal(value.network, 'testnet'); assert.deepEqual(await value.getMasterchainInfo(), { seqno: 1 }); assert.equal(fallbackCalls, 0);
  primary.getMasterchainInfo = unavailable;
  assert.deepEqual(await value.getMasterchainInfo(), { seqno: 2 }); assert.equal(fallbackCalls, 1);
  assert.deepEqual(await value.getTransactions(address, 2, '9', hash), []);
  primary.getTransactions = unavailable;
  assert.deepEqual(await value.getTransactions(address, 2, '9', hash), []);
  await assert.rejects(new ResilientTonDataSource(source(), source()).getMasterchainInfo(), /both data sources/);
  await assert.rejects(new ResilientTonDataSource(source(), source()).getTransactions(address, 1), /Transactions unavailable/);
});

test('resilient account state prefers available cells while preserving complementary transaction metadata', async () => {
  const primary = source({ getAccountState: async () => ({ balance: '9', lastTxLt: '5', codeBoc: null }) });
  const fallback = source({ getAccountState: async () => ({ balance: '10', accountState: 'active', dataBoc: 'data' }) });
  const value = new ResilientTonDataSource(primary, fallback);
  assert.deepEqual(await value.getAccountState(address), { balance: '10', lastTxLt: '5', lastTxHash: undefined, accountState: 'active', codeBoc: null, dataBoc: 'data' });
  primary.getAccountState = async () => ({ balance: '11', codeBoc: 'code' });
  fallback.getAccountState = async () => { assert.fail('Full primary state must avoid fallback'); };
  assert.equal((await value.getAccountState(address)).balance, '11');
  primary.getAccountState = async () => ({ balance: '12' }); fallback.getAccountState = unavailable;
  assert.equal((await value.getAccountState(address)).balance, '12');
  primary.getAccountState = unavailable; fallback.getAccountState = async () => ({ balance: '13' });
  assert.equal((await value.getAccountState(address)).balance, '13');
  assert.equal((await value.getAccountStateLite(address)).balance, '13');
  primary.getAccountStateLite = async () => ({ balance: '14' });
  assert.equal((await value.getAccountStateLite(address)).balance, '14');
  primary.getAccountStateLite = unavailable; fallback.getAccountStateLite = async () => ({ balance: '15' });
  assert.equal((await value.getAccountStateLite(address)).balance, '15');
  await assert.rejects(new ResilientTonDataSource(source(), source()).getAccountState(address), /Account state unavailable/);
  await assert.rejects(new ResilientTonDataSource(source(), source()).getAccountStateLite(address), /Account state unavailable/);
});

test('resilient getters retain VM failure details, use successful fallbacks, and close both transports', async () => {
  const primary = source({ runGetMethod: async () => ({ exitCode: 32, stack: [] }) });
  const secondary = source({ runGetMethod: async () => ({ exitCode: 0, stack: [{ type: 'int', value: 7n }] }),
    getJettonBalance: async () => ({ wallet: address, balance: '7' }), getJettonMetadata: async () => ({ symbol: 'TST' }) });
  const value = new ResilientTonDataSource(primary, secondary);
  assert.equal((await value.runGetMethod(address, 'balance'))!.exitCode, 0);
  secondary.runGetMethod = unavailable;
  assert.equal((await value.runGetMethod(address, 'balance'))!.exitCode, 32);
  primary.runGetMethod = async () => ({ exitCode: 0, stack: [] });
  assert.equal((await value.runGetMethod(address, 'balance'))!.exitCode, 0);
  primary.runGetMethod = unavailable; assert.equal(await value.runGetMethod(address, 'balance'), null);
  assert.equal((await value.getJettonBalance(address, address))!.balance, '7');
  assert.equal((await value.getJettonMetadata(address))!.symbol, 'TST');
  primary.getJettonBalance = secondary.getJettonBalance; primary.getJettonMetadata = secondary.getJettonMetadata;
  assert.equal((await value.getJettonBalance(address, address))!.balance, '7'); assert.equal((await value.getJettonMetadata(address))!.symbol, 'TST');
  const empty = new ResilientTonDataSource(source(), source());
  assert.equal(await empty.getJettonBalance(address, address), null); assert.equal(await empty.getJettonMetadata(address), null);
  await assert.rejects(empty.getTonSccpBurnProofMaterial({ jettonMaster: address, messageIdHex: '0x01' }), /unavailable from both/);
  const material = { burnRecordPresent: true } as any;
  secondary.getTonSccpBurnProofMaterial = async () => material;
  assert.equal(await value.getTonSccpBurnProofMaterial({ jettonMaster: address, messageIdHex: '0x01' }), material);
  primary.getTonSccpBurnProofMaterial = async () => material;
  assert.equal(await value.getTonSccpBurnProofMaterial({ jettonMaster: address, messageIdHex: '0x01' }), material);
  let closed = 0; primary.close = async () => { closed++; throw new Error('close'); }; secondary.close = async () => { closed++; };
  await value.close(); assert.equal(closed, 2);
});

async function http(rpc: Record<string, any>) {
  const value = await TonClient4DataSource.create('testnet', 'http://127.0.0.1:1');
  (value as any).client = { getLastBlock: async () => ({ last: { seqno: 10 }, now: 100 }), ...rpc };
  return value;
}

test('HTTP adapter normalizes account variants without losing bigint balances or cell bytes', async () => {
  const samples = [
    { input: { account: { balance: { coins: 123n }, last: { lt: 9n, hash: Buffer.alloc(32, 4) }, state: { type: 'ACTIVE', code: cell, data: { bytes: ' data ' } } } }, balance: '123', kind: 'active', lt: '9', code: cell.toBoc().toString('base64') },
    { input: { account: { balance: 5.8, state: 'frozen' }, last: { lt: 8.9, hash: ' hash ' } }, balance: '5', kind: 'frozen', lt: '8', code: null },
    { input: { balance: ' 6 ', account: { state: { type: 'uninit', state: { code: ' code ' } } }, last: { lt: ' 7 ' } }, balance: '6', kind: 'uninitialized', lt: '7', code: 'code' },
    { input: { account: { balance: { coins: ' 8 ' }, state: 'inactive' } }, balance: '8', kind: 'uninitialized', lt: undefined, code: null },
    { input: { account: { balance: { coins: 9.5 }, state: { type: 'active', code: { toBoc() { throw Error('bad cell'); } } } } }, balance: '9', kind: 'active', lt: undefined, code: null },
    { input: [], balance: '0', kind: null, lt: undefined, code: null },
  ];
  for (const s of samples) {
    const value = await http({ getAccount: async () => s.input, getAccountLite: async () => s.input });
    const result = await value.getAccountState(address);
    assert.equal(result.balance, s.balance); assert.equal(result.accountState, s.kind); assert.equal(result.lastTxLt, s.lt); assert.equal(result.codeBoc, s.code);
    assert.deepEqual(await value.getAccountStateLite(address), result);
    await value.close();
  }
});

test('HTTP masterchain lookup deduplicates pending requests, caches results, and retries failed loads', async () => {
  let calls = 0, finish!: (value: any) => void;
  const value = await http({ getLastBlock: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const one = value.getMasterchainInfo(), two = value.getMasterchainInfo();
  finish({ last: { seqno: 99 }, now: 100 });
  assert.deepEqual(await one, { seqno: 99, timestamp: 100 }); assert.deepEqual(await two, await one);
  assert.deepEqual(await value.getMasterchainInfo(), await one); assert.equal(calls, 1);
  let failures = 0;
  const recovery = await http({ getLastBlock: async () => { if (++failures === 1) throw Error('temporary'); return { last: { seqno: 100 }, now: 101 }; } });
  await assert.rejects(recovery.getMasterchainInfo(), /temporary/);
  assert.equal((await recovery.getMasterchainInfo()).seqno, 100); assert.equal(failures, 2);
});

test('HTTP transaction mapping preserves cursor, opcode and pending/failed outcomes', async () => {
  const value = await http({ getAccount: async () => ({ account: { last: { lt: '9', hash } } }),
    getAccountTransactionsParsed: async (who: Address, lt: bigint, bytes: Buffer, limit: number) => {
      assert.equal(who.toRawString(), address); assert.equal(lt, 9n); assert.equal(bytes.toString('base64'), hash); assert.equal(limit, 3);
      return { transactions: [
        { lt: '9', hash, time: 1, parsed: { status: 'success' }, inMessage: { info: { type: 'internal', src: 'from', dest: 'to', value: '20' }, body: cell.toBoc().toString('base64') }, outMessages: [null, { info: { type: 'external-in', dest: 'external' }, body: 'not-a-cell' }] },
        { lt: '8', hash, time: 2, parsed: { status: 'failed' }, inMessage: { info: { type: 'external-out' }, body: beginCell().endCell().toBoc().toString('base64') } },
        { lt: '7', hash, time: 3 },
      ] };
    } });
  const rows = await value.getTransactions(address, 3);
  assert.deepEqual(rows.map(t => t.status), ['success', 'failed', 'pending']);
  assert.equal(rows[0].inMessage!.op, 0x12345678); assert.equal(rows[0].inMessage!.value, '20'); assert.equal(rows[0].outMessages.length, 1);
  assert.equal(rows[1].inMessage!.op, undefined); assert.equal(rows[2].success, false);
  assert.deepEqual(await value.getTransactions(address, 3, '9', hash), rows);
  assert.deepEqual(await (await http({ getAccount: async () => ({ account: { last: null } }) })).getTransactions(address, 3), []);
});

test('HTTP getter accepts supported stack envelopes, retries transient VM failures and rejects malformed responses', async () => {
  const stack: TupleItem[] = [{ type: 'int', value: 5n }];
  for (const response of [{ exitCode: 0, result: stack }, { exit_code: 0, stack }, { exitCode: 0, reader: { items: stack } }]) {
    const value = await http({ runMethod: async (_seqno: number, _address: Address, method: string, args: TupleItem[]) => {
      assert.equal(method, 'get_balance'); assert.deepEqual(args, stack); return response;
    } });
    assert.deepEqual(await value.runGetMethod(address, 'get_balance', stack), { exitCode: 0, stack });
  }
  let calls = 0;
  const transient = await http({ runMethod: async () => ++calls === 1 ? { exitCode: -1 } : { exitCode: 0 } });
  assert.deepEqual(await transient.runGetMethod(address, 'get_balance'), { exitCode: 0, stack: [] }); assert.equal(calls, 2);
  assert.equal(await (await http({ runMethod: async () => ({}) })).runGetMethod(address, 'bad'), null);
  assert.equal(await (await http({ runMethod: unavailable })).runGetMethod(address, 'bad'), null);
  assert.equal((await (await http({ runMethod: async () => ({ exitCode: 32 }) })).runGetMethod(address, 'bad'))!.exitCode, 32);
});

test('HTTP Jetton wrappers retain wallet/balance and decode metadata; unsupported proofs fail closed', async () => {
  const value = await http({ open: () => ({ getWalletAddress: async (who: Address) => { assert(who.equals(owner)); return wallet; },
    getBalance: async () => 123n, getJettonData: async () => ({ content: beginCell().storeUint(1, 8).storeStringTail('https://example.test/token.json').endCell() }) }) });
  assert.deepEqual(await value.getJettonBalance(address, master.toRawString()), { wallet: wallet.toString({ urlSafe: true, bounceable: true }), balance: '123' });
  assert.deepEqual(await value.getJettonMetadata(master.toRawString()), { uri: 'https://example.test/token.json' });
  assert.equal(await value.getJettonBalance('bad-address', master.toRawString()), null);
  assert.equal(await value.getJettonMetadata('bad-address'), null);
  await assert.rejects(value.getTonSccpBurnProofMaterial({ jettonMaster: address, messageIdHex: '0x01' }), /lite-server-backed/);
});

const block = (seqno: number, workchain = -1) => ({ seqno, workchain, shard: '-9223372036854775808', rootHash: Buffer.alloc(32, seqno), fileHash: Buffer.alloc(32, seqno + 1) });
// Inject only the transport into the real adapter. Avoid constructing a live
// liteserver socket; all decoding, retries, cache and proof checks remain real.
const lite = (rpc: Record<string, any>): LiteClientDataSource => new (LiteClientDataSource as any)('testnet', {
  getMasterchainInfo: async () => ({ last: block(11) }), ...rpc,
});

test('lite account state serializes cells, handles missing/frozen states and retains fixed-width transaction hashes', async () => {
  for (const [storage, expected] of [[{ type: 'active', state: { code: cell, data: cell } }, 'active'], [{ type: 'frozen' }, 'frozen'], [{ type: 'uninit' }, 'uninitialized'], [null, 'uninitialized']] as const) {
    const value = lite({ getAccountState: async () => ({ balance: { coins: 9007199254740993n }, lastTx: { lt: 12n, hash: 1n }, state: storage && { storage: { state: storage } } }) });
    const result = await value.getAccountState(address);
    assert.equal(result.accountState, expected); assert.equal(result.balance, '9007199254740993'); assert.equal(result.lastTxLt, '12');
    assert.equal(Buffer.from(result.lastTxHash!, 'base64').length, 32);
    assert.equal(result.codeBoc, expected === 'active' ? cell.toBoc().toString('base64') : null);
    await value.close();
  }
  const head = lite({ getMasterchainInfoExt: async () => ({ last: block(12), now: 123 }) });
  assert.deepEqual(await head.getMasterchainInfo(), { seqno: 12, timestamp: 123 });
});

test('lite getter decodes TVM tuples and Jetton method fallbacks from wire responses', async () => {
  const seen: string[] = [];
  const value = lite({ runMethod: async (_who: Address, method: string, params: Buffer) => {
    seen.push(method);
    if (method === 'wallet_address' || method === 'wallet_data') return { exitCode: 32 };
    if (method === 'get_wallet_address') { assert(params.length > 0); return { exitCode: 0, result: tuple([{ type: 'slice', cell: beginCell().storeAddress(wallet).endCell() }]) }; }
    if (method === 'get_wallet_data') return { exitCode: 1, result: tuple([{ type: 'int', value: 77n }]) };
    if (method === 'get_jetton_data') return { exitCode: 0, result: tuple([{ type: 'int', value: 77n }, { type: 'int', value: -1n }, { type: 'slice', cell: beginCell().storeAddress(null).endCell() }, { type: 'cell', cell: beginCell().storeUint(1, 8).storeStringTail('https://example.test/metadata').endCell() }]) };
    return { exitCode: 0, result: tuple([{ type: 'int', value: 1n }]) };
  } });
  assert.deepEqual(await value.runGetMethod(address, 'plain', [{ type: 'int', value: 8n }]), { exitCode: 0, stack: [{ type: 'int', value: 1n }] });
  assert.deepEqual(await value.getJettonBalance(address, master.toRawString()), { wallet: wallet.toString({ urlSafe: true, bounceable: true }), balance: '77' });
  assert(seen.includes('get_wallet_address') && seen.includes('get_wallet_data'));
  assert.deepEqual(await value.getJettonMetadata(master.toRawString()), { uri: 'https://example.test/metadata' });
  assert.equal(await lite({ runMethod: async () => ({ exitCode: 'invalid' }) }).runGetMethod(address, 'bad'), null);
  assert.equal(await lite({ runMethod: async () => ({ exitCode: 0, result: 'invalid' }) }).runGetMethod(address, 'bad'), null);
  assert.equal(await value.runGetMethod('bad-address', 'bad'), null);
});

test('lite transactions decode real BOC bytes and expose aborted VM outcomes', async () => {
  const tx: any = { address: 1n, lt: 9n, prevTransactionHash: 0n, prevTransactionLt: 0n, now: 10, outMessagesCount: 0,
    oldStatus: 'active', endStatus: 'active', outMessages: Dictionary.empty(), totalFees: { coins: 1n },
    stateUpdate: { oldHash: Buffer.alloc(32), newHash: Buffer.alloc(32) },
    description: { type: 'generic', creditFirst: false, computePhase: { type: 'skipped', reason: 'no-state' }, aborted: true, destroyed: false } };
  const bytes = beginCell().store(storeTransaction(tx)).endCell().toBoc();
  const value = lite({ getAccountState: async () => ({ lastTx: { lt: 9n, hash: 1n } }),
    getAccountTransactions: async (_who: Address, lt: string, _hash: Buffer, limit: number) => { assert.equal(lt, '9'); assert.equal(limit, 2); return { transactions: bytes }; } });
  const rows = await value.getTransactions(address, 2);
  assert.equal(rows[0].status, 'failed'); assert.match(rows[0].reason!, /aborted/); assert.equal(rows[0].lt, '9'); assert.equal(rows[0].utime, 10);
  assert.deepEqual(await lite({ getAccountState: async () => ({ lastTx: null }) }).getTransactions(address, 2), []);
  await assert.rejects(lite({ getAccountTransactions: async () => ({ transactions: cell.toBoc() }) }).getTransactions(address, 2, '9', hash), /Failed to decode transaction page/);
});

function proofSource(stack: TupleItem[]) {
  return lite({ lookupBlockByID: async ({ seqno }: any) => ({ id: block(seqno) }),
    runMethod: async () => ({ exitCode: 0, result: tuple(stack) }), getAccountStateRaw: async () => ({ shardBlock: block(12, 0) }),
    engine: { query: async (_schema: unknown, request: any) => {
      if (request.kind === 'liteServer.getBlockProof') return { steps: [{ kind: 'liteServer.blockLinkBackward' }, {
        kind: 'liteServer.blockLinkForward', to: block(11), signatures: { validatorSetHash: 5, catchainSeqno: 6,
          signatures: [{ nodeIdShort: Buffer.alloc(32, 1), signature: Buffer.alloc(64, 2) }] } }] };
      return { data: Buffer.from(`${request.kind}:${request.id.seqno}`) };
    } } });
}
const proofRequest = { jettonMaster: address, messageIdHex: '0x01', trustedCheckpointSeqno: 10, trustedCheckpointHashHex: `0x${Buffer.alloc(32, 10).toString('hex')}`, targetSeqno: 11 };

test('lite proof material binds checkpoint and target block identities and serializes signature material', async () => {
  const value = proofSource([{ type: 'int', value: 1n }]);
  const proof = await value.getTonSccpBurnProofMaterial(proofRequest);
  assert.equal(proof.burnRecordPresent, true); assert.equal(proof.targetMasterchain.seqno, 11); assert.equal(proof.targetShard.workchain, 0);
  assert.equal(proof.targetSignatures.validatorListHashShort, 5); assert.equal(proof.targetSignatures.signatures[0].signatureHex.length, 130);
  assert.equal(Buffer.from(proof.targetBlockBoc, 'base64').toString(), 'liteServer.getBlock:11');
  await assert.rejects(value.getTonSccpBurnProofMaterial({ ...proofRequest, trustedCheckpointSeqno: undefined }), /trusted checkpoint/);
  await assert.rejects(value.getTonSccpBurnProofMaterial({ ...proofRequest, trustedCheckpointHashHex: '0x01' }), /32-byte hex/);
  await assert.rejects(value.getTonSccpBurnProofMaterial({ ...proofRequest, trustedCheckpointHashHex: `0x${'0'.repeat(64)}` }), /does not match/);
  await assert.rejects(value.getTonSccpBurnProofMaterial({ ...proofRequest, targetSeqno: 9 }), /precedes/);
});

test('lite proof material rejects a successful getter with an empty or absent burn record', async () => {
  for (const stack of [[], [{ type: 'null' }]] as TupleItem[][]) {
    await assert.rejects(proofSource(stack).getTonSccpBurnProofMaterial(proofRequest), /Burn record is not available/);
  }
});
