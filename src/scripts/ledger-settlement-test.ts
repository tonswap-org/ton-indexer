import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, Dictionary, beginCell } from '@ton/core';
import { createHash } from 'node:crypto';
import type {
  RawMessage,
  RawTransaction,
  TonDataSource,
} from '../data/dataSource';
import type { LedgerAsset } from '../ledger/types';
import {
  projectOwnerLedger,
  type LedgerChain,
  type ProjectionInput,
} from '../ledger/project';
import {
  findTransactionState,
  type LedgerStateSnapshot,
} from '../ledger/archive';
import {
  ADD,
  INTERNAL,
  NOTIFY,
  REMOVE,
  SETTLEMENT_INTERNAL,
  SWAP,
  TRANSFER,
  WITHDRAW_COMPLETE,
  bodyCell,
  tokenWire,
  withdrawalRequest,
} from '../ledger/wire';
import { readDlmmLiquidityState } from '../ledger/dlmmLiquidityState';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { resolveDlmmPoolSettlementEvidence, type DlmmPoolMessageEvidence } from '../utils/dlmmSettlementEvidence';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadConfig } from '../config';

const addr = (n: number) => `0:${n.toString(16).padStart(64, '0')}`;
const A = (s: string) => Address.parse(s);
const owner = addr(1),
  pool = addr(2),
  rootT = addr(3),
  rootX = addr(4),
  ownedT = addr(5),
  ownedX = addr(6),
  poolT = addr(7),
  poolX = addr(8),
  other = addr(9),
  otherT = addr(10);
const hash = (n: number) =>
  createHash('sha256').update(String(n)).digest('base64');
const code = beginCell().storeUint(123, 32).endCell();
const opcodes = loadOpcodes();
const transfer = (
  q: bigint,
  amount: bigint,
  destination: string,
  response: string,
  forward = Cell.EMPTY,
  custom = Cell.EMPTY
) =>
  beginCell()
    .storeUint(TRANSFER, 32)
    .storeUint(q, 64)
    .storeCoins(amount)
    .storeAddress(A(destination))
    .storeAddress(A(response))
    .storeRef(custom)
    .storeCoins(forward === Cell.EMPTY ? 0 : 1)
    .storeRef(forward)
    .endCell();
const internal = (
  q: bigint,
  amount: bigint,
  from: string,
  response: string,
  forward = Cell.EMPTY,
  typed = false
) =>
  beginCell()
    .storeUint(typed ? SETTLEMENT_INTERNAL : INTERNAL, 32)
    .storeUint(q, 64)
    .storeCoins(amount)
    .storeAddress(A(from))
    .storeAddress(A(response))
    .storeCoins(forward === Cell.EMPTY ? 0 : 1)
    .storeRef(forward)
    .endCell();
const notify = (
  q: bigint,
  amount: bigint,
  from: string,
  senderWallet: string,
  forward: Cell
) =>
  beginCell()
    .storeUint(NOTIFY, 32)
    .storeUint(q, 64)
    .storeCoins(amount)
    .storeAddress(A(from))
    .storeAddress(A(senderWallet))
    .storeCoins(1)
    .storeRef(forward)
    .endCell();
const tuple = (op: number, q: bigint, amount: bigint, destination: string) =>
  beginCell()
    .storeUint(op, 32)
    .storeUint(q, 64)
    .storeCoins(amount)
    .storeAddress(A(destination))
    .endCell();
const message = (
  source: string,
  destination: string,
  lt: number,
  body: Cell,
  value = '200'
): RawMessage => ({
  source,
  destination,
  createdLt: String(lt),
  body: body.toBoc().toString('base64'),
  op: body.bits.length >= 32 ? body.beginParse().preloadUint(32) : undefined,
  value,
  forwardFeeRaw: '3',
  extraFlagsRaw: '0',
  bounced: false,
});
function fixture(): ProjectionInput {
  const chains = new Map<string, LedgerChain>();
  for (const [account, role] of [
    [owner, 'owner'],
    [ownedT, 'owned_jetton_wallet'],
    [ownedX, 'owned_jetton_wallet'],
    [pool, 'pool'],
    [poolT, 'counterparty'],
    [poolX, 'counterparty'],
    [otherT, 'counterparty'],
  ] as const)
    chains.set(account, {
      account,
      role,
      generation: hash(parseInt(account.slice(-4), 16)),
      historyComplete: true,
      transactions: [],
    });
  const asset = (master: string, wallet: string, who: string): LedgerAsset => ({
    kind: 'jetton',
    id: `testnet:jetton:${master}`,
    master,
    wallet,
    owner: who,
    decimals: 9,
  });
  const wallets = new Map([
    [ownedT, asset(rootT, ownedT, owner)],
    [ownedX, asset(rootX, ownedX, owner)],
    [poolT, asset(rootT, poolT, pool)],
    [poolX, asset(rootX, poolX, pool)],
    [otherT, asset(rootT, otherT, other)],
  ]);
  return {
    network: 'testnet',
    owner,
    chains,
    wallets,
    pools: new Map([
      [
        pool,
        {
          address: pool,
          tokenT: rootT,
          tokenX: rootX,
          codeHash: code.hash().toString('hex'),
        },
      ],
    ]),
    opcodes,
    stateAt: async () => null,
  };
}
function tx(
  f: ProjectionInput,
  account: string,
  lt: number,
  inMessage?: RawMessage,
  outMessages: RawMessage[] = []
) {
  const chain = f.chains.get(account)!;
  const previous = chain.transactions.at(-1);
  const raw: RawTransaction = {
    lt: String(lt),
    hash: hash(lt),
    prevTransactionLt: previous?.lt ?? '0',
    prevTransactionHash: previous?.hash ?? Buffer.alloc(32).toString('base64'),
    utime: 1700000000 + lt,
    success: true,
    status: 'success',
    totalFeesRaw: '100',
    inMessage,
    outMessages,
  };
  chain.transactions.push(raw);
  return raw;
}
function payerLeg(
  f: ProjectionInput,
  base: number,
  q: bigint,
  amount: bigint,
  root: string,
  forward: Cell,
  target = pool
) {
  const src = root === rootT ? ownedT : ownedX,
    dst = target === other ? otherT : root === rootT ? poolT : poolX;
  const request = message(
    owner,
    src,
    base + 1,
    transfer(q, amount, target, owner, forward)
  );
  const hop = message(
    src,
    dst,
    base + 11,
    internal(q, amount, owner, owner, forward)
  );
  const notification = message(
    dst,
    target,
    base + 21,
    notify(q, amount, owner, src, forward)
  );
  tx(f, owner, base, undefined, [request]);
  tx(f, src, base + 10, request, [hop]);
  tx(f, dst, base + 20, hop, [notification]);
  return { notification, src, dst };
}
function outputLeg(
  f: ProjectionInput,
  base: number,
  q: bigint,
  amount: bigint,
  root: string,
  request: RawMessage
) {
  const src = root === rootT ? poolT : poolX,
    dst = root === rootT ? ownedT : ownedX;
  const hop = message(
    src,
    dst,
    base + 1,
    internal(q, amount, pool, src, Cell.EMPTY, true)
  );
  tx(f, src, base, request, [hop]);
  tx(f, dst, base + 10, hop);
  return { src, dst, hop };
}
function positionData(shares: bigint, binId = -7, withdrawal?: Cell) {
  const key = BigInt(
    '0x' +
      beginCell()
        .storeAddress(A(owner))
        .storeInt(binId, 32)
        .endCell()
        .hash()
        .toString('hex')
  );
  const dict = Dictionary.empty(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.BigUint(256)
  );
  if (shares) dict.set(key, shares);
  const positions = beginCell().storeDict(dict).endCell();
  const withdrawals = Dictionary.empty(
    Dictionary.Keys.BigUint(64),
    Dictionary.Values.Cell()
  );
  if (withdrawal) withdrawals.set(75n, withdrawal);
  const container = beginCell()
    .storeRef(positions)
    .storeRef(Cell.EMPTY)
    .storeRef(beginCell().storeUint(0, 64).storeDict(withdrawals).endCell())
    .storeRef(Cell.EMPTY)
    .endCell();
  const meta = beginCell().storeRef(Cell.EMPTY).storeRef(container).endCell();
  return beginCell()
    .storeAddress(A(rootT))
    .storeAddress(A(rootX))
    .storeAddress(A(other))
    .storeRef(Cell.EMPTY)
    .storeRef(Cell.EMPTY)
    .storeRef(Cell.EMPTY)
    .storeRef(meta)
    .endCell();
}
function state(
  raw: RawTransaction,
  shares: bigint,
  seqno: number,
  withdrawal?: Cell
): LedgerStateSnapshot {
  return {
    seqno,
    state: {
      balance: '0',
      accountState: 'active',
      lastTxLt: raw.lt,
      lastTxHash: raw.hash,
      codeBoc: code.toBoc().toString('base64'),
      dataBoc: positionData(shares, -7, withdrawal).toBoc().toString('base64'),
    },
  };
}
function swapFixture() {
  const f = fixture(),
    q = 42n,
    sid = 0x4453000000000001n,
    paid = 1208925819614629174706177n,
    received = 1208925819614629174706167n;
  const forward = beginCell()
    .storeUint(SWAP, 32)
    .storeUint(q, 64)
    .storeAddress(A(owner))
    .storeCoins(1)
    .storeUint(1, 8)
    .storeAddress(null)
    .storeRef(Cell.EMPTY)
    .storeCoins(0)
    .storeCoins(0)
    .storeRef(Cell.EMPTY)
    .endCell();
  const input = payerLeg(f, 10, q, paid, rootT, forward);
  const request = message(
    pool,
    poolX,
    41,
    transfer(
      sid,
      received,
      owner,
      pool,
      Cell.EMPTY,
      beginCell().storeUint(0x4a535454, 32).endCell()
    )
  );
  tx(f, pool, 40, input.notification, [request]);
  outputLeg(f, 50, sid, received, rootX, request);
  tx(
    f,
    pool,
    80,
    message(poolX, pool, 71, tuple(0x4a535543, sid, received, ownedX)),
    [message(pool, poolX, 81, tuple(0x4a53464e, sid, received, ownedX))]
  );
  return { f, paid, received };
}
async function testSwap() {
  const { f, paid, received } = swapFixture();
  const result = (await projectOwnerLedger(f)).events;
  const event = result.find((e) => e.kind === 'swap')!;
  assert(event, JSON.stringify(result));
  assert.equal(event.settlement?.status, 'incomplete', 'raw delivery and pool acknowledgement lack required historical swap archives');
  const inputMovement = event.movements.find(m => m.asset.kind === 'jetton' && m.direction === 'out')!;
  const inputTransaction = f.chains.get(ownedT)!.transactions.find(t => bodyCell(t.inMessage))!;
  assert.equal(inputMovement.evidence.queryId, '42');
  assert.equal(inputMovement.evidence.requestBodyHash, bodyCell(inputTransaction.inMessage)!.hash().toString('hex'));
  assert.deepEqual(
    result.flatMap(row => row.movements)
      .filter((m) => m.asset.kind === 'jetton')
      .map((m) => [m.direction, m.asset.master, m.amountRaw]),
    [
      ['out', rootT, paid.toString()],
      ['in', rootX, received.toString()],
    ]
  );
  assert.equal(result.reduce((n,row) => n + BigInt(row.totalFeesRaw ?? '0'), 0n), 300n);
  assert.equal(
    result.flatMap(row => row.movements)
      .filter((m) => m.evidence.kind === 'transaction_fee')
      .reduce((n, m) => n + BigInt(m.amountRaw), 0n),
    300n
  );
  assert.equal(
    result.flatMap(row => row.movements)
      .filter((m) => m.evidence.kind === 'message_forward_fee')
      .reduce((n, m) => n + BigInt(m.amountRaw), 0n),
    6n
  );
  assert(
    result.flatMap(row => row.movements)
      .filter((m) => m.asset.kind === 'jetton')
      .every((m) => m.evidence.transactions?.length === 2)
  );
  assert.equal(
    result.flatMap(row => row.movements).filter(
      (m) => m.asset.kind === 'native' && m.direction === 'out'
    ).length,
    1,
    'internal owner/custody native transfers are not counted twice'
  );
  // Synthetic qualified-ledger service boundary, not historical chain proof.
  // The actual archive-free projection above must stay incomplete. Real Sandbox
  // full/partial/refund qualification is covered by ledger-dlmm-swap-test.ts.
  // This isolated service case retains amounts above 2^80 and minOut=1.
  const supplied = structuredClone(event);
  supplied.movements = result.flatMap(row => structuredClone(row.movements));
  supplied.issues = ['jetton_decimals_unresolved'];
  const outputMovement = supplied.movements.find(m => m.asset.kind === 'jetton' && m.direction === 'in')!;
  const acceptance = {account: pool, lt: '40', hash: hash(40), utime: 1700000040};
  const finalized = {account: pool, lt: '80', hash: hash(80), utime: 1700000080};
  supplied.settlement = {...event.settlement!, status: 'confirmed', evidence: [...event.settlement!.evidence, finalized],
    dlmmSwap: {poolCodeHash: '1'.repeat(64), paidInputRaw: paid.toString(), consumedInputRaw: paid.toString(), returnedInputRaw: '0', outputRaw: received.toString(),
      inputMovementId: inputMovement.id, outputMovementId: outputMovement.id, refundMovementId: null, acceptance, finalizations: [finalized]}};
  const qualifiedResult = [supplied];
  const config = { ...loadConfig(), network: 'testnet' as const, responseCacheEnabled: false };
  const store = new MemoryStore(config);
  const originals = f.chains.get(owner)!.transactions.map(raw => classifyTransaction(owner, raw, opcodes));
  store.addTransactions(owner, originals);
  const head = originals.slice().sort((a, b) => BigInt(a.lt) > BigInt(b.lt) ? -1 : 1)[0];
  store.setBalance(owner, { address: owner, balance: '0', lastTxLt: head.lt, lastTxHash: head.hash, updatedAt: Date.now() });
  store.markHistoryComplete(owner);
  const service = new IndexerService(config, store, {} as TonDataSource, opcodes, []);
  const page = (events: typeof result) => ({ network: 'testnet' as const, account: owner, events, nextCursor: null,
    coverage: { generation: 'receipt-generation', snapshotComplete: true, historyComplete: false, issues: ['unrelated_wallet_gap'] } }) as any;
  service.setSwapLedgerReader(async () => page(qualifiedResult));
  const receivedSwaps = await service.getSwapExecutions(owner);
  assert.equal(receivedSwaps.swaps.length, 1);
  assert.equal(receivedSwaps.swaps[0].receiveAmount, received.toString());
  assert.equal(receivedSwaps.swaps[0].minimumReceiveAmount, '1');
  assert.deepEqual(receivedSwaps.swaps[0].receipt, { ledgerEventId: event.id, generation: 'receipt-generation', assetId: `testnet:jetton:${rootX}` });
  for (const mutation of ['unconfirmed', 'request-body', 'original-transaction', 'foreign-owner', 'invalid-amount', 'duplicate-event']) {
    const altered = structuredClone(qualifiedResult), target = altered.find(item => item.id === event.id)!;
    if (mutation === 'unconfirmed') target.settlement!.status = 'incomplete';
    if (mutation === 'request-body') target.movements.find(item => item.asset.kind === 'jetton' && item.direction === 'out')!.evidence.requestBodyHash = 'f'.repeat(64);
    if (mutation === 'original-transaction') for (const movement of target.movements) for (const ref of movement.evidence.transactions ?? []) if (ref.account === owner) ref.hash = hash(999);
    if (mutation === 'foreign-owner') target.movements.find(item => item.asset.kind === 'jetton' && item.direction === 'in')!.asset.owner = other;
    if (mutation === 'invalid-amount') target.movements.find(item => item.asset.kind === 'jetton' && item.direction === 'in')!.amountRaw = '1e9';
    if (mutation === 'duplicate-event') altered.push(structuredClone(target));
    service.setSwapLedgerReader(async () => page(altered));
    assert.equal((await service.getSwapExecutions(owner)).swaps[0].receiveAmount, undefined, mutation);
  }
  let pages = 0;
  service.setSwapLedgerReader(async () => ++pages === 1 ? { ...page(qualifiedResult), nextCursor: 'next' }
    : { ...page([]), coverage: { ...page([]).coverage, generation: 'other-generation' } });
  assert.equal((await service.getSwapExecutions(owner)).swaps[0].receiveAmount, undefined, 'changed ledger generation');
  service.setSwapLedgerReader(async () => { throw new Error('Ledger unavailable'); });
  assert.equal((await service.getSwapExecutions(owner)).swaps[0].receiveAmount, undefined, 'unavailable ledger');
  f.chains.get(poolX)!.historyComplete = false;
  assert.equal(
    (await projectOwnerLedger(f)).events.find((e) => e.kind === 'swap')?.settlement
      ?.status,
    'incomplete'
  );
  f.chains.get(poolX)!.historyComplete = true;
  f.chains.get(pool)!.transactions.pop();
  assert.equal(
    (await projectOwnerLedger(f)).events.find((e) => e.kind === 'swap')?.settlement
      ?.status,
    'incomplete',
    'minOut and delivery alone do not prove durable swap consumption'
  );
  const mismatch = swapFixture();
  mismatch.f.wallets.get(ownedX)!.master = other;
  assert.notEqual(
    (await projectOwnerLedger(mismatch.f)).events.find((e) => e.kind === 'swap')
      ?.settlement?.status,
    'confirmed'
  );
}
async function testImmediateSwapFinalization() {
  const immediate = swapFixture();
  const projection = (await projectOwnerLedger(immediate.f)).events;
  const event = projection.find(e => e.kind === 'swap')!;
  assert.equal(event?.settlement?.status, 'incomplete', 'JSUC/JSFN request evidence cannot replace exact historical cash finalization');
  assert.equal(event.settlement?.queryId, '42');
  assert.deepEqual(
    projection.flatMap(row => row.movements).filter(m => m.asset.kind === 'jetton').map(m => [m.direction, m.asset.master, m.amountRaw]),
    [['out', rootT, immediate.paid.toString()], ['in', rootX, immediate.received.toString()]]
  );
  const debit = event.movements.find(m => m.asset.kind === 'jetton' && m.direction === 'out')!;
  const original = immediate.f.chains.get(ownedT)!.transactions[0].inMessage;
  assert.equal(debit.evidence.requestBodyHash, bodyCell(original)!.hash().toString('hex'));
  assert.equal(debit.evidence.queryId, '42');
  assert(event.movements.filter(m => m.asset.kind === 'jetton').every(m => m.evidence.transactions?.length === 2));
  const outputs = resolveDlmmPoolSettlementEvidence(pool, immediate.f.chains.get(pool)!.transactions.map(raw => classifyTransaction(pool, raw, opcodes)));
  assert.equal(outputs.get(`40:${hash(40)}`)?.amountOutRaw, immediate.received.toString(), 'the shared candle/ledger helper preserves the exact current output above 2^80');

  type Mutation = (f: ProjectionInput, success: RawTransaction, received: bigint) => void;
  const sid = 0x4453000000000001n;
  const cases: [string, Mutation][] = [
    ['missing finalizer', (_f, success) => { success.outMessages = []; }],
    ['wrong finalizer amount', (_f, success, received) => {
      success.outMessages[0] = message(pool, poolX, 81, tuple(0x4a53464e, sid, received + 1n, ownedX));
    }],
    ['wrong finalizer recipient wallet', (_f, success, received) => {
      success.outMessages[0] = message(pool, poolX, 81, tuple(0x4a53464e, sid, received, otherT));
    }],
    ['wrong finalizer settlement id', (_f, success, received) => {
      success.outMessages[0] = message(pool, poolX, 81, tuple(0x4a53464e, sid + 1n, received, ownedX));
    }],
    ['foreign outcome sender', (_f, success) => { success.inMessage!.source = otherT; }],
    ['foreign finalizer source wallet', (_f, success) => { success.outMessages[0].destination = otherT; }],
    ['failed outcome transaction', (_f, success) => { success.success = false; success.status = 'failed'; }],
    ['extra outcome output', (_f, success) => { success.outMessages.push(message(pool, other, 82, Cell.EMPTY)); }],
    ['duplicate finalizer', (_f, success) => { success.outMessages.push({ ...success.outMessages[0] }); }],
    ['duplicate success outcome', (f, success) => { tx(f, pool, 90, { ...success.inMessage!, createdLt: '89' }); }],
    ['detached finalizer without retry', (f, success) => {
      const finalizer = success.outMessages[0]; success.outMessages = [];
      tx(f, pool, 90, undefined, [{ ...finalizer, createdLt: '91' }]);
    }],
    ['retry mixed with immediate finalization', (f) => {
      tx(f, pool, 100, message(other, pool, 91, beginCell().storeUint(0x44535259, 32).storeUint(sid, 64).endCell()));
    }],
    ['obsolete zero-output JSUC followed by sole DSRY finalizer', (f, success, received) => {
      success.outMessages = [];
      tx(f, pool, 100,
        message(other, pool, 91, beginCell().storeUint(0x44535259, 32).storeUint(sid, 64).endCell()),
        [message(pool, poolX, 101, tuple(0x4a53464e, sid, received, ownedX))]);
    }],
    ['current DSRY resend after the initial immediate finalizer', (f, _success, received) => {
      tx(f, pool, 100,
        message(other, pool, 91, beginCell().storeUint(0x44535259, 32).storeUint(sid, 64).endCell()),
        [message(pool, poolX, 101, tuple(0x4a53464e, sid, received, ownedX))]);
    }],
    ['typed delivery bounce', (f, _success, received) => {
      tx(f, pool, 100, message(poolX, pool, 91, tuple(0x4a544246, sid, received, ownedX)));
    }],
    ['incomplete output custody history', (f) => { f.chains.get(ownedX)!.historyComplete = false; }],
    ['wrong received asset root', (f) => { f.wallets.get(ownedX)!.master = other; }],
  ];
  for (const [label, mutate] of cases) {
    const { f, received } = swapFixture();
    mutate(f, f.chains.get(pool)!.transactions.find(t => t.lt === '80')!, received);
    if (label.startsWith('obsolete ') || label.startsWith('current DSRY')) {
      const evidence = resolveDlmmPoolSettlementEvidence(pool, f.chains.get(pool)!.transactions.map(raw => classifyTransaction(pool, raw, opcodes)));
      assert.equal(evidence.size, 0, `shared candle/ledger helper rejects ${label}`);
    }
    assert.notEqual(
      (await projectOwnerLedger(f)).events.find(e => e.kind === 'swap')?.settlement?.status,
      'confirmed',
      `immediate finalization rejects ${label}`
    );
  }
}

async function testPoolSettlementEvidence() {
  const { f, received } = swapFixture();
  const rows = f.chains.get(pool)!.transactions.map(raw => classifyTransaction(pool, raw, opcodes));
  const before = JSON.stringify(rows);
  const evidence = resolveDlmmPoolSettlementEvidence(pool, rows).get(`40:${hash(40)}`)!;
  assert(evidence);
  const expectedMessage = (row: typeof rows[number], direction: 'in' | 'out', index = 0): DlmmPoolMessageEvidence => {
    const raw = direction === 'in' ? row.inMessage! : row.outMessages[index];
    return {
      transaction: { account: pool, lt: row.lt, hash: Buffer.from(row.hash, 'base64').toString('hex'), utime: row.utime },
      direction, index, source: raw.source!, destination: raw.destination!, createdLt: raw.createdLt!,
      opcode: raw.op!, bodyHash: Cell.fromBase64(raw.body!).hash().toString('hex'), bodyBoc: raw.body!,
    };
  };
  assert.deepEqual(evidence, {
    kind: 'pool-output-acknowledgement', pool, businessQueryId: '42',
    settlementId: '4923278817646084097', amountOutRaw: received.toString(),
    payerOwner: owner, recipientOwner: owner, inputWallet: poolT, sourceWallet: poolX, destinationWallet: ownedX,
    acceptance: expectedMessage(rows[0], 'in'), request: expectedMessage(rows[0], 'out'),
    succeeded: expectedMessage(rows[1], 'in'), finalizeRequest: expectedMessage(rows[1], 'out'),
  });
  assert.deepEqual([evidence.acceptance.createdLt, evidence.request.createdLt, evidence.succeeded.createdLt, evidence.finalizeRequest.createdLt], ['31', '41', '71', '81']);
  assert.deepEqual([evidence.acceptance.transaction.utime, evidence.succeeded.transaction.utime], [1700000040, 1700000080]);
  assert.equal(JSON.stringify(rows), before, 'decoding does not alter original amounts, messages, actions or transaction times');
  assert.deepEqual(resolveDlmmPoolSettlementEvidence(pool, [...rows].reverse()).get(`40:${hash(40)}`), evidence,
    'evidence identity and time do not depend on input array ordering');

  const alternateBoc = structuredClone(rows);
  alternateBoc[0].outMessages[0].body = Cell.fromBase64(rows[0].outMessages[0].body!).toBoc({ idx: true, crc32: false }).toString('base64');
  const retained = resolveDlmmPoolSettlementEvidence(pool, alternateBoc).get(`40:${hash(40)}`)!;
  assert.equal(retained.request.bodyHash, evidence.request.bodyHash);
  assert.equal(retained.request.bodyBoc, alternateBoc[0].outMessages[0].body);
  assert.notEqual(retained.request.bodyBoc, evidence.request.bodyBoc, 'retain original BOC bytes even when serialization differs for the same cell');

  const aliases = structuredClone(rows);
  for (const row of aliases) {
    row.hash = Buffer.from(row.hash, 'base64').toString('hex').toUpperCase(); row.ui.txId = `${row.lt}:${row.hash}`;
    row.address = A(pool).toString();
    for (const msg of [row.inMessage!, ...row.outMessages]) {
      msg.source = A(msg.source!).toString(); msg.destination = A(msg.destination!).toString();
    }
  }
  assert.deepEqual(resolveDlmmPoolSettlementEvidence(A(pool).toString(), aliases).get(aliases[0].ui.txId), evidence,
    'valid provider address/hash encodings resolve to the same canonical proof');

  const cases: Array<[string, (input: typeof rows) => void]> = [
    ['short transaction hash', input => { input[0].hash = '00'; input[0].ui.txId = '40:00'; }],
    ['malformed acknowledgement transaction hash', input => { input[1].hash = 'not-a-transaction'; input[1].ui.txId = `80:${input[1].hash}`; }],
    ['mismatched transaction UI identity', input => { input[1].ui.txId = `81:${hash(80)}`; }],
    ['invalid transaction LT', input => { input[0].lt = '040'; input[0].ui.txId = `040:${input[0].hash}`; }],
    ['negative transaction timestamp', input => { input[0].utime = -1; input[0].ui.utime = -1; }],
    ['fractional acknowledgement timestamp', input => { input[1].utime += 0.5; input[1].ui.utime = input[1].utime; }],
    ['nonfinite transaction timestamp', input => { input[0].utime = NaN; input[0].ui.utime = NaN; }],
    ['mismatched acknowledgement UI timestamp', input => { input[1].ui.utime++; }],
    ['foreign transaction account', input => { input[1].address = other; }],
    ['duplicate physical acceptance with another hash encoding', input => {
      const copy = structuredClone(input[0]); copy.hash = Buffer.from(copy.hash, 'base64').toString('hex'); copy.ui.txId = `${copy.lt}:${copy.hash}`; input.push(copy);
    }],
  ];
  const messages = [
    ['acceptance', (input: typeof rows) => input[0].inMessage!],
    ['request', (input: typeof rows) => input[0].outMessages[0]],
    ['succeeded', (input: typeof rows) => input[1].inMessage!],
    ['finalize request', (input: typeof rows) => input[1].outMessages[0]],
  ] as const;
  for (const [name, get] of messages) {
    cases.push([`${name} missing created LT`, input => { delete get(input).createdLt; }]);
    cases.push([`${name} zero created LT`, input => { get(input).createdLt = '0'; }]);
    cases.push([`${name} noncanonical created LT`, input => { get(input).createdLt = '01'; }]);
    cases.push([`${name} overflowing created LT`, input => { get(input).createdLt = '18446744073709551616'; }]);
    cases.push([`${name} missing endpoint`, input => { delete get(input).source; }]);
    cases.push([`${name} malformed BOC`, input => { get(input).body = 'AAAA'; }]);
    cases.push([`${name} bounced envelope`, input => { get(input).bounced = true; }]);
  }
  for (const [label, mutate] of cases) {
    const input = structuredClone(rows); mutate(input);
    const original = structuredClone(input);
    assert.equal(resolveDlmmPoolSettlementEvidence(pool, input).size, 0, `reject ${label}`);
    assert.deepEqual(input, original, `preserve malformed source for ${label}`);
  }

  const sid = 0x4453000000000002n;
  tx(f, pool, 140, { ...rows[0].inMessage!, createdLt: '131' }, [message(pool, poolX, 141,
    transfer(sid, received, owner, pool, Cell.EMPTY, beginCell().storeUint(0x4a535454, 32).endCell()))]);
  tx(f, pool, 180, message(poolX, pool, 171, tuple(0x4a535543, sid, received, ownedX)),
    [message(pool, poolX, 181, tuple(0x4a53464e, sid, received, ownedX))]);
  const repeated = resolveDlmmPoolSettlementEvidence(pool, f.chains.get(pool)!.transactions.map(raw => classifyTransaction(pool, raw, opcodes)));
  assert.equal(repeated.size, 2, 'a repeated business query is not a physical settlement identity');
  assert.deepEqual([...repeated.values()].map(row => [row.businessQueryId, row.settlementId, row.acceptance.transaction.lt]),
    [['42', evidence.settlementId, '40'], ['42', sid.toString(), '140']]);
  console.log(`rich pool settlement evidence: exact four-message proof, canonical identities, original BOC, ${cases.length} malformed cases and repeated business IDs passed`);
}

function testAuthenticPoolSettlementEvidence() {
  const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/dlmm-market-settlements.json'), 'utf8')) as {
    accounts: { pool: string; payer: string; recipient: string };
    transactions: Array<{ phase: string; account: string; raw: RawTransaction }>;
  };
  const poolAddress = fixture.accounts.pool;
  const source = fixture.transactions.filter(row => row.account === poolAddress);
  const indexed = source.map(row => classifyTransaction(poolAddress, row.raw, opcodes));
  const before = JSON.stringify(indexed);
  assert(source.some(row => row.phase === 'retry-underfunded-failed' && row.raw.success === false &&
    row.raw.outMessages.some(message => message.bounced === true && message.op === 0xffffffff)),
    'the complete authentic history includes an unrelated failed DSRY and its real bounce');
  const proofs = resolveDlmmPoolSettlementEvidence(poolAddress, indexed);
  assert.equal(proofs.size, 4, 'a real failed retry must not erase independent immediate settlement proofs');
  const expected = [
    ['full-t-to-x', '60000000', '201', '4923278817646084097', '9997'],
    ['full-x-to-t', '71000000', '202', '4923278817646084098', '14995'],
    ['repeat-business-query', '82000000', '201', '4923278817646084099', '9997'],
    ['partial-input-refund', '120000000', '205', '4923278817646084103', '983006'],
  ];
  for (const [phase, lt, businessId, settlementId, amount] of expected) {
    const original = source.find(row => row.phase === phase && row.raw.lt === lt)!;
    const proof = proofs.get(`${lt}:${original.raw.hash}`)!;
    assert(proof, `missing authentic ${phase} evidence`);
    assert.equal(proof.businessQueryId, businessId);
    assert.equal(proof.settlementId, settlementId);
    assert.equal(proof.amountOutRaw, amount);
    for (const message of [proof.acceptance, proof.request, proof.succeeded, proof.finalizeRequest]) {
      const transaction = source.find(row => row.raw.lt === message.transaction.lt && row.raw.hash === message.transaction.hash)!.raw;
      const raw = message.direction === 'in' ? transaction.inMessage! : transaction.outMessages[message.index];
      assert.deepEqual(message, {
        transaction: { account: poolAddress, lt: transaction.lt, hash: transaction.hash, utime: transaction.utime },
        direction: message.direction, index: message.index,
        source: Address.parse(raw.source!).toRawString(), destination: Address.parse(raw.destination!).toRawString(),
        createdLt: raw.createdLt, opcode: raw.op, bodyHash: Cell.fromBase64(raw.body!).hash().toString('hex'), bodyBoc: raw.body,
      }, `${phase} retains exact original transaction and message evidence`);
    }
    assert.deepEqual(proof.acceptance.transaction, proof.request.transaction);
    assert.deepEqual(proof.succeeded.transaction, proof.finalizeRequest.transaction,
      'the acknowledgement emits its finalizer in that exact pool transaction');
    assert.equal(proof.request.destination, proof.sourceWallet);
    assert.equal(proof.succeeded.source, proof.sourceWallet);
    assert.equal(proof.finalizeRequest.destination, proof.sourceWallet);
  }
  const first = [...proofs.values()][0];
  assert.equal(first.payerOwner, fixture.accounts.payer);
  assert.equal(first.recipientOwner, fixture.accounts.recipient);
  assert.notEqual(first.payerOwner, first.recipientOwner, 'the requested beneficiary is not replaced by the payer');
  const partial = [...proofs.values()].find(row => row.businessQueryId === '205')!;
  assert.equal(partial.request.index, 1, 'output evidence selects the actual output transfer after the separate input refund');
  assert(!Object.hasOwn(partial, 'amountInRaw'), 'this proof makes no gross-input or net-consumed-input claim');
  assert(!Object.hasOwn(partial, 'recipientCredit'), 'emitted finalization does not claim recipient credit');
  for (const phase of ['slippage-full-refund', 'underfunded-output', 'retry-output-recovery']) {
    assert(!source.filter(row => row.phase === phase).some(row => proofs.has(`${row.raw.lt}:${row.raw.hash}`)),
      `${phase} is outside the immediate output proof`);
  }
  assert.equal(JSON.stringify(indexed), before, 'authentic source transactions remain immutable');
  console.log('authentic pool evidence: four immediate full/repeated/partial proofs, exact original messages, failed-retry isolation and recovery/refund exclusion passed');
}

async function testCandlePoolEvidenceConsumer() {
  const { f } = swapFixture();
  const raw = f.chains.get(pool)!.transactions;
  for (const malformed of [false, true]) {
    const rows = raw.map(row => classifyTransaction(pool, row, opcodes));
    if (malformed) delete rows[1].inMessage!.createdLt;
    const config = { ...loadConfig(), network: 'testnet' as const, responseCacheEnabled: false };
    const store = new MemoryStore(config);
    store.addTransactions(pool, rows);
    store.setBalance(pool, { address: pool, balance: '0', lastTxLt: '80', lastTxHash: hash(80), updatedAt: Date.now() });
    store.markHistoryComplete(pool);
    let calls = 0;
    const unavailable = async (): Promise<never> => { calls++; throw Error('Unexpected source request'); };
    const source: TonDataSource = { network: 'testnet', getMasterchainInfo: unavailable, getAccountState: unavailable,
      getTransactions: unavailable, runGetMethod: unavailable, getJettonBalance: unavailable, getJettonMetadata: unavailable, close: async () => {} };
    const service = new IndexerService(config, store, source, opcodes, []);
    const result = await service.getMarketCandles('spot:TOKEN-T3', pool, { assetSymbol: 'TOKEN', quoteSymbol: 'T3', assetDecimals: 9, quoteDecimals: 9 });
    assert.equal(result.candle_count, malformed ? 0 : 1, 'candle fallback consumes the rich evidence amount only when its identities qualify');
    if (!malformed) assert.deepEqual(result.candles[0].sourceTxIds, [`40:${hash(40)}`]);
    assert.equal(calls, 0, 'consumer regression uses local indexed evidence only');
  }
}
async function testDeposit() {
  const f = fixture(),
    qid = 99n;
  const forward = beginCell()
    .storeUint(ADD, 32)
    .storeUint(qid, 64)
    .storeAddress(A(owner))
    .storeInt(-7, 32)
    .storeUint(1, 256)
    .endCell();
  const t = payerLeg(f, 10, 101n, 1011n, rootT, forward);
  const before = tx(f, pool, 40, t.notification);
  const x = payerLeg(f, 50, 102n, 3033n, rootX, forward);
  const after = tx(f, pool, 80, x.notification);
  f.stateAt = async (_account, lt, h) =>
    lt === before.lt && h === before.hash
      ? state(before, 9007199254740993n, 100)
      : lt === after.lt && h === after.hash
        ? state(after, 9007199254741000n, 101)
        : null;
  const events = (await projectOwnerLedger(f)).events.filter(e => e.kind === 'lp_deposit');
  assert.equal(events.length, 2, 'unqualified contributions remain independent instead of joining on a reusable query');
  const event = events[0];
  assert.equal(event.settlement?.status, 'incomplete', 'Partial synthetic dictionary does not qualify current pool state');
  assert.deepEqual(
    events.flatMap(row => row.movements)
      .filter((m) => m.asset.kind === 'jetton')
      .map((m) => [m.direction, m.asset.master, m.amountRaw]),
    [
      ['out', rootT, '1011'],
      ['out', rootX, '3033'],
    ]
  );
  assert(!event.movements.some(m => m.asset.kind === 'lp_position'), 'An unqualified dictionary delta is not mint evidence');
  f.stateAt = async () => null;
  const absent = (await projectOwnerLedger(f)).events.find(
    (e) => e.kind === 'lp_deposit'
  )!;
  assert.equal(absent.settlement?.status, 'incomplete');
  assert(
    !absent.movements.some((m) => m.asset.kind === 'lp_position'),
    'minimum LP output never becomes a minted amount'
  );
  f.chains.get(pool)!.transactions.pop();
  const one = (await projectOwnerLedger(f)).events.find(
    (e) => e.kind === 'lp_deposit'
  )!;
  assert.equal(one.settlement?.status, 'incomplete');
}
async function testWithdrawal() {
  const f = fixture(),
    q = 75n,
    shares = 9007199254740993n,
    sid = 0x4453000000000100n;
  const before = tx(f, pool, 5);
  const body = beginCell()
    .storeUint(REMOVE, 32)
    .storeUint(q, 64)
    .storeInt(-7, 32)
    .storeUint(shares, 256)
    .storeAddress(A(owner))
    .endCell();
  const request = message(owner, pool, 11, body);
  tx(f, owner, 10, undefined, [request]);
  const rt = message(
    pool,
    poolT,
    21,
    transfer(
      sid,
      11n,
      owner,
      pool,
      Cell.EMPTY,
      beginCell().storeUint(0x4a535454, 32).endCell()
    )
  );
  const rx = message(
    pool,
    poolX,
    22,
    transfer(
      sid + 1n,
      33n,
      owner,
      pool,
      Cell.EMPTY,
      beginCell().storeUint(0x4a535454, 32).endCell()
    )
  );
  const after = tx(f, pool, 20, request, [rt, rx]);
  outputLeg(f, 30, sid, 11n, rootT, rt);
  outputLeg(f, 50, sid + 1n, 33n, rootX, rx);
  const unrelated = message(
    pool,
    poolT,
    64,
    transfer(
      999n,
      11n,
      owner,
      pool,
      Cell.EMPTY,
      beginCell().storeUint(0x4a535454, 32).endCell()
    )
  );
  outputLeg(f, 65, 999n, 11n, rootT, unrelated);
  const receipt = beginCell()
    .storeUint(WITHDRAW_COMPLETE, 32)
    .storeUint(q, 64)
    .storeInt(-7, 32)
    .storeUint(shares, 256)
    .storeRef(
      beginCell().storeAddress(A(owner)).storeAddress(A(owner)).endCell()
    )
    .storeRef(beginCell().storeCoins(11).storeCoins(33).endCell())
    .endCell();
  const complete = message(pool, owner, 81, receipt);
  const terminal = tx(f, pool, 80, undefined, [complete]);
  tx(f, owner, 90, complete);
  const record = beginCell()
    .storeUint(0x44575231, 32)
    .storeUint(q, 64)
    .storeInt(-7, 32)
    .storeUint(shares, 256)
    .storeUint(1, 2)
    .storeUint(1, 2)
    .storeUint(sid, 64)
    .storeUint(sid + 1n, 64)
    .storeRef(
      beginCell().storeAddress(A(owner)).storeAddress(A(owner)).endCell()
    )
    .storeRef(beginCell().storeCoins(11).storeCoins(33).storeCoins(0).endCell())
    .storeRef(
      beginCell().storeAddress(A(poolT)).storeAddress(A(poolX)).endCell()
    )
    .storeRef(
      beginCell().storeAddress(A(ownedT)).storeAddress(A(ownedX)).endCell()
    )
    .endCell();
  f.stateAt = async (_account, lt, h) =>
    lt === before.lt && h === before.hash
      ? state(before, shares + 7n, 100)
      : lt === after.lt && h === after.hash
        ? state(after, 7n, 101)
        : lt === terminal.lt && h === terminal.hash
          ? state(terminal, 7n, 102, record)
          : null;
  assert.equal(withdrawalRequest(request)?.queryId, '75');
  assert.equal(
    classifyTransaction(pool, after, opcodes).actions.find(
      (a) => a.kind === 'lp_withdraw'
    )?.lpBurned,
    shares.toString()
  );
  const event = (await projectOwnerLedger(f)).events.find(
    (e) => e.kind === 'lp_withdraw'
  )!;
  assert.equal(event.settlement?.status, 'incomplete', 'Amounts and a terminal nonce alone do not qualify current contract execution');
  assert(!event.movements.some(m => m.asset.kind === 'lp_position'), 'Unqualified share dictionary never proves a burn');
  assert(!event.settlement?.dlmmLiquidity, 'No principal or fee breakdown is invented from aggregate payouts');
  assert.equal((await projectOwnerLedger(f)).events.flatMap(e => e.movements).filter(m => m.asset.kind === 'jetton').length, 3,
    'All physical receipts remain available even when protocol attribution is unresolved');
  f.chains.get(ownedX)!.historyComplete = false;
  assert.equal(
    (await projectOwnerLedger(f)).events.find((e) => e.kind === 'lp_withdraw')
      ?.settlement?.status,
    'incomplete'
  );
  f.chains.get(ownedX)!.historyComplete = true;
  f.stateAt = async () => null;
  assert(
    !(await projectOwnerLedger(f)).events
      .flatMap((e) => e.movements)
      .some((m) => m.asset.kind === 'lp_position'),
    'unavailable state never uses requested shares as burned proof'
  );
}
async function testTransfersAndDedup() {
  const f = fixture();
  const q = 12n,
    amount = 123456789012345678901234n;
  payerLeg(f, 10, q, amount, rootT, Cell.EMPTY, other);
  const event = (await projectOwnerLedger(f)).events.find((e) =>
    e.movements.some((m) => m.asset.kind === 'jetton')
  )!;
  assert.equal(event.settlement?.status, 'confirmed');
  assert.equal(
    event.movements.find((m) => m.asset.kind === 'jetton')?.amountRaw,
    amount.toString()
  );
  const hop = f.chains.get(ownedT)!.transactions[0].outMessages[0];
  hop.createdLt = undefined;
  f.chains.get(otherT)!.transactions[0].inMessage = { ...hop };
  assert(
    !(await projectOwnerLedger(f)).events
      .flatMap((e) => e.movements)
      .some((m) => m.asset.kind === 'jetton' && m.direction === 'out'),
    'unlinked messages cannot prove a debit'
  );
  const typed = fixture(),
    wire = message(
      poolT,
      ownedT,
      11,
      internal(q, 100n, pool, poolT, Cell.EMPTY, true)
    );
  const typedRequest = (lt: number, value = 100n) =>
    message(
      pool,
      poolT,
      lt,
      transfer(
        q,
        value,
        owner,
        pool,
        Cell.EMPTY,
        beginCell().storeUint(0x4a535454, 32).endCell()
      )
    );
  tx(typed, poolT, 10, typedRequest(1), [wire]);
  tx(typed, ownedT, 20, wire);
  const replay = { ...wire, createdLt: '31' };
  tx(typed, poolT, 30, typedRequest(21), [replay]);
  tx(typed, ownedT, 40, replay);
  const events = (await projectOwnerLedger(typed)).events;
  assert.equal(
    events.flatMap((e) => e.movements).filter((m) => m.asset.kind === 'jetton')
      .length,
    1,
    'typed accepted settlement replay credits only once'
  );
  assert.equal(
    events[0].totalFeesRaw,
    '200',
    'duplicate replay still contributes its real processing fees'
  );
  const bad = {
    ...wire,
    createdLt: '51',
    body: internal(q, 101n, pool, poolT, Cell.EMPTY, true)
      .toBoc()
      .toString('base64'),
  };
  tx(typed, poolT, 50, typedRequest(41, 101n), [bad]);
  tx(typed, ownedT, 60, bad);
  assert(
    (await projectOwnerLedger(typed)).events.some((e) =>
      e.issues.includes('jetton_replay_conflict')
    )
  );
  const unknown = fixture();
  unknown.wallets.clear();
  const n = message(
    otherT,
    owner,
    11,
    notify(q, amount, other, otherT, Cell.EMPTY)
  );
  tx(unknown, owner, 20, n);
  assert.equal(
    (await projectOwnerLedger(unknown)).events[0].movements.find(
      (m) => m.asset.kind === 'unknown'
    )?.amountRaw,
    amount.toString(),
    'unresolved identity retains exact receipt amount'
  );
  const standard = beginCell()
    .storeUint(INTERNAL, 32)
    .storeUint(q, 64)
    .storeCoins(amount)
    .storeAddress(A(other))
    .storeAddress(A(other))
    .storeCoins(0)
    .storeBit(false)
    .endCell();
  assert.equal(
    tokenWire(message(otherT, ownedT, 100, standard))?.amountRaw,
    amount.toString(),
    'standard external TEP74 remains a supported distinct wire format'
  );
}
async function testArchive() {
  const zeroHash = '0'.repeat(64);
  const emptySource = {
    getMasterchainInfo: async () => ({seqno: 100}),
    getAccountStateAtSeqno: async (_account: string, seqno: number) => seqno < 40
      ? {balance: '0', accountState: 'uninitialized', lastTxLt: '0', lastTxHash: zeroHash}
      : {balance: '1', accountState: 'active', lastTxLt: '10', lastTxHash: hash(10)},
  } as TonDataSource;
  assert.equal((await findTransactionState(emptySource, pool, {lt: '0', hash: zeroHash}))?.seqno, 39,
    'First credit uses the last authenticated transaction-free block');
  assert.equal(await findTransactionState(emptySource, pool, {lt: '0', hash: hash(1)}), null, 'Nonzero first-transaction hash is rejected');
  assert.equal(await findTransactionState({...emptySource, getAccountStateAtSeqno: async () =>
    ({balance: '0', accountState: 'active', lastTxLt: '0', lastTxHash: zeroHash})} as TonDataSource, pool, {lt: '0', hash: zeroHash}), null,
    'An active zero-cursor state cannot establish an undeployed wallet');
  assert.equal(await findTransactionState({...emptySource, getAccountStateAtSeqno: async () =>
    ({balance: '0', accountState: 'uninitialized'})} as TonDataSource, pool, {lt: '0', hash: zeroHash}), null,
    'Missing history metadata does not establish absence');
  assert.throws(() => readDlmmLiquidityState(positionData(9007199254740993n).toBoc().toString('base64')), 'A partial position cell is not the current DLMM layout');
  const source = {
    getMasterchainInfo: async () => ({ seqno: 100 }),
    getAccountStateAtSeqno: async (_account: string, seqno: number) => ({
      balance: '0',
      lastTxLt: seqno < 40 ? '10' : seqno < 80 ? '20' : '30',
      lastTxHash: hash(seqno < 40 ? 10 : seqno < 80 ? 20 : 30),
    }),
  } as TonDataSource;
  assert.equal(
    (await findTransactionState(source, pool, { lt: '20', hash: hash(20) }))
      ?.seqno,
    40
  );
  assert.equal(
    await findTransactionState(source, pool, { lt: '21', hash: hash(21) }),
    null,
    'intrablock intermediate transactions have no fabricated state'
  );
  assert.equal(
    await findTransactionState(source, pool, { lt: '20', hash: hash(99) }),
    null,
    'LT without exact account-state transaction hash cannot prove a delta'
  );
}
async function main() {
  await testSwap();
  await testImmediateSwapFinalization();
  await testPoolSettlementEvidence();
  testAuthenticPoolSettlementEvidence();
  await testCandlePoolEvidenceConsumer();
  await testDeposit();
  await testWithdrawal();
  await testTransfersAndDedup();
  await testArchive();
  console.log(
    'ledger spot settlement, unqualified LP rejection, custody fees, replay deduplication and archive provenance tests passed'
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
