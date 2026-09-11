import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell, loadShardAccount, loadTransaction, storeShardAccount } from '@ton/core';
import { Executor, type IExecutor } from '@ton/sandbox';
import { replayHistoricalAccount, type HistoricalReplayStep } from '../data/historicalReplay';
import { findTransactionState } from '../ledger/archive';
import { readPerpsState } from '../ledger/perpsState';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { loadOpcodes } from '../utils/opcodes';
import type { AccountStateResponse, TonDataSource, RawTransaction } from '../data/dataSource';

const dir = join(__dirname, 'fixtures/perps-intermediate-state');
const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
for (const [name, hash] of Object.entries(provenance.files)) {
  assert.equal(createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'), hash);
}
const cell = (name: string) => Cell.fromBoc(readFileSync(join(dir, name)))[0];
const predecessor = cell('predecessor.boc'), block = cell('shard-block.boc'), config = cell('config.boc');
const address = Address.parse('0:d28f436ed593006efb32a8cfa6db840e9fc93f3d62c21ead602c17928d4285d3');
const cursor = { lt: '8218000007', hash: provenance.targetHash as string };
const lts = ['8218000007', '8218000012', '8218000014', '8218000015', '8218000019'];
const steps: HistoricalReplayStep[] = lts.map(lt => ({ transaction: cell(`tx-${lt}.boc`), block, config }));
const input = { address, cursor, predecessor, steps: [steps[0]] };
let checks = 0;
const check = async (name: string, fn: () => void | Promise<void>) => { await fn(); checks++; console.log(`PASS ${name}`); };

async function main() {
  const executor = await Executor.create();
  const snapshots = new Map<string, AccountStateResponse>();
  await check('real same-block OPEN and four callbacks reproduce exact transaction and Account commitments', async () => {
    for (let i = 0; i < steps.length; i++) {
      const tx = loadTransaction(steps[i].transaction.beginParse());
      snapshots.set(lts[i], await replayHistoricalAccount({ ...input,
        cursor: { lt: tx.lt.toString(), hash: tx.hash().toString('hex') }, steps: steps.slice(0, i + 1),
      }, executor));
    }
    assert.equal(snapshots.get(cursor.lt)!.lastTxHash, Buffer.from(cursor.hash, 'hex').toString('base64'));
    assert.equal(snapshots.get(cursor.lt)!.accountState, 'active');
  });
  await check('wrong original cursor cannot admit authentic state from a different transaction', async () => {
    await assert.rejects(replayHistoricalAccount({ ...input, cursor: { ...cursor, hash: '00'.repeat(32) } }, executor), /cursor mismatch/);
  });
  await check('altered predecessor balance fails original old Account hash before execution', async () => {
    const before = loadShardAccount(predecessor.beginParse());
    before.account!.storage.balance.coins++;
    await assert.rejects(replayHistoricalAccount({ ...input, predecessor: beginCell().store(storeShardAccount(before)).endCell() }, executor), /binding mismatch/);
  });
  await check('a shard block without the original transaction is rejected', async () => {
    await assert.rejects(replayHistoricalAccount({ ...input, steps: [{ ...steps[0], block: Cell.EMPTY }] }, executor), /binding mismatch/);
  });
  await check('missing historical config does not substitute sandbox defaults', async () => {
    await assert.rejects(replayHistoricalAccount({ ...input, steps: [{ ...steps[0], config: Cell.EMPTY }] }, executor));
  });
  await check('valid original transaction plus wrong post-account is refused', async () => {
    const fake = { runTransaction: async () => ({ result: { success: true, transaction: steps[0].transaction.toBoc().toString('base64'), shardAccount: predecessor.toBoc().toString('base64') } }) } as unknown as IExecutor;
    await assert.rejects(replayHistoricalAccount(input, fake), /commitment mismatch/);
  });
  await check('full transaction identity remains required even if an executor supplies an after-account', async () => {
    const fake = { runTransaction: async () => ({ result: { success: true, transaction: steps[1].transaction.toBoc().toString('base64'), shardAccount: predecessor.toBoc().toString('base64') } }) } as unknown as IExecutor;
    await assert.rejects(replayHistoricalAccount(input, fake), /commitment mismatch/);
  });
  await check('replay cannot grow beyond 32 original transactions', async () => {
    await assert.rejects(replayHistoricalAccount({ ...input, steps: Array(33).fill(steps[0]) }, executor), /transaction bound/);
  });

  const before = loadShardAccount(predecessor.beginParse());
  const active = before.account!.storage.state;
  assert.equal(active.type, 'active');
  if (active.type !== 'active') throw Error('fixture inactive');
  const beforeState: AccountStateResponse = { balance: before.account!.storage.balance.coins.toString(),
    codeBoc: active.state.code!.toBoc().toString('base64'), dataBoc: active.state.data!.toBoc().toString('base64'),
    accountState: 'active', lastTxLt: before.lastTransactionLt.toString(),
    lastTxHash: before.lastTransactionHash.toString(16).padStart(64, '0') };
  snapshots.set(before.lastTransactionLt.toString(), beforeState);
  await check('masterchain search uses exact replay only for a skipped intermediate cursor', async () => {
    let replayCalls = 0;
    const source = { getMasterchainInfo: async () => ({ seqno: 8103 }),
      getAccountStateAtSeqno: async (_a: string, seqno: number) => seqno < 8102 ? beforeState : snapshots.get('8218000019')!,
      getAccountStateAtTransaction: async (_a: string, c: typeof cursor, seqno: number) => {
        replayCalls++; assert.equal(seqno, 8102); assert.deepEqual(c, cursor); return snapshots.get(cursor.lt)!;
      },
    } as unknown as TonDataSource;
    assert.equal((await findTransactionState(source, address.toRawString(), cursor))?.state.lastTxLt, cursor.lt);
    assert.equal(replayCalls, 1);
    delete source.getAccountStateAtTransaction;
    assert.equal(await findTransactionState(source, address.toRawString(), cursor), null);
  });

  await check('actual SHORT original becomes confirmed through existing Perps projection; missing exact state remains unresolved', async () => {
    const owner = '0:b660f251bcd8c741ca425f67a280daf6e52637d2c92010a6d7135c8be33c07c1';
    const ownerWallet = '0:de989331aa3c8ebac0ed568d93348e5e2f32ca7225e3dcb40ba17c666a0d66b9';
    const engineWallet = '0:90a99554534afc8953d2bdba123421612491e56ad665c924c5e2d9b943f9db14';
    const engine = address.toRawString();
    const records: { account: string; raw: RawTransaction }[] = JSON.parse(readFileSync(join(dir, 'transactions.json'), 'utf8'));
    const chains = new Map<string, LedgerChain>();
    for (const row of records) {
      let chain = chains.get(row.account);
      if (!chain) { chain = { account: row.account, generation: 'archived-fixture', historyComplete: true,
        role: row.account === owner ? 'owner' : row.account === ownerWallet ? 'owned_jetton_wallet' : 'counterparty', transactions: [] }; chains.set(row.account, chain); }
      chain.transactions.push(row.raw);
    }
    const decoded = readPerpsState(beforeState.dataBoc!);
    const asset = (wallet: string, owner: string) => ({ kind: 'jetton' as const, id: `localnet:jetton:${decoded.root}`, master: decoded.root, wallet, owner, decimals: 9 });
    const projection: ProjectionInput = { network: 'localnet', owner, chains, opcodes: loadOpcodes(), pools: new Map(),
      wallets: new Map([[ownerWallet, asset(ownerWallet, owner)], [engineWallet, asset(engineWallet, engine)]]),
      perpsEngines: new Map([[engine, { address: engine, root: decoded.root, codeHash: active.state.code!.hash().toString('hex'),
        walletCodeHash: decoded.walletCode.hash().toString('hex'), ownerWallet, engineWallet }]]),
      stateAt: async (a, lt, hash) => {
        const state = snapshots.get(lt);
        const h = /^[0-9a-f]{64}$/i.test(hash) ? Buffer.from(hash, 'hex') : Buffer.from(hash, 'base64');
        const sh = state?.lastTxHash && (/^[0-9a-f]{64}$/i.test(state.lastTxHash) ? Buffer.from(state.lastTxHash, 'hex') : Buffer.from(state.lastTxHash, 'base64'));
        return a === engine && state && sh && sh.equals(h) ? { seqno: lt === before.lastTransactionLt.toString() ? 6416 : 8102, state } : null;
      },
    };
    const target = (events: Awaited<ReturnType<typeof projectOwnerLedger>>["events"]) => events.find(e => e.settlement?.perps?.queryId === '1788897868699');
    const unresolved = target((await projectOwnerLedger({ ...projection, stateAt: async () => null })).events);
    assert.ok(unresolved?.issues.includes('perps_exact_state_unavailable'));
    const event = target((await projectOwnerLedger(projection)).events);
    assert.equal(event?.settlement?.status, 'confirmed', JSON.stringify(event?.issues));
    assert.equal(event?.settlement?.perps?.outcome, 'accepted');
    assert.equal(event?.settlement?.perps?.request.sizeRaw, '-4000000000');
    assert.equal(event?.settlement?.perps?.request.marginRaw, '800000000');
    assert.equal(event?.settlement?.perps?.request.leverageBps, 5000);
    assert.equal(event?.settlement?.perps?.depositRaw, '812420000');
    assert.ok(!event?.issues.some(issue => issue.startsWith('perps_')));
  });
  console.log(`Historical replay checks passed: ${checks}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
