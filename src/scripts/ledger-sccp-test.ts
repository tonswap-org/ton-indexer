import assert from 'node:assert/strict';
import { Address, Cell, beginCell } from '@ton/core';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { LedgerService } from '../ledger/service';
import { createLogger } from '../utils/logger';
import type {
  RawMessage,
  RawTransaction,
  TonDataSource,
} from '../data/dataSource';
import {
  projectOwnerLedger,
  type ProjectionInput,
  type LedgerChain,
} from '../ledger/project';
import { parseLedgerSccpBindings } from '../config/ledgerBridge';
import { parseSccpBurnRecord } from '../utils/sccpEvidence';
import {
  SCCP_BURN,
  SCCP_BURN_NOTIFY,
  SCCP_BURNED,
  SCCP_MINT,
  sccpMessageId,
} from '../ledger/sccpWire';
import { INTERNAL } from '../ledger/wire';
import { loadOpcodes } from '../utils/opcodes';
const addr = (n: number) => `0:${n.toString(16).padStart(64, '0')}`,
  A = (s: string) => Address.parse(s);
const owner = addr(201),
  wallet = addr(202),
  master = addr(203),
  verifier = addr(204),
  other = addr(205);
const soraAssetId = '0x' + '11'.repeat(32),
  recipient = '0x' + '22'.repeat(32),
  amount = (2n ** 80n + 15n).toString();
const masterCode = beginCell().storeUint(1001, 32).endCell(),
  verifierCode = beginCell().storeUint(1002, 32).endCell();
const binding = {
  master,
  soraAssetId,
  masterCodeHash: masterCode.hash().toString('hex'),
  verifier,
  verifierCodeHash: verifierCode.hash().toString('hex'),
};
const hash = (lt: number) =>
  createHash('sha256').update(String(lt)).digest('base64');
const msg = (
  source: string,
  destination: string,
  createdLt: number,
  body: Cell,
  value = '100',
): RawMessage => ({
  source,
  destination,
  createdLt: String(createdLt),
  body: body.toBoc().toString('base64'),
  op: body.beginParse().preloadUint(32),
  value,
  forwardFeeRaw: '3',
  ihrFeeRaw: '0',
  bounced: false,
});
function fixture() {
  const chains = new Map<string, LedgerChain>();
  for (const account of [owner, wallet, master, verifier])
    chains.set(account, {
      account,
      role:
        account === owner
          ? 'owner'
          : account === wallet
            ? 'owned_jetton_wallet'
            : 'counterparty',
      generation: 'fixture',
      historyComplete: true,
      transactions: [],
    });
  const input: ProjectionInput = {
    network: 'testnet',
    owner,
    chains,
    wallets: new Map([
      [
        wallet,
        {
          kind: 'jetton',
          id: `testnet:jetton:${master}`,
          master,
          wallet,
          owner,
          decimals: 18,
        },
      ],
    ]),
    pools: new Map(),
    stateAt: async () => null,
    opcodes: loadOpcodes(),
    sccpMasters: new Map([
      [
        master,
        { ...binding, nonce: '9', verifierTrusted: true, burns: new Map() },
      ],
    ]),
  };
  const tx = (
    account: string,
    lt: number,
    inMessage?: RawMessage,
    outMessages: RawMessage[] = [],
  ) => {
    const list = chains.get(account)!.transactions,
      previous = list.at(-1),
      raw: RawTransaction = {
        lt: String(lt),
        hash: hash(lt),
        prevTransactionLt: previous?.lt ?? '0',
        prevTransactionHash:
          previous?.hash ?? Buffer.alloc(32).toString('base64'),
        utime: 1700000000 + lt,
        success: true,
        status: 'success',
        totalFeesRaw: account === master ? '500' : '100',
        inMessage,
        outMessages,
      };
    list.push(raw);
    return raw;
  };
  const burn = (start = 10, nonce = '9') => {
    const request = beginCell()
      .storeUint(SCCP_BURN, 32)
      .storeUint(7, 64)
      .storeCoins(BigInt(amount))
      .storeUint(0, 32)
      .storeUint(BigInt(recipient), 256)
      .storeAddress(A(owner))
      .endCell();
    const notify = beginCell()
      .storeUint(SCCP_BURN_NOTIFY, 32)
      .storeUint(7, 64)
      .storeCoins(BigInt(amount))
      .storeAddress(A(owner))
      .storeRef(
        beginCell()
          .storeUint(0, 32)
          .storeUint(BigInt(recipient), 256)
          .endCell(),
      )
      .storeAddress(A(owner))
      .endCell();
    const messageId = sccpMessageId(
        4,
        0,
        nonce,
        soraAssetId,
        amount,
        recipient,
      ),
      burned = beginCell()
        .storeUint(SCCP_BURNED, 32)
        .storeUint(7, 64)
        .storeUint(BigInt(messageId), 256)
        .storeUint(BigInt(nonce), 64)
        .endCell();
    const record = beginCell()
      .storeAddress(A(owner))
      .storeUint(0, 32)
      .storeUint(BigInt(recipient), 256)
      .storeCoins(BigInt(amount))
      .storeUint(BigInt(nonce), 64)
      .endCell();
    input
      .sccpMasters!.get(master)!
      .burns.set(messageId, {
        record: parseSccpBurnRecord(record),
        boc: record.toBoc().toString('base64'),
        observedAt: '2026-09-07T00:00:00.000Z',
      });
    const a = msg(owner, wallet, start + 1, request, '1000'),
      b = msg(wallet, master, start + 11, notify, '900'),
      c = msg(master, owner, start + 21, burned),
      d = msg(
        master,
        owner,
        start + 22,
        beginCell().storeUint(0xd53276db, 32).storeUint(7, 64).endCell(),
        '200',
      );
    tx(owner, start, undefined, [a]);
    tx(wallet, start + 10, a, [b]);
    tx(master, start + 20, b, [c, d]);
    tx(owner, start + 30, c);
    tx(owner, start + 40, d);
    return {
      messageId,
      record,
      rootTx: chains.get(master)!.transactions.at(-1)!,
    };
  };
  const mint = (start = 100) => {
    const recipient32 = '0x' + owner.split(':')[1],
      messageId = sccpMessageId(0, 4, '12', soraAssetId, amount, recipient32);
    const mint = beginCell()
      .storeUint(SCCP_MINT, 32)
      .storeUint(8, 64)
      .storeUint(0, 32)
      .storeUint(12, 64)
      .storeCoins(BigInt(amount))
      .storeUint(BigInt(recipient32), 256)
      .storeAddress(A(owner))
      .endCell();
    const internal = beginCell()
      .storeUint(INTERNAL, 32)
      .storeUint(8, 64)
      .storeCoins(BigInt(amount))
      .storeAddress(null)
      .storeAddress(A(owner))
      .storeCoins(0)
      .storeRef(beginCell().storeUint(BigInt(messageId), 256).endCell())
      .endCell();
    const a = msg(
        owner,
        verifier,
        start + 1,
        beginCell().storeUint(0x1a9b2c7e, 32).endCell(),
        '1000',
      ),
      b = msg(verifier, master, start + 11, mint, '900'),
      c = msg(master, wallet, start + 21, internal, '800'),
      d = msg(
        wallet,
        owner,
        start + 31,
        beginCell().storeUint(0xd53276db, 32).storeUint(8, 64).endCell(),
        '200',
      );
    tx(owner, start, undefined, [a]);
    tx(verifier, start + 10, a, [b]);
    tx(master, start + 20, b, [c]);
    tx(wallet, start + 30, c, [d]);
    tx(owner, start + 40, d);
    return { messageId, recipient32 };
  };
  return { input, tx, burn, mint };
}
async function event(f: ReturnType<typeof fixture>, kind = 'bridge_burn') {
  return (await projectOwnerLedger(f.input)).events.find((e) => e.kind === kind)!;
}
async function numerical() {
  assert.equal(
    sccpMessageId(1, 0, '777', soraAssetId, '10', recipient),
    '0xf3cac8c5acfb0670a24e9ffeab7e409a9d54d1dc5e6dbaf0ee986462fe1ffb3a',
    'independent sccp-ton SCALE/Keccak reference vector',
  );
  const f = fixture(),
    burn = f.burn(),
    e = await event(f);
  assert.equal(e.settlement?.status, 'confirmed', JSON.stringify(e));
  assert.equal(e.settlement.bridge?.messageId, burn.messageId);
  assert.equal(e.settlement.bridge?.localStage, 'burned');
  assert.equal(e.settlement.bridge?.counterpartyStatus, 'unverified');
  assert(e.issues.includes('bridge_counterparty_unverified'));
  assert.deepEqual(
    e.movements
      .filter((m) => m.asset.kind === 'jetton')
      .map((m) => [m.direction, m.amountRaw, m.asset.id]),
    [['out', amount, `testnet:jetton:${master}`]],
  );
  assert.equal(e.totalFeesRaw, '400');
  assert.equal(
    e.movements
      .filter((m) => m.evidence.kind === 'transaction_fee')
      .reduce((sum, m) => sum + BigInt(m.amountRaw), 0n),
    400n,
  );
  assert.equal(
    e.movements
      .filter((m) => m.evidence.kind === 'message_forward_fee')
      .reduce((sum, m) => sum + BigInt(m.amountRaw), 0n),
    6n,
  );
  assert.equal(
    e.settlement.bridge!.localNetworkFees.find(
      (f) => f.transaction.account === master,
    )?.includedInOwnerFeeMovements,
    false,
  );
  assert.equal(
    e.settlement.bridge!.localNetworkFees.find(
      (f) => f.transaction.account === master,
    )?.amountRaw,
    '500',
  );
  assert.deepEqual(
    e.movements
      .filter((m) => m.asset.kind === 'native' && m.direction !== 'fee')
      .map((m) => [m.direction, m.amountRaw])
      .sort(),
    [
      ['in', '100'],
      ['in', '200'],
      ['out', '900'],
    ],
  );
  assert.equal(
    e.movements.find((m) => m.evidence.kind === 'sccp_burn_record')?.evidence
      .getter?.result[0],
    burn.record.toBoc().toString('base64'),
  );
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.input.sccpMasters!.clear(),
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(master)!.historyComplete = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(master)!.transactions[0].success = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(master)!.transactions[0].inMessage = {
        ...f.input.chains.get(master)!.transactions[0].inMessage!,
        source: other,
      };
    },
    (f: ReturnType<typeof fixture>) => {
      f.input
        .sccpMasters!.get(master)!
        .burns.values()
        .next().value!.record.amount += 1n;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input
        .sccpMasters!.get(master)!
        .burns.values()
        .next().value!.record.burnInitiator = other;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.sccpMasters!.get(master)!.soraAssetId = '0x' + 'ff'.repeat(32);
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.sccpMasters!.get(master)!.nonce = '8';
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(master)!.transactions[0].outMessages = [];
    },
  ]) {
    const f = fixture();
    f.burn();
    mutate(f);
    const e = await event(f);
    assert.equal(e.settlement?.status, 'incomplete');
    assert(!e.movements.some((m) => m.evidence.kind === 'sccp_burn_record'));
    assert.equal(e.settlement?.bridge?.counterpartyStatus, 'unverified');
  }
  const replay = fixture();
  replay.burn();
  replay.burn(60);
  const replayed = (await projectOwnerLedger(replay.input)).events;
  assert.equal(
    replayed
      .flatMap((e) => e.movements)
      .filter((m) => m.evidence.kind === 'sccp_burn_record').length,
    1,
  );
  assert.equal(
    replayed.reduce((sum, e) => sum + BigInt(e.totalFeesRaw!), 0n),
    800n,
    'replay dedupes bridge principal but preserves each physical owned fee',
  );
  const minted = fixture(),
    m = minted.mint(),
    me = await event(minted, 'bridge_mint');
  assert.equal(me.settlement?.status, 'confirmed', JSON.stringify(me));
  assert.equal(me.settlement.bridge?.localStage, 'minted');
  assert.equal(me.settlement.bridge?.messageId, m.messageId);
  assert.equal(me.settlement.bridge?.counterpartyStatus, 'unverified');
  assert.deepEqual(
    me.movements
      .filter((m) => m.asset.kind === 'jetton')
      .map((m) => [m.direction, m.amountRaw]),
    [['in', amount]],
  );
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.input.sccpMasters!.get(master)!.verifierTrusted = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(verifier)!.historyComplete = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(master)!.transactions[0].success = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(master)!.transactions[0].inMessage = {
        ...f.input.chains.get(master)!.transactions[0].inMessage!,
        source: other,
      };
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.sccpMasters!.get(master)!.soraAssetId = '0x' + 'ff'.repeat(32);
    },
  ]) {
    const f = fixture();
    f.mint();
    mutate(f);
    const events = (await projectOwnerLedger(f.input)).events;
    assert(
      !events.some(
        (e) => e.kind === 'bridge_mint' && e.settlement?.status === 'confirmed',
      ),
    );
    assert(
      !events
        .flatMap((e) => e.movements)
        .some((m) => m.evidence.kind === 'sccp_mint'),
    );
    assert(
      events
        .flatMap((e) => e.movements)
        .some((m) => m.asset.kind === 'jetton' && m.amountRaw === amount),
      'unclassified real wallet credit is retained',
    );
  }
  const repeatMint = fixture();
  repeatMint.mint();
  repeatMint.mint(160);
  assert.equal(
    (await projectOwnerLedger(repeatMint.input)).events
      .flatMap((e) => e.movements)
      .filter((m) => m.evidence.kind === 'sccp_mint').length,
    1,
  );
}
async function database() {
  const f = fixture();
  f.burn();
  f.mint();
  const db = new PGlite();
  const pool: LedgerSqlPool = {
    query: async (sql, params) =>
      !params && sql.includes(';')
        ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] }
        : db.query(sql, params),
    connect: async () => pool,
    end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool);
  let incomplete = true,
    wrongAsset = false;
  const int = (value: number | bigint) => ({
      type: 'int' as const,
      value: BigInt(value),
    }),
    cell = (a: string) => ({
      type: 'slice' as const,
      cell: beginCell().storeAddress(A(a)).endCell(),
    });
  const source: TonDataSource = {
    network: 'testnet',
    getMasterchainInfo: async () => ({ seqno: 1 }),
    getAccountState: async (account) => {
      const head = f.input.chains.get(account)?.transactions.at(-1);
      return {
        balance: '0',
        lastTxLt: head?.lt,
        lastTxHash: head?.hash,
        accountState: 'active',
        codeBoc: (account === master ? masterCode : verifierCode)
          .toBoc()
          .toString('base64'),
      };
    },
    getTransactions: async (account, limit, lt) => {
      const list = f.input.chains.get(account)?.transactions ?? [];
      if (account === verifier && incomplete) return [];
      return list
        .filter((t) => BigInt(t.lt) <= BigInt(lt!))
        .slice()
        .reverse()
        .slice(0, limit);
    },
    getJettonBalance: async (o, m) =>
      o === owner && m === master ? { wallet, balance: '0' } : null,
    getJettonMetadata: async () => ({ decimals: 18 }),
    close: async () => {},
    runGetMethod: async (account, method, args) => {
      if (account === wallet && method === 'get_wallet_data')
        return {
          exitCode: 0,
          stack: [
            int(0),
            cell(owner),
            cell(master),
            { type: 'cell', cell: Cell.EMPTY },
          ],
        };
      if (account === master && method === 'get_sccp_config')
        return {
          exitCode: 0,
          stack: [
            cell(other),
            cell(verifier),
            int(BigInt(wrongAsset ? '0x' + 'ff'.repeat(32) : soraAssetId)),
            int(9),
            int(0),
            int(0),
          ],
        };
      if (account === master && method === 'get_sccp_burn_record') {
        const arg = args![0];
        assert.equal(arg.type, 'int');
        const record = f.input
          .sccpMasters!.get(master)!
          .burns.get(
            '0x' +
              (arg.type === 'int' ? arg.value : 0n)
                .toString(16)
                .padStart(64, '0'),
          );
        return {
          exitCode: 0,
          stack: record
            ? [{ type: 'cell', cell: Cell.fromBase64(record.boc) }]
            : [{ type: 'null' }],
        };
      }
      return null;
    },
  };
  try {
    await store.initialize();
    const service = new LedgerService(
      'testnet',
      store,
      source,
      loadOpcodes(),
      createLogger('silent'),
      2,
      { sccpAssets: [binding] },
    );
    await service.syncAccount(owner);
    let p = await store.page('testnet', owner);
    assert.equal(p.coverage.historyComplete, false);
    assert(
      !p.events.some(
        (e) => e.kind === 'bridge_mint' && e.settlement?.status === 'confirmed',
      ),
    );
    incomplete = false;
    await service.syncAccount(owner);
    p = await store.page('testnet', owner);
    assert.equal(p.coverage.historyComplete, true, JSON.stringify(p.coverage));
    assert.equal(
      p.coverage.decodingComplete,
      false,
      'remote receipts remain explicitly unverified',
    );
    assert.equal(
      p.events.filter(
        (e) =>
          e.settlement?.protocol === 'sccp' &&
          e.settlement.status === 'confirmed',
      ).length,
      2,
      JSON.stringify(p.events),
    );
    const generation = p.coverage.generation;
    await service.syncAccount(owner);
    assert.equal(
      (await store.page('testnet', owner)).coverage.generation,
      generation,
      'identical journal getter checks reuse published history',
    );
    wrongAsset = true;
    await service.syncAccount(owner);
    p = await store.page('testnet', owner);
    assert(
      !p.events.some(
        (e) =>
          e.settlement?.protocol === 'sccp' &&
          e.settlement.status === 'confirmed',
      ),
    );
    assert(p.coverage.issues.includes('sccp_master_identity_unresolved'));
    await service.stop();
  } finally {
    await pool.end();
  }
}
async function main() {
  assert.deepEqual(
    parseLedgerSccpBindings(
      JSON.stringify([{ ...binding, network: 'testnet' }]),
      'testnet',
    ),
    [binding],
  );
  for (const value of [
    { ...binding, network: 'mainnet' },
    { ...binding, network: 'testnet', masterCodeHash: 'bad' },
    { ...binding, network: 'testnet', verifierCodeHash: undefined },
  ])
    assert.throws(() =>
      parseLedgerSccpBindings(JSON.stringify([value]), 'testnet'),
    );
  await numerical();
  await database();
  console.log(
    'SCCP exact local burn/mint, message identity, replay, remote gap and durable coverage tests passed',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
