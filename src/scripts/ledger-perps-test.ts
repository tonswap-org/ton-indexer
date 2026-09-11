import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PostgresLedgerStore, type LedgerSqlPool } from "../ledger/store";
import { LedgerService } from "../ledger/service";
import { createLogger } from "../utils/logger";
import { canonicalLedgerHash } from "../ledger/normalize";
import type { TonDataSource } from "../data/dataSource";
import { Address, Cell, Dictionary, beginCell } from "@ton/core";
import { createHash } from "node:crypto";
import { perpsEconomics, tvmDiv } from "../ledger/perpsEconomics";
import {
  emptyPerpsAccount,
  readPerpsState,
  type PerpsState,
  type PerpsPosition,
} from "../ledger/perpsState";
import * as w from "../ledger/perpsWire";
import { parseLedgerPerpsCodeHash } from "../config/ledgerPerps";
import {
  projectOwnerLedger,
  type ProjectionInput,
  type LedgerChain,
} from "../ledger/project";
import { loadOpcodes } from "../utils/opcodes";
import {
  TRANSFER,
  INTERNAL,
  NOTIFY,
  SETTLEMENT_INTERNAL,
} from "../ledger/wire";
import type { RawMessage, RawTransaction } from "../data/dataSource";
const address = (n: number) => `0:${n.toString(16).padStart(64, "0")}`,
  A = (v: string) => Address.parse(v);
const owner = address(401),
  engine = address(402),
  root = address(403),
  pool = address(404),
  other = address(405),
  code = beginCell().storeUint(42, 32).endCell(),
  walletCode = beginCell().storeUint(43, 32).endCell(),
  ownerWallet = w.perpsWalletAddress(walletCode, root, owner),
  engineWallet = w.perpsWalletAddress(walletCode, root, engine),
  query = "9007199254741233";
const raw = {
  serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
  parse: (s: any) => s.asCell(),
};
const base = (): PerpsState => ({
  root,
  walletCode,
  feeBps: 25,
  feeTreasury: null,
  router: null,
  riskVault: null,
  configHash: "",
  dataHash: "",
  accounts: new Map([[owner, emptyPerpsAccount()]]),
  positions: new Map(),
  pending: new Map(),
  markets: new Map([
    [
      1,
      {
        pool,
        depthRaw: (2n ** 90n).toString(),
        alphaRaw: "0",
        betaRaw: "0",
        fundingIndexRaw: "0",
        markRaw: "1000000000",
        controlFeeDeltaBps: 0,
        clampBps: 100,
        adlDeficitRaw: "0",
      },
    ],
  ]),
});
const clone = (s: PerpsState): PerpsState => ({
  ...s,
  accounts: new Map([...s.accounts].map(([k, v]) => [k, { ...v }])),
  positions: new Map([...s.positions].map(([k, v]) => [k, { ...v }])),
  pending: new Map([...s.pending].map(([k, v]) => [k, { ...v }])),
  markets: new Map([...s.markets].map(([k, v]) => [k, { ...v }])),
});
const setPosition = (s: PerpsState, v: PerpsPosition) =>
  s.positions.set(w.perpsPositionKey(v.owner, v.marketId), v);
function encode(s: PerpsState) {
  // Source layout: perps_engine.tolk pack_registry_config, pack_map_bundle,
  // market_to_persisted and pack_queue_bundle. Big integers stay exact.
  const cfg = beginCell()
    .storeAddress(null)
    .storeAddress(null)
    .storeAddress(null)
    .storeAddress(null)
    .storeUint(s.feeBps, 32)
    .storeUint(3600, 64)
    .storeUint(0, 32)
    .storeUint(0, 32)
    .storeRef(
      beginCell()
        .storeAddress(null)
        .storeAddress(null)
        .storeAddress(null)
        .storeRef(
          beginCell()
            .storeUint(128, 8)
            .storeRef(
              beginCell().storeAddress(A(s.root)).storeRef(s.walletCode),
            ),
        )
        .endCell(),
    )
    .storeRef(Cell.EMPTY)
    .storeRef(Cell.EMPTY)
    .storeRef(Cell.EMPTY)
    .storeUint(1, 32)
    .endCell();
  const accounts = Dictionary.empty(Dictionary.Keys.Address(), raw);
  for (const [a, v] of s.accounts)
    accounts.set(
      A(a),
      beginCell()
        .storeCoins(BigInt(v.collateralRaw))
        .storeInt(BigInt(v.pendingFundingRaw), 128)
        .storeUint(v.crossMargin, 8)
        .storeUint(v.referralLinked, 8)
        .storeUint(v.openPositionCount, 32)
        .endCell(),
    );
  const positions = Dictionary.empty(Dictionary.Keys.BigUint(256), raw);
  for (const [k, v] of s.positions)
    positions.set(
      BigInt("0x" + k),
      beginCell()
        .storeAddress(A(v.owner))
        .storeUint(v.marketId, 32)
        .storeInt(BigInt(v.sizeRaw), 128)
        .storeCoins(BigInt(v.marginRaw))
        .storeCoins(BigInt(v.entryNotionalRaw))
        .storeInt(BigInt(v.lastFundingIndexRaw), 128)
        .storeUint(v.flags, 32)
        .endCell(),
    );
  const markets = Dictionary.empty(Dictionary.Keys.Uint(32), raw);
  for (const [id, v] of s.markets) {
    const p = beginCell()
      .storeCoins(BigInt(v.depthRaw))
      .storeInt(BigInt(v.alphaRaw), 128)
      .storeInt(BigInt(v.betaRaw), 128)
      .storeUint(100000, 32)
      .storeUint(500, 32)
      .storeCoins(2n ** 100n)
      .storeUint(10000, 32)
      .storeCoins(1)
      .storeUint(0, 64)
      .storeUint(10000, 32)
      .storeUint(0, 8)
      .storeRef(Cell.EMPTY)
      .endCell();
    const extra = beginCell()
      .storeUint(0, 128)
      .storeUint(0, 64)
      .storeUint(0, 96)
      .storeUint(0, 64)
      .storeUint(0, 64)
      .storeInt(v.controlFeeDeltaBps, 32)
      .storeUint(v.clampBps, 32)
      .storeUint(0, 65)
      .storeCoins(0)
      .storeCoins(0)
      .storeCoins(0)
      .storeUint(0, 64)
      .storeCoins(0)
      .storeRef(
        beginCell()
          .storeUint(0, 256)
          .storeUint(0, 256)
          .storeUint(0, 64)
          .storeUint(0, 256),
      )
      .endCell();
    const stats = beginCell()
      .storeInt(BigInt(v.fundingIndexRaw), 128)
      .storeUint(0, 64)
      .storeCoins(0)
      .storeCoins(0)
      .storeUint(0, 1)
      .storeCoins(0)
      .storeUint(0, 64)
      .storeCoins(BigInt(v.markRaw))
      .storeUint(0, 64)
      .storeCoins(BigInt(v.adlDeficitRaw))
      .storeUint(0, 32)
      .storeCoins(0)
      .storeCoins(0)
      .storeRef(extra)
      .endCell();
    markets.set(
      id,
      beginCell().storeAddress(A(v.pool)).storeRef(p).storeRef(stats).endCell(),
    );
  }
  const pending = Dictionary.empty(Dictionary.Keys.BigUint(256), raw);
  for (const [key, v] of s.pending)
    pending.set(
      BigInt("0x" + key),
      beginCell()
        .storeUint(v.kind, 8)
        .storeAddress(v.owner ? A(v.owner) : null)
        .storeUint(v.marketId, 32)
        .storeUint(BigInt(v.wireId), 64)
        .storeCoins(BigInt(v.amountRaw))
        .storeCoins(BigInt(v.queuedRaw))
        .storeInt(BigInt(v.recordedAt), 64)
        .endCell(),
    );
  return beginCell()
    .storeRef(
      beginCell().storeRef(Cell.EMPTY).storeRef(cfg).storeRef(Cell.EMPTY),
    )
    .storeRef(
      beginCell()
        .storeRef(beginCell().storeDict(markets))
        .storeRef(beginCell().storeDict(accounts))
        .storeRef(beginCell().storeDict(positions)),
    )
    .storeUint(0, 32 + 64 + 32 + 32 + 32 + 64 + 32 + 32 + 32 + 64 + 32)
    .storeAddress(null)
    .storeUint(0, 96)
    .storeRef(
      beginCell()
        .storeRef(Cell.EMPTY)
        .storeRef(Cell.EMPTY)
        .storeRef(beginCell().storeDict(pending))
        .storeRef(Cell.EMPTY),
    )
    .storeRef(Cell.EMPTY)
    .endCell();
}
function request(r: w.PerpsRequest) {
  let b = beginCell().storeUint(r.opcode, 32);
  if (r.operation === "adl")
    return b
      .storeUint(r.marketId, 32)
      .storeAddress(A(r.owner!))
      .storeInt(BigInt(r.sizeRaw!), 128)
      .storeUint(BigInt(r.queryId), 64)
      .endCell();
  b.storeUint(BigInt(r.queryId), 64).storeUint(r.marketId, 32);
  if (r.operation === "open")
    b.storeInt(BigInt(r.sizeRaw!), 128)
      .storeCoins(BigInt(r.marginRaw!))
      .storeCoins(0)
      .storeUint(10000, 32)
      .storeAddress(null);
  if (r.operation === "modify")
    b.storeInt(BigInt(r.sizeRaw!), 128)
      .storeInt(BigInt(r.marginRaw!), 128)
      .storeCoins(0)
      .storeUint(0, 32);
  if (r.operation === "close")
    b.storeInt(BigInt(r.sizeRaw!), 128).storeCoins(0);
  if (["add_margin", "remove_margin"].includes(r.operation))
    b.storeCoins(BigInt(r.marginRaw!));
  if (r.operation === "liquidation")
    b.storeAddress(A(r.owner!)).storeCoins(BigInt(r.sizeRaw!));
  return b.endCell();
}
const pending = (s: PerpsState, amount: bigint, kind = 3, wire = "71") =>
  s.pending.set(w.perpsTransferKey(ownerWallet), {
    kind,
    owner,
    marketId: 1,
    wireId: wire,
    amountRaw: amount.toString(),
    queuedRaw: "0",
    recordedAt: "1700000000",
  });
function open() {
  const b = base(),
    a = clone(b),
    size = 2n ** 70n + 17n,
    margin = 2n ** 65n + 23n,
    fee = (size * 25n) / 10000n,
    excess = 113n,
    r: w.PerpsRequest = {
      opcode: w.PERPS_OPEN,
      operation: "open",
      queryId: query,
      marketId: 1,
      sizeRaw: size.toString(),
      marginRaw: margin.toString(),
      limitPriceRaw: "0",
      leverageBps: 10000,
      referrer: null,
    };
  a.accounts.get(owner)!.collateralRaw = margin.toString();
  a.accounts.get(owner)!.openPositionCount = 1;
  setPosition(a, {
    owner,
    marketId: 1,
    sizeRaw: size.toString(),
    marginRaw: margin.toString(),
    entryNotionalRaw: size.toString(),
    lastFundingIndexRaw: "0",
    flags: 0,
  });
  pending(a, excess);
  return { b, a, r, deposit: margin + fee + excess, fee, excess };
}
function fixture(
  b: PerpsState,
  a: PerpsState,
  r: w.PerpsRequest,
  deposit: bigint,
) {
  let lt = 100;
  const chains = new Map<string, LedgerChain>(
    [owner, engine, ownerWallet, engineWallet].map((account) => [
      account,
      {
        account,
        generation: "g",
        historyComplete: true,
        role:
          account === owner
            ? "owner"
            : account === ownerWallet
              ? "owned_jetton_wallet"
              : "counterparty",
        transactions: [],
      },
    ]),
  );
  const asset = (wallet: string, o: string) => ({
    kind: "jetton" as const,
    id: `localnet:jetton:${root}`,
    master: root,
    wallet,
    owner: o,
    decimals: 9,
  });
  const states = new Map<string, Cell>();
  const input: ProjectionInput = {
    network: "localnet",
    owner,
    chains,
    wallets: new Map([
      [ownerWallet, asset(ownerWallet, owner)],
      [engineWallet, asset(engineWallet, engine)],
    ]),
    pools: new Map(),
    opcodes: loadOpcodes(),
    perpsEngines: new Map([
      [
        engine,
        {
          address: engine,
          root,
          codeHash: code.hash().toString("hex"),
          walletCodeHash: walletCode.hash().toString("hex"),
          ownerWallet,
          engineWallet,
        },
      ],
    ]),
    stateAt: async (_a, lt) =>
      states.has(lt)
        ? ({
            seqno: Number(lt),
            state: {
              accountState: "active",
              codeBoc: code.toBoc().toString("base64"),
              dataBoc: states.get(lt)!.toBoc().toString("base64"),
              balance: "0",
              lastTransactionLt: lt,
              lastTransactionHash: "00".repeat(32),
            },
          } as any)
        : null,
  };
  const msg = (src: string, dest: string, c: Cell): RawMessage => ({
    source: src,
    destination: dest,
    body: c.toBoc().toString("base64"),
    createdLt: String(++lt),
    value: "100",
    forwardFeeRaw: "3",
    ihrFeeRaw: "0",
    bounced: false,
  });
  const tx = (account: string, im?: RawMessage, outs: RawMessage[] = []) => {
    const list = chains.get(account)!.transactions,
      prev = list.at(-1),
      n: RawTransaction = {
        lt: String(++lt),
        hash: createHash("sha256").update(String(lt)).digest("base64"),
        prevTransactionLt: prev?.lt ?? "0",
        prevTransactionHash: prev?.hash ?? Buffer.alloc(32).toString("base64"),
        utime: 1700000000 + lt,
        success: true,
        status: "success",
        totalFeesRaw: "7",
        inMessage: im,
        outMessages: outs,
      };
    list.push(n);
    return n;
  };
  const initial = tx(engine);
  states.set(initial.lt, encode(b));
  const req = request(r);
  let im: RawMessage;
  const ns: RawTransaction[] = [];
  if (deposit) {
    const fundQuery = BigInt(query) + 1n;
    const transfer = msg(
      owner,
      ownerWallet,
      beginCell()
        .storeUint(TRANSFER, 32)
        .storeUint(fundQuery, 64)
        .storeCoins(deposit)
        .storeAddress(A(engine))
        .storeAddress(A(owner))
        .storeRef(Cell.EMPTY)
        .storeCoins(1)
        .storeRef(req)
        .endCell(),
    );
    tx(owner, undefined, [transfer]);
    const internal = msg(
      ownerWallet,
      engineWallet,
      beginCell()
        .storeUint(INTERNAL, 32)
        .storeUint(fundQuery, 64)
        .storeCoins(deposit)
        .storeAddress(A(owner))
        .storeAddress(A(owner))
        .storeCoins(1)
        .storeRef(req)
        .endCell(),
    );
    ns.push(tx(ownerWallet, transfer, [internal]));
    im = msg(
      engineWallet,
      engine,
      beginCell()
        .storeUint(NOTIFY, 32)
        .storeUint(fundQuery, 64)
        .storeCoins(deposit)
        .storeAddress(A(owner))
        .storeAddress(A(ownerWallet))
        .storeCoins(1)
        .storeRef(req)
        .endCell(),
    );
    ns.push(tx(engineWallet, internal, [im]));
  } else {
    im = msg(r.owner ? other : owner, engine, req);
    if (!r.owner) tx(owner, undefined, [im]);
  }
  const n = tx(engine, im);
  states.set("0", encode(b));
  states.set(n.lt, encode(a));
  const finishPayout = (amount: bigint, wire = "71", dispatch = n) => {
    const transfer = msg(
      engine,
      engineWallet,
      beginCell()
        .storeUint(TRANSFER, 32)
        .storeUint(BigInt(wire), 64)
        .storeCoins(amount)
        .storeAddress(A(owner))
        .storeAddress(A(engine))
        .storeRef(beginCell().storeUint(0x4a535454, 32))
        .storeCoins(0)
        .storeRef(Cell.EMPTY)
        .endCell(),
    );
    dispatch.outMessages.push(transfer);
    const internal = msg(
      engineWallet,
      ownerWallet,
      beginCell()
        .storeUint(SETTLEMENT_INTERNAL, 32)
        .storeUint(BigInt(wire), 64)
        .storeCoins(amount)
        .storeAddress(A(engine))
        .storeAddress(A(engineWallet))
        .storeCoins(0)
        .storeRef(Cell.EMPTY)
        .endCell(),
    );
    tx(engineWallet, transfer, [internal]);
    const control = (src: string, dst: string, op: number) =>
      msg(
        src,
        dst,
        beginCell()
          .storeUint(op, 32)
          .storeUint(BigInt(wire), 64)
          .storeCoins(amount)
          .storeAddress(A(ownerWallet))
          .endCell(),
      );
    const ack = control(ownerWallet, engineWallet, 0x4a534143);
    const credit = tx(ownerWallet, internal, [ack]);
    const success = control(engineWallet, engine, 0x4a535543);
    tx(engineWallet, ack, [success]);
    const finalize = control(engine, engineWallet, 0x4a53464e);
    const successTx = tx(engine, success, [finalize]);
    const finalized = control(engineWallet, engine, 0x4a53464b);
    tx(engineWallet, finalize, [finalized]);
    const finalTx = tx(engine, finalized);
    const terminal = clone(a);
    pending(terminal, amount, 12, wire);
    const cleared = clone(terminal);
    cleared.pending.clear();
    states.set(successTx.lt, encode(terminal));
    states.set(finalTx.lt, encode(cleared));
    return { credit, finalTx };
  };
  const dispatchReady = (amount: bigint, wire = "71") => {
    const im = msg(
      owner,
      engine,
      request({
        opcode: w.PERPS_CLAIM,
        operation: "claim",
        queryId: "77",
        marketId: 1,
      }),
    );
    tx(owner, undefined, [im]);
    const dispatch = tx(engine, im);
    const assigned = clone(a);
    pending(assigned, amount, 3, wire);
    states.set(dispatch.lt, encode(assigned));
    return dispatch;
  };
  return { input, n, ns, chains, states, finishPayout, dispatchReady };
}
async function database() {
  const o = open(),
    f = fixture(o.b, o.a, o.r, o.deposit);
  f.finishPayout(o.excess);
  const db = new PGlite(),
    sql: LedgerSqlPool = {
      query: async (q, p) =>
        !p && q.includes(";")
          ? { rows: (await db.exec(q)).at(-1)?.rows ?? [] }
          : db.query(q, p),
      connect: async () => sql,
      end: () => db.close(),
    },
    store = new PostgresLedgerStore(sql);
  let partial = true,
    wrong = false;
  const source: TonDataSource = {
    network: "localnet",
    getMasterchainInfo: async () => ({ seqno: 1000 }),
    getAccountState: async (a) => {
      const head = f.chains.get(a)?.transactions.at(-1);
      return {
        accountState: "active",
        balance: "0",
        lastTxLt: head?.lt,
        lastTxHash: head?.hash,
        codeBoc: (a === engine ? (wrong ? Cell.EMPTY : code) : walletCode)
          .toBoc()
          .toString("base64"),
        dataBoc:
          a === engine
            ? f.states.get(head!.lt)!.toBoc().toString("base64")
            : undefined,
      };
    },
    getTransactions: async (a, limit, lt) =>
      partial && a === engineWallet
        ? []
        : (f.chains.get(a)?.transactions ?? [])
            .filter((t) => !lt || BigInt(t.lt) <= BigInt(lt))
            .slice()
            .reverse()
            .slice(0, limit),
    getJettonMetadata: async () => ({ decimals: 9 }),
    getJettonBalance: async (o, r) => {
      const a = [...f.input.wallets.values()].find(
        (a) => a.owner === o && a.master === r,
      );
      return a ? { wallet: a.wallet!, balance: "0" } : null;
    },
    runGetMethod: async (a, m) => {
      const v = f.input.wallets.get(a);
      return v && m === "get_wallet_data"
        ? {
            exitCode: 0,
            stack: [
              { type: "int", value: 0n },
              {
                type: "slice",
                cell: beginCell().storeAddress(A(v.owner!)).endCell(),
              },
              {
                type: "slice",
                cell: beginCell().storeAddress(A(v.master!)).endCell(),
              },
              { type: "cell", cell: walletCode },
            ],
          }
        : null;
    },
    close: async () => {},
  };
  const service = new LedgerService(
    "localnet",
    store,
    source,
    loadOpcodes(),
    createLogger("silent"),
    2,
    {
      t3Root: root,
      perpsEngine: engine,
      perpsEngineCodeHash: code.hash().toString("hex"),
      maxPagesPerSync: 100,
    },
  );
  try {
    await store.initialize();
    for (const t of f.chains.get(engine)!.transactions) {
      const data = f.states.get(t.lt);
      if (data)
        await sql.query(
          "INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)",
          [
            "localnet",
            engine,
            t.lt,
            canonicalLedgerHash(t.hash),
            JSON.stringify({
              seqno: Number(t.lt),
              state: {
                accountState: "active",
                balance: "0",
                lastTxLt: t.lt,
                lastTxHash: t.hash,
                codeBoc: code.toBoc().toString("base64"),
                dataBoc: data.toBoc().toString("base64"),
              },
            }),
          ],
        );
    }
    await service.syncAccount(owner);
    let page = await store.page("localnet", owner);
    assert.equal(page.coverage.historyComplete, false);
    assert(
      !page.events.some(
        (e) =>
          e.kind === "perps_operation" && e.settlement?.status === "confirmed",
      ),
    );
    partial = false;
    await service.syncAccount(owner);
    page = await store.page("localnet", owner);
    assert.equal(
      page.coverage.historyComplete,
      true,
      JSON.stringify(page.coverage),
    );
    assert(
      page.events.some(
        (e) =>
          e.kind === "perps_operation" &&
          e.settlement?.perps?.outcome === "accepted",
      ),
      JSON.stringify(page),
    );
    assert(page.coverage.relatedAccounts?.some((a) => a.account === engine));
    const generation = page.coverage.generation;
    await service.syncAccount(owner);
    assert.equal(
      (await store.page("localnet", owner)).coverage.generation,
      generation,
      "unchanged engine dependency must reuse snapshot",
    );
    wrong = true;
    await service.syncAccount(owner);
    page = await store.page("localnet", owner);
    assert(
      page.coverage.issues.includes(
        "perps_engine_or_custody_identity_unverified",
      ),
    );
    assert(
      !page.events.some(
        (e) =>
          e.kind === "perps_operation" && e.settlement?.status === "confirmed",
      ),
    );
  } finally {
    await service.stop();
    await sql.end();
  }
}
async function main() {
  assert.equal(tvmDiv(-101n, 100n), -2n);
  assert.equal(parseLedgerPerpsCodeHash(" "), undefined);
  for (const bad of [
    "0x" + "a".repeat(64),
    "A".repeat(64),
    "a".repeat(63),
    " " + "a".repeat(64),
  ])
    assert.throws(() => parseLedgerPerpsCodeHash(bad));
  assert.equal(parseLedgerPerpsCodeHash("a".repeat(64)), "a".repeat(64));
  const o = open(),
    round = readPerpsState(encode(o.a).toBoc().toString("base64"));
  assert.deepEqual(round.accounts, o.a.accounts);
  assert.deepEqual(round.positions, o.a.positions);
  assert.deepEqual(round.markets, o.a.markets);
  assert.deepEqual(round.pending, o.a.pending);
  assert.equal(round.root, root);
  assert.deepEqual(w.perpsRequest(request(o.r)), o.r);
  const economics = perpsEconomics(
    o.b,
    o.a,
    owner,
    ownerWallet,
    o.r,
    o.deposit.toString(),
  )!;
  assert.equal(economics.tradeFeeRaw, o.fee.toString());
  assert.equal(economics.payoutContributionRaw, "113");
  assert.equal(
    BigInt(economics.depositCollateralRaw) +
      BigInt(economics.tradeFeeRaw) +
      BigInt(economics.excessRaw),
    o.deposit,
  );
  const f = fixture(o.b, o.a, o.r, o.deposit);
  f.finishPayout(o.excess);
  const result = (await projectOwnerLedger(f.input)).events,
    event = result.find((e) => e.kind === "perps_operation")!;
  assert.equal(event.settlement?.status, "confirmed", JSON.stringify(result));
  assert.equal(event.settlement!.perps!.payout.status, "completed");
  assert.equal(
    event.settlement!.perps!.fundingQueryId,
    (BigInt(query) + 1n).toString(),
  );
  assert.equal(event.settlement!.perps!.queryId, query);
  assert.equal(
    event.movements
      .filter((m) => m.asset.kind === "jetton" && m.direction === "in")
      .reduce((s, m) => s + BigInt(m.amountRaw), 0n),
    113n,
  );
  assert.equal(
    event.movements.filter(
      (m) =>
        m.asset.kind === "perps_balance" &&
        m.asset.balanceType === "collateral",
    ).length,
    1,
  );
  assert.equal(event.totalFeesRaw, "21");
  assert.equal(
    event.movements.find((m) => m.purpose === "perps_payout")?.evidence.kind,
    "perps_payout",
  );
  assert.deepEqual((await projectOwnerLedger(f.input)).events, result);
  assert.equal(
    event.movements
      .filter(
        (m) =>
          m.asset.kind === "jetton" &&
          (m.direction === "out" || m.direction === "fee"),
      )
      .reduce((sum, m) => sum + BigInt(m.amountRaw), 0n),
    o.deposit,
  );
  assert.equal(
    event.movements.find((m) => m.purpose === "protocol_fee")?.amountRaw,
    o.fee.toString(),
  );

  const unavailable = fixture(o.b, o.a, o.r, o.deposit);
  unavailable.input.stateAt = async () => null;
  assert.equal(
    (await projectOwnerLedger(unavailable.input)).events.find(
      (e) => e.kind === "perps_operation",
    )!.settlement?.status,
    "incomplete",
  );
  const partial = fixture(o.b, o.a, o.r, o.deposit);
  partial.chains.get(engineWallet)!.historyComplete = false;
  assert.equal(
    (await projectOwnerLedger(partial.input)).events.find(
      (e) => e.kind === "perps_operation",
    )!.settlement?.status,
    "incomplete",
  );
  const wrong = fixture(o.b, o.a, o.r, o.deposit);
  wrong.input.perpsEngines!.get(engine)!.codeHash = "00".repeat(32);
  assert.equal(
    (await projectOwnerLedger(wrong.input)).events.find(
      (e) => e.kind === "perps_operation",
    )!.settlement?.status,
    "incomplete",
  );
  const broken = clone(o.a);
  broken.accounts.get(owner)!.collateralRaw = (
    BigInt(o.r.marginRaw!) + 1n
  ).toString();
  assert.equal(
    perpsEconomics(o.b, broken, owner, ownerWallet, o.r, o.deposit.toString()),
    null,
  );
  const rejected = clone(o.b);
  pending(rejected, o.deposit);
  const refund = fixture(o.b, rejected, o.r, o.deposit);
  refund.finishPayout(o.deposit);
  const rejectedEvent = (await projectOwnerLedger(refund.input)).events.find(
    (e) => e.kind === "perps_operation",
  )!;
  assert.equal(rejectedEvent.settlement?.perps?.outcome, "rejected");
  assert.equal(rejectedEvent.settlement?.perps?.payout.status, "completed");
  assert(
    !rejectedEvent.movements.some((m) => m.asset.balanceType === "collateral"),
  );
  const closeBefore = clone(o.a);
  closeBefore.pending.clear();
  closeBefore.markets.get(1)!.markRaw = "1100000000";
  closeBefore.markets.get(1)!.fundingIndexRaw = "1";
  const position = closeBefore.positions.values().next().value!,
    size = BigInt(position.sizeRaw),
    funding = tvmDiv(-size, 10000n),
    pnl = tvmDiv(size * 100000000n, 1000000000n),
    notional = tvmDiv(size * 1100000000n, 1000000000n),
    fee = (notional * 25n) / 10000n,
    total = BigInt(o.r.marginRaw!) + funding + pnl - fee,
    closeAfter = clone(closeBefore);
  closeAfter.positions.clear();
  closeAfter.accounts.get(owner)!.collateralRaw = "0";
  closeAfter.accounts.get(owner)!.openPositionCount = 0;
  pending(closeAfter, total);
  const close: w.PerpsRequest = {
    opcode: w.PERPS_CLOSE,
    operation: "close",
    marketId: 1,
    queryId: query,
    sizeRaw: "1",
    limitPriceRaw: "0",
  };
  const ce = perpsEconomics(
    closeBefore,
    closeAfter,
    owner,
    ownerWallet,
    close,
    "0",
  )!;
  assert.equal(ce.fundingRaw, funding.toString());
  assert.equal(ce.realizedPnlRaw, pnl.toString());
  assert.equal(ce.payoutContributionRaw, total.toString());
  const cf = fixture(closeBefore, closeAfter, close, 0n);
  cf.finishPayout(total);
  assert.equal(
    (await projectOwnerLedger(cf.input)).events.find(
      (e) => e.kind === "perps_operation",
    )!.settlement?.perps?.payout.status,
    "completed",
  );
  const closeEvent = (await projectOwnerLedger(cf.input)).events.find(
    (e) => e.kind === "perps_operation",
  )!;
  assert.equal(
    closeEvent.movements
      .filter(
        (m) =>
          m.asset.kind === "perps_balance" &&
          m.asset.balanceType === "collateral",
      )
      .reduce(
        (sum, m) =>
          sum + (m.direction === "in" ? 1n : -1n) * BigInt(m.amountRaw),
        0n,
      ),
    -BigInt(o.r.marginRaw!),
  );
  assert.equal(
    closeEvent.movements.find((m) => m.purpose === "protocol_fee")?.amountRaw,
    fee.toString(),
  );
  const retry = clone(closeAfter),
    retryRequest: w.PerpsRequest = {
      opcode: w.PERPS_CLAIM,
      operation: "claim",
      marketId: 1,
      queryId: "72",
    };
  assert.equal(
    perpsEconomics(closeAfter, retry, owner, ownerWallet, retryRequest, "0")
      ?.outcome,
    "retry",
  );

  const readyAfter = clone(o.a);
  pending(readyAfter, o.excess, 2, "0");
  const ready = fixture(o.b, readyAfter, o.r, o.deposit),
    dispatch = ready.dispatchReady(o.excess);
  ready.finishPayout(o.excess, "71", dispatch);
  const readyEvents = (await projectOwnerLedger(ready.input)).events.filter(
    (e) => e.kind === "perps_operation",
  );
  assert.equal(readyEvents.length, 1);
  assert.equal(readyEvents[0].settlement?.perps?.payout.status, "completed");
  assert.equal(readyEvents[0].settlement?.perps?.queryId, query);
  assert.equal(readyEvents[0].settlement?.perps?.payout.wireId, "71");
  // Wrong terminal counterparty and failed delivery never turn a journal into receipt.
  const wrongReceipt = fixture(o.b, o.a, o.r, o.deposit),
    wrongTerminal = wrongReceipt.finishPayout(o.excess);
  wrongTerminal.finalTx.inMessage!.body = beginCell()
    .storeUint(0x4a53464b, 32)
    .storeUint(71, 64)
    .storeCoins(o.excess)
    .storeAddress(A(other))
    .endCell()
    .toBoc()
    .toString("base64");
  assert.equal(
    (await projectOwnerLedger(wrongReceipt.input)).events.find(
      (e) => e.kind === "perps_operation",
    )!.settlement?.perps?.payout.status,
    "pending",
  );
  const bounced = fixture(o.b, o.a, o.r, o.deposit),
    bounce = bounced.finishPayout(o.excess);
  bounce.credit.success = false;
  bounce.credit.status = "failed";
  const bounceEvent = (await projectOwnerLedger(bounced.input)).events.find(
    (e) => e.kind === "perps_operation",
  )!;
  assert.equal(bounceEvent.settlement?.perps?.payout.status, "pending");
  assert(
    !bounceEvent.movements.some(
      (m) => m.asset.kind === "jetton" && m.direction === "in",
    ),
  );
  const wrongOwner = clone(o.a);
  wrongOwner.pending.values().next().value!.owner = other;
  assert.equal(
    perpsEconomics(
      o.b,
      wrongOwner,
      owner,
      ownerWallet,
      o.r,
      o.deposit.toString(),
    ),
    null,
  );
  const wrongPosition = clone(o.a);
  wrongPosition.positions.values().next().value!.owner = other;
  assert.throws(() =>
    readPerpsState(encode(wrongPosition).toBoc().toString("base64")),
  );
  const baseline = base(),
    balance = 1000000n,
    positionBase: PerpsPosition = {
      owner,
      marketId: 1,
      sizeRaw: "1000000000",
      marginRaw: balance.toString(),
      entryNotionalRaw: "1000000000",
      lastFundingIndexRaw: "0",
      flags: 0,
    };
  baseline.accounts.set(owner, {
    ...emptyPerpsAccount(),
    collateralRaw: balance.toString(),
    openPositionCount: 1,
  });
  setPosition(baseline, positionBase);
  for (const [operation, opcode, delta, deposit] of [
    ["add_margin", w.PERPS_ADD_MARGIN, 10000n, 10003n],
    ["remove_margin", w.PERPS_REMOVE_MARGIN, -10000n, 0n],
  ] as const) {
    const after = clone(baseline);
    after.accounts.get(owner)!.collateralRaw = (balance + delta).toString();
    after.positions.values().next().value!.marginRaw = (
      balance + delta
    ).toString();
    pending(after, delta > 0n ? 3n : -delta);
    const r: w.PerpsRequest = {
      opcode,
      operation,
      queryId: query,
      marketId: 1,
      marginRaw: (delta < 0n ? -delta : delta).toString(),
    };
    assert.equal(
      perpsEconomics(baseline, after, owner, ownerWallet, r, deposit.toString())
        ?.outcome,
      "accepted",
    );
    assert.equal(
      (await projectOwnerLedger(fixture(baseline, after, r, deposit).input)).events.find((e) => e.kind === "perps_operation")!.settlement?.status,
      "confirmed",
    );
  }
  const claimBefore = clone(baseline);
  claimBefore.markets.get(1)!.fundingIndexRaw = "-1";
  claimBefore.accounts.get(owner)!.pendingFundingRaw = "7";
  const claimAfter = clone(claimBefore);
  claimAfter.accounts.get(owner)!.pendingFundingRaw = "0";
  claimAfter.positions.values().next().value!.lastFundingIndexRaw = "-1";
  pending(claimAfter, 100007n, 1);
  const claim: w.PerpsRequest = {
    opcode: w.PERPS_CLAIM,
    operation: "claim",
    queryId: query,
    marketId: 1,
  };
  const claimEconomics = perpsEconomics(
    claimBefore,
    claimAfter,
    owner,
    ownerWallet,
    claim,
    "0",
  )!;
  assert.equal(claimEconomics.fundingRaw, "100000");
  assert.equal(claimEconomics.payoutContributionRaw, "100007");
  const modifyAfter = clone(baseline),
    quarter = 250000000n,
    release = balance / 4n,
    modifyFee = (quarter * 25n) / 10000n;
  modifyAfter.accounts.get(owner)!.collateralRaw = (
    balance -
    release -
    modifyFee
  ).toString();
  modifyAfter.positions.values().next().value!.sizeRaw = "750000000";
  modifyAfter.positions.values().next().value!.entryNotionalRaw = "750000000";
  modifyAfter.positions.values().next().value!.marginRaw = (
    balance -
    release -
    modifyFee
  ).toString();
  pending(modifyAfter, release);
  const modify: w.PerpsRequest = {
    opcode: w.PERPS_MODIFY,
    operation: "modify",
    marketId: 1,
    queryId: query,
    sizeRaw: "-250000000",
    marginRaw: "0",
    flags: 0,
    limitPriceRaw: "0",
  };
  assert.equal(
    perpsEconomics(baseline, modifyAfter, owner, ownerWallet, modify, "0")
      ?.tradeFeeRaw,
    modifyFee.toString(),
  );
  const liquidBefore = clone(baseline);
  liquidBefore.markets.get(1)!.markRaw = "999000000";
  const liquidAfter = clone(liquidBefore);
  liquidAfter.accounts.get(owner)!.collateralRaw = "750000";
  liquidAfter.positions.values().next().value!.marginRaw = "750000";
  liquidAfter.positions.values().next().value!.sizeRaw = "750000000";
  liquidAfter.positions.values().next().value!.entryNotionalRaw = "750000000";
  const liquidation: w.PerpsRequest = {
    opcode: w.PERPS_LIQUIDATE,
    operation: "liquidation",
    owner,
    marketId: 1,
    queryId: query,
    sizeRaw: "250000000",
  };
  assert.equal(
    perpsEconomics(
      liquidBefore,
      liquidAfter,
      owner,
      ownerWallet,
      liquidation,
      "0",
    )?.realizedPnlRaw,
    "-250000",
  );
  const keeper = fixture(liquidBefore, liquidAfter, liquidation, 0n);
  assert.equal(
    (await projectOwnerLedger(keeper.input)).events.find(
      (e) => e.kind === "perps_operation",
    )!.totalFeesRaw,
    "0",
  );
  const adlBefore = clone(baseline);
  adlBefore.markets.get(1)!.markRaw = "1001000000";
  adlBefore.markets.get(1)!.adlDeficitRaw = "100000";
  const adlAfter = clone(adlBefore);
  adlAfter.markets.get(1)!.adlDeficitRaw = "0";
  adlAfter.accounts.get(owner)!.collateralRaw = "1150000";
  adlAfter.positions.values().next().value!.marginRaw = "750000";
  adlAfter.positions.values().next().value!.sizeRaw = "750000000";
  adlAfter.positions.values().next().value!.entryNotionalRaw = "750000000";
  const adl: w.PerpsRequest = {
    opcode: w.PERPS_ADL,
    operation: "adl",
    owner,
    marketId: 1,
    queryId: query,
    sizeRaw: "250000000",
  };
  assert.equal(
    perpsEconomics(adlBefore, adlAfter, owner, ownerWallet, adl, "0")
      ?.adlAbsorbedRaw,
    "100000",
  );
  assert.deepEqual(w.perpsRequest(request(adl)), adl);
  const replayedClaim = fixture(closeAfter, retry, retryRequest, 0n);
  const replayEvent = (await projectOwnerLedger(replayedClaim.input)).events.find(
    (e) => e.kind === "perps_operation",
  )!;
  assert.equal(replayEvent.settlement?.perps?.outcome, "retry");
  assert.equal(replayEvent.settlement?.perps?.economics?.fundingRaw, "0");
  assert(
    !replayEvent.movements.some(
      (m) => m.asset.kind === "perps_balance" || m.asset.kind === "jetton",
    ),
  );
  const aggregateBefore = clone(o.b);
  pending(aggregateBefore, 19n, 3, "70");
  const aggregateAfter = clone(o.a);
  pending(aggregateAfter, 19n, 3, "70");
  aggregateAfter.pending.values().next().value!.queuedRaw = o.excess.toString();
  const aggregateEvent = (await projectOwnerLedger(
      fixture(aggregateBefore, aggregateAfter, o.r, o.deposit).input,
    )).events.find((e) => e.kind === "perps_operation")!;
  assert.equal(aggregateEvent.settlement?.perps?.outcome, "accepted");
  assert.equal(
    aggregateEvent.settlement?.perps?.payout.status,
    "aggregate_unresolved",
  );
  assert(
    !aggregateEvent.movements.some((m) => m.asset.balanceType === "payout"),
  );
  await database();
  console.log(
    "Perps exact account, funding/PnL, typed payout/refund, precision, replay, identity and coverage fixtures passed.",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
