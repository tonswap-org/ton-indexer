import { fixtureChainSource, fixtureHead } from './support/chainFixture';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell, loadShardAccount, loadTransaction, storeShardAccount } from '@ton/core';
import { Executor, type IExecutor } from '@ton/sandbox';
import { replayHistoricalAccount, type HistoricalReplayStep } from '../data/historicalReplay';
import { findTransactionState } from '../ledger/archive';
import { createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore } from '../runtime/physicalEvidence';
import { decodeNativePerpsState } from '../ledger/currentPerpsState';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { loadOpcodes } from '../utils/opcodes';
import type {AccountStateResponse, RawTransaction} from '../data/dataSource';

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
  await check('retained boundary uses the final predecessor and complete authenticated Account commitments', async () => {
    let previous = predecessor;
    for (let i = 0; i < steps.length; i++) {
      const snapshot = snapshots.get(lts[i])!;
      const boundary = snapshot.replayBoundary;
      assert.ok(boundary);
      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(boundary));
      const oldAccount = Cell.fromBase64(boundary.beforeShardAccountBoc);
      const newAccount = Cell.fromBase64(boundary.afterShardAccountBoc);
      const originalTx = Cell.fromBase64(boundary.transactionBoc);
      const tx = loadTransaction(originalTx.beginParse());
      assert.ok(oldAccount.equals(previous));
      assert.ok(oldAccount.refs[0].hash().equals(tx.stateUpdate.oldHash));
      assert.ok(newAccount.refs[0].hash().equals(tx.stateUpdate.newHash));
      assert.ok(originalTx.equals(steps[i].transaction));
      assert.ok(Cell.fromBase64(boundary.blockBoc).equals(steps[i].block));
      assert.ok(Cell.fromBase64(boundary.configBoc).equals(steps[i].config));
      const account = loadShardAccount(newAccount.beginParse());
      assert.equal(account.lastTransactionLt.toString(), snapshot.lastTxLt);
      assert.equal(account.lastTransactionHash.toString(16).padStart(64, '0'), originalTx.hash().toString('hex'));
      assert.equal(account.account!.storage.balance.coins.toString(), snapshot.balance);
      assert.ok(account.account!.addr.equals(address));
      const active = account.account!.storage.state;
      assert.equal(active.type, 'active');
      if (active.type !== 'active') throw Error('fixture inactive');
      assert.ok(active.state.code!.equals(Cell.fromBase64(snapshot.codeBoc!)));
      assert.ok(active.state.data!.equals(Cell.fromBase64(snapshot.dataBoc!)));
      previous = newAccount;
    }
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
  await check('a transaction embedded only as arbitrary block payload is not executed membership', async () => {
    const extra = beginCell().storeUint(0x4a33f6fd, 32).storeRef(steps[0].transaction).storeRef(Cell.EMPTY)
      .storeRef(beginCell().storeBit(false).storeCoins(0).storeBit(false).endCell()).storeBuffer(Buffer.alloc(32)).endCell();
    const payloadOnly = new Cell({ bits: block.bits, refs: [...block.refs.slice(0, 3), extra] });
    await assert.rejects(replayHistoricalAccount({ ...input, steps: [{ ...steps[0], block: payloadOnly }] }, executor), /binding mismatch/);
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
    const source = fixtureChainSource({ head: async () => ({ seqno: 8103 }),
      getAccountStateAtSeqno: async (_a: string, seqno: number) => seqno < 8102 ? beforeState : snapshots.get('8218000019')!,
      getAccountStateAtTransaction: async (_a: string, c: typeof cursor, seqno: number) => {
        replayCalls++; assert.equal(seqno, 8102); assert.deepEqual(c, cursor); return snapshots.get(cursor.lt)!;
      },
    });
    assert.equal((await findTransactionState(source, address.toRawString(), cursor))?.state.lastTxLt, cursor.lt);
    assert.equal(replayCalls, 1);
    source.getAccountStateAtTransaction = async () => { throw Error('archive unavailable'); };
    assert.equal(await findTransactionState(source, address.toRawString(), cursor), null);
  });

  await check('a rejected intermediate cursor cannot poison another exact read on a cold evidence store', async () => {
    const account = address.toRawString(), valid = { lt: lts[1], hash: steps[1].transaction.hash().toString('hex') };
    const head = fixtureHead(8103, loadTransaction(steps.at(-1)!.transaction.beginParse()).now);
    // The missing-config negative above destroys the shared native emulator
    // before throwing. Keep this regression independent of that failed executor.
    const replayExecutor = await Executor.create();
    const now = Date.now, fixedTime = now(); Date.now = () => fixedTime;
    try {
      // Each case starts without retained evidence or source-local cooldowns.
      // Both targets are below the containing block's final LT, forcing exact
      // replay rather than an equal-LT hash comparison at a seqno boundary.
      for (const invalid of [{ lt: cursor.lt, hash: '0'.repeat(64) }, { lt: '8218000008', hash: cursor.hash }]) {
        let seqnoReads = 0, replayReads = 0;
        let replayFailure: unknown;
        const source = fixtureChainSource({ head: async () => head,
          getAccountStateAtSeqno: async (requested, seqno) => {
            assert.equal(requested, account); seqnoReads++;
            return seqno < 8102 ? beforeState : snapshots.get(lts.at(-1)!)!;
          },
          getAccountStateAtTransaction: async (requested, selected, seqno) => {
            assert.equal(requested, account); assert.equal(seqno, 8102); replayReads++;
            const index = lts.indexOf(selected.lt);
            // Original replay performs the cursor and Account commitment checks.
            try {
              return await replayHistoricalAccount({ ...input, cursor: selected, steps: steps.slice(0, Math.max(0, index) + 1) }, replayExecutor);
            } catch (error) { replayFailure = error; throw error; }
          },
        });
        const retained = new Map<string, PhysicalBoundary>();
        const store: PhysicalEvidenceStore = {
          evidenceBoundary: async (a, lt, hash) => retained.get(`${a}:${lt}:${hash}`) ?? null,
          retain: async (evidence, seqno) => {
            const transaction = Cell.fromBase64(evidence.transactionBoc), tx = loadTransaction(transaction.beginParse());
            retained.set(`${evidence.account}:${tx.lt}:${transaction.hash().toString('hex')}`, { evidence, seqno });
          },
        };
        const reader = createPhysicalEvidenceReader(source, store, head, { newTransactions: 2 });
        await assert.rejects(reader.exact(account, invalid.lt, invalid.hash));
        assert.equal(replayReads, 1, 'the invalid cursor must reach exact replay');
        assert.equal(retained.size, 0, 'rejected evidence never warms the store');
        const beforeValid = seqnoReads;
        replayFailure = undefined;
        const recovered = await reader.exact(account, valid.lt, valid.hash).catch(error => {
          assert.fail(`Valid historical lookup failed after ${seqnoReads} seqno reads and ${replayReads} replay reads: ${String(replayFailure ?? error)}`);
        });
        assert.equal(replayReads, 2, 'a different valid cursor is attempted immediately on the same source/account');
        assert(seqnoReads > beforeValid, 'the invalid cursor cannot suppress account-state reads');
        assert.equal(recovered.seqno, 8102); assert.equal(retained.size, 1);
        assert.equal(Cell.fromBase64(recovered.evidence.transactionBoc).hash().toString('hex'), valid.hash);
        assert.equal(recovered.evidence.afterShardAccountBoc, snapshots.get(valid.lt)!.replayBoundary!.afterShardAccountBoc);
      }
    } finally { Date.now = now; }
  });

  await check('authentic archived SHORT replay does not enable an obsolete perps business layout', async () => {
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
    for (const state of [beforeState, ...snapshots.values()])
      assert.throws(() => decodeNativePerpsState(Cell.fromBase64(state.dataBoc!)),
        'Authenticated archived storage cannot enter the current PxStorage decoder');
    // Public identities captured from this immutable archive before retiring its decoder.
    const decoded = { root: '0:0158b4cf7b5ec1669943ab79d3e521b396883cede549fe1789a7716eb47ad06b', walletCodeHash: '5f84fc5075c0553ce1ed92fed04cc23ffa903acda5c697ecefd36cd05f0e075e' };
    const asset = (wallet: string, owner: string) => ({ kind: 'jetton' as const, id: `localnet:jetton:${decoded.root}`, master: decoded.root, wallet, owner, decimals: 9 });
    const projection: ProjectionInput = { network: 'localnet', owner, chains, opcodes: loadOpcodes(), pools: new Map(),
      wallets: new Map([[ownerWallet, asset(ownerWallet, owner)], [engineWallet, asset(engineWallet, engine)]]),
      perpsEngines: new Map([[engine, { address: engine, root: decoded.root, codeHash: active.state.code!.hash().toString('hex'),
        walletCodeHash: decoded.walletCodeHash, ownerWallet, engineWallet }]]),
      stateAt: async (a, lt, hash) => {
        const state = snapshots.get(lt);
        const h = /^[0-9a-f]{64}$/i.test(hash) ? Buffer.from(hash, 'hex') : Buffer.from(hash, 'base64');
        const sh = state?.lastTxHash && (/^[0-9a-f]{64}$/i.test(state.lastTxHash) ? Buffer.from(state.lastTxHash, 'hex') : Buffer.from(state.lastTxHash, 'base64'));
        return a === engine && state && sh && sh.equals(h) ? { seqno: lt === before.lastTransactionLt.toString() ? 6416 : 8102, state } : null;
      },
    };
    const missing = await projectOwnerLedger({ ...projection, stateAt: async () => null });
    const replayed = await projectOwnerLedger(projection);
    const dispatch = records.find(row => row.account === owner)!.raw;
    for (const result of [missing, replayed]) {
      assert(result.events.length > 0);
      const retained = result.events.find(event => event.account === owner && event.lt === dispatch.lt);
      assert(retained, 'The original owner dispatch survives unsupported product decoding');
      assert.equal(retained.hash, dispatch.hash);
      assert(retained.movements.some(movement => movement.asset.kind === 'native' && movement.direction === 'fee'),
        'Unsupported business storage does not erase physical native charges');
      assert(result.events.every(event => event.kind !== 'perps_operation'
        && event.settlement?.protocol !== 'perps' && !event.settlement?.perps && !event.settlement?.currentPerps),
        'Old code pins and exact replay cannot enroll a retired business decoder');
      assert(result.events.every(event => event.movements.every(movement => movement.asset.kind !== 'perps_balance')),
        'Archived position bookkeeping cannot create a current financial balance');
    }
    assert.deepEqual(replayed.events, missing.events,
      'Exact replay authenticates historical cells without changing unsupported business classification or physical movements');
  });
  console.log(`Historical replay checks passed: ${checks}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
