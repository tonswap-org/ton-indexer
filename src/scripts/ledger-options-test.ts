import assert from "node:assert/strict";
import { Address, Cell, Dictionary, beginCell } from "@ton/core";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PostgresLedgerStore, type LedgerSqlPool } from "../ledger/store";
import { LedgerService } from "../ledger/service";
import { createLogger } from "../utils/logger";
import type {
  RawMessage,
  RawTransaction,
  TonDataSource,
} from "../data/dataSource";
import {
  projectOwnerLedger,
  type ProjectionInput,
  type LedgerChain,
} from "../ledger/project";
import {
  optionPositionHash,
  optionBuyForward,
  optionSeriesBuy,
  OPTION_ACTIVATE,
  OPTION_ACTIVATE_ACK,
  OPTION_FACTORY_BUY,
  OPTION_BUY_SHOUT,
  OPTION_BUY_SPREAD,
} from "../ledger/options";
import { INTERNAL, NOTIFY, TRANSFER } from "../ledger/wire";
import { loadOpcodes } from "../utils/opcodes";
const addr = (n: number) => `0:${n.toString(16).padStart(64, "0")}`,
  A = (value: string) => Address.parse(value);
const buyer = addr(101),
  factory = addr(102),
  root = addr(103),
  buyerWallet = addr(104),
  factoryWallet = addr(105),
  series = addr(106),
  other = addr(107);
const factoryCode = beginCell().storeUint(123, 32).endCell();
const qualifiedCodes = {
  factoryCodeHash: factoryCode.hash().toString('hex'),
  vaultCodeHash: factoryCode.hash().toString('hex'),
  shoutCodeHash: factoryCode.hash().toString('hex'),
  outperformanceCodeHash: Cell.EMPTY.hash().toString('hex'),
  walletCodeHash: factoryCode.hash().toString('hex'),
};
const positionState = () => ({
  owner: buyer,
  notional: "10000",
  premium: "100",
  collateral: "1100",
  buyState: 525n,
  sourceWallet: factoryWallet,
  wireId: "55",
  custodyWireId: "56",
});
function factoryData(
  p: ReturnType<typeof positionState> | null,
  before = false,
) {
  const values = {
    serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
    parse: (s: any) => s.asCell(),
  };
  const dict = Dictionary.empty(Dictionary.Keys.BigUint(128), values);
  if (p)
    dict.set(
      (7n << 64n) | 3n,
      beginCell()
        .storeAddress(A(p.owner))
        .storeAddress(A(p.sourceWallet))
        .storeCoins(BigInt(p.notional))
        .storeCoins(BigInt(p.premium))
        .storeCoins(BigInt(p.collateral))
        .storeCoins(0)
        .storeBit(false)
        .storeBit(false)
        .storeUint(before ? 269n : p.buyState, 16)
        .storeRef(
          beginCell()
            .storeAddress(A(buyer))
            .storeUint(BigInt(p.wireId), 64)
            .storeUint(BigInt(p.custodyWireId), 64)
            .storeUint(0, 64)
            .storeCoins(20)
            .storeCoins(0)
            .storeCoins(0),
        )
        .endCell(),
    );
  return beginCell()
    .storeRef(Cell.EMPTY)
    .storeRef(Cell.EMPTY)
    .storeRef(beginCell().storeDict(dict))
    .endCell();
}
const hash = (n: number) =>
  createHash("sha256").update(String(n)).digest("base64");
const msg = (
  src: string,
  dest: string,
  lt: number,
  body: Cell,
): RawMessage => ({
  source: src,
  destination: dest,
  createdLt: String(lt),
  value: "100",
  forwardFeeRaw: "3",
  extraFlagsRaw: "0",
  bounced: false,
  body: body.toBoc().toString("base64"),
  op: body.beginParse().preloadUint(32),
});
function fixture(kind: 1 | 2 = 1) {
  const chains = new Map<string, LedgerChain>();
  for (const account of [buyer, buyerWallet, factoryWallet, factory, series])
    chains.set(account, {
      account,
      role:
        account === buyer
          ? "owner"
          : account === buyerWallet
            ? "owned_jetton_wallet"
            : "counterparty",
      generation: "fixture",
      historyComplete: true,
      transactions: [],
    });
  const asset = (wallet: string, owner: string) => ({
    kind: "jetton" as const,
    id: `testnet:jetton:${root}`,
    master: root,
    wallet,
    owner,
    decimals: 9,
  });
  const position = positionState();
  const input: ProjectionInput = {
    network: "testnet",
    owner: buyer,
    chains,
    wallets: new Map([
      [buyerWallet, asset(buyerWallet, buyer)],
      [factoryWallet, asset(factoryWallet, factory)],
    ]),
    pools: new Map(),
    opcodes: loadOpcodes(),
    stateAt: async (_account, lt) =>
      ["60", "80"].includes(lt)
        ? {
            seqno: Number(lt),
            state: {
              accountState: "active",
              balance: "0",
              lastTxLt: lt,
              lastTxHash: hash(Number(lt)),
              codeBoc: factoryCode.toBoc().toString("base64"),
              dataBoc: factoryData(position, lt === "60")
                .toBoc()
                .toString("base64"),
            },
          }
        : null,
    optionFactories: new Map([
      [
        factory,
        {
          address: factory,
          collateralRoot: root,
          series: new Map([["7", { address: series, kind }]]),
          codeHash: factoryCode.hash().toString("hex"),
          qualification: qualifiedCodes,
        },
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
      previous = list.at(-1);
    const raw: RawTransaction = {
      lt: String(lt),
      hash: hash(lt),
      prevTransactionLt: previous?.lt ?? "0",
      prevTransactionHash:
        previous?.hash ?? Buffer.alloc(32).toString("base64"),
      utime: 1700000000 + lt,
      success: true,
      status: "success",
      totalFeesRaw: "100",
      inMessage,
      outMessages,
    };
    list.push(raw);
    return raw;
  };
  const payload = beginCell()
    .storeUint(OPTION_FACTORY_BUY, 32)
    .storeUint(7, 64)
    .storeAddress(A(buyer))
    .storeCoins(10000)
    .storeCoins(120)
    .storeUint(10000, 32)
    .storeAddress(null)
    .endCell();
  const transfer = beginCell()
    .storeUint(TRANSFER, 32)
    .storeUint(1234, 64)
    .storeCoins(120)
    .storeAddress(A(factory))
    .storeAddress(A(buyer))
    .storeRef(Cell.EMPTY)
    .storeCoins(1)
    .storeRef(payload)
    .endCell();
  const internal = beginCell()
    .storeUint(INTERNAL, 32)
    .storeUint(1234, 64)
    .storeCoins(120)
    .storeAddress(A(buyer))
    .storeAddress(A(buyer))
    .storeCoins(1)
    .storeRef(payload)
    .endCell();
  const notification = beginCell()
    .storeUint(NOTIFY, 32)
    .storeUint(1234, 64)
    .storeCoins(120)
    .storeAddress(A(buyer))
    .storeAddress(A(buyerWallet))
    .storeCoins(1)
    .storeRef(payload)
    .endCell();
  const request = msg(buyer, buyerWallet, 11, transfer),
    hop = msg(buyerWallet, factoryWallet, 21, internal),
    notified = msg(factoryWallet, factory, 31, notification);
  tx(buyer, 10, undefined, [request]);
  tx(buyerWallet, 20, request, [hop]);
  tx(factoryWallet, 30, hop, [notified]);
  const buy = beginCell()
    .storeUint(kind === 1 ? OPTION_BUY_SHOUT : OPTION_BUY_SPREAD, 32)
    .storeUint(55, 64)
    .storeAddress(A(buyer))
    .storeUint(3, 64)
    .storeCoins(10000)
    .storeCoins(100)
    .storeCoins(1100)
    .endCell();
  const assigned = msg(factory, series, 41, buy);
  tx(factory, 40, notified, [assigned]);
  tx(series, 50, assigned);
  const positionHash = optionPositionHash("7", optionSeriesBuy(assigned)!);
  const activation = (
    opcode: number,
    wire = 55n,
    identityHash = positionHash,
  ) =>
    beginCell()
      .storeUint(opcode, 32)
      .storeUint(7, 64)
      .storeUint(3, 64)
      .storeUint(wire, 64)
      .storeUint(BigInt("0x" + identityHash), 256)
      .endCell();
  const activate = msg(factory, series, 61, activation(OPTION_ACTIVATE)),
    ack = msg(series, factory, 71, activation(OPTION_ACTIVATE_ACK));
  tx(factory, 60, undefined, [activate]);
  tx(series, 70, activate, [ack]);
  tx(factory, 80, ack);
  return { input, tx, activation, positionHash, position };
}
const option = async (input: ProjectionInput) =>
  (await projectOwnerLedger(input)).events.find(
    (event) => event.kind === "option_buy",
  )!;
async function durableGraph() {
  const f = fixture(),
    db = new PGlite();
  const vault = addr(108);
  f.input.chains.set(vault, { account: vault, role: 'counterparty', generation: 'fixture', historyComplete: true, transactions: [] });
  f.tx(vault, 5);
  const pool: LedgerSqlPool = {
    query: async (sql, params) =>
      !params && sql.includes(";")
        ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] }
        : db.query(sql, params),
    connect: async () => pool,
    end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool),
    seriesCode = beginCell().storeUint(123, 32).endCell();
  let activated = false,
    wrongCode = false;
  let lifecycle: "active" | "reduced" | "deleted" = "active";
  const currentPosition = () =>
    lifecycle === "deleted"
      ? null
      : lifecycle === "reduced"
        ? { ...f.position, premium: "0", collateral: "0" }
        : f.position;
  const history = (account: string) => {
    const all = f.input.chains.get(account)?.transactions ?? [];
    return activated ? all : all.filter((t) => BigInt(t.lt) <= 50n);
  };
  const int = (value: number | bigint) => ({
      type: "int" as const,
      value: BigInt(value),
    }),
    cell = (address: string) => ({
      type: "slice" as const,
      cell: beginCell().storeAddress(A(address)).endCell(),
    });
  const source: TonDataSource = {
    network: "testnet",
    getMasterchainInfo: async () => ({ seqno: 100 }),
    getAccountStateAtSeqno: async (account, seqno) => {
      const latest = history(account)
        .filter((t) => BigInt(t.lt) <= BigInt(seqno))
        .at(-1);
      return {
        accountState: "active",
        balance: "0",
        lastTxLt: latest?.lt,
        lastTxHash: latest?.hash,
        codeBoc: factoryCode.toBoc().toString("base64"),
        dataBoc:
          account === factory
            ? factoryData(
                BigInt(latest?.lt ?? "0") >= 90n
                  ? currentPosition()
                  : f.position,
                BigInt(latest?.lt ?? "0") < 80n,
              )
                .toBoc()
                .toString("base64")
            : undefined,
      };
    },
    getAccountState: async (account) => {
      const latest = history(account).at(-1);
      return {
        balance: "0",
        lastTxLt: latest?.lt,
        lastTxHash: latest?.hash,
        accountState: "active",
        dataBoc:
          account === factory
            ? factoryData(currentPosition()).toBoc().toString("base64")
            : undefined,
        codeBoc: (wrongCode ? Cell.EMPTY : seriesCode)
          .toBoc()
          .toString("base64"),
      };
    },
    getTransactions: async (account, limit, lt) =>
      history(account)
        .filter((t) => BigInt(t.lt) <= BigInt(lt!))
        .slice()
        .reverse()
        .slice(0, limit),
    getJettonBalance: async (owner, master) =>
      master === root && [buyer, factory].includes(owner)
        ? {
            wallet: owner === buyer ? buyerWallet : factoryWallet,
            balance: "0",
          }
        : null,
    getJettonMetadata: async () => ({ decimals: 9 }),
    close: async () => {},
    runGetMethod: async (account, method, args) => {
      if (
        method === "get_wallet_data" &&
        [buyerWallet, factoryWallet].includes(account)
      )
        return {
          exitCode: 0,
          stack: [
            int(0),
            cell(account === buyerWallet ? buyer : factory),
            cell(root),
            { type: "cell", cell: Cell.EMPTY },
          ],
        };
      if (account !== factory) return null;
      if (method === "factory_config") {
        const stack: any[] = Array.from({ length: 13 }, () => int(0));
        stack[4] = { type: "cell", cell: seriesCode };
        stack[5] = { type: "cell", cell: Cell.EMPTY };
        stack[6] = cell(root);
        stack[1] = cell(vault);
        stack[7] = { type: 'cell', cell: seriesCode };
        return { exitCode: 0, stack };
      }
      if (method === "series_info") {
        assert.deepEqual(args, [int(7)]);
        const stack: any[] = Array.from({ length: 18 }, () => int(0));
        stack[0] = int(-1);
        stack[2] = int(1);
        stack[3] = cell(series);
        return { exitCode: 0, stack };
      }
      if (method === "position_info")
        throw Error(
          "Current position_info must never prove historical activation",
        );
      return null;
    },
  };
  try {
    await store.initialize();
    const service = new LedgerService(
      "testnet",
      store,
      source,
      loadOpcodes(),
      createLogger("silent"),
      2,
      { jettonRoots: [root], optionFactory: factory, optionVault: vault, optionCodeHashes: qualifiedCodes, t3Root: root },
    );
    await service.syncAccount(buyer);
    const pending = await store.page("testnet", buyer);
    assert.equal(pending.coverage.historyComplete, true);
    assert.equal(
      pending.events.find((e) => e.kind === "option_buy")?.settlement?.status,
      "incomplete",
    );
    activated = true;
    await service.syncAccount(buyer);
    const complete = await store.page("testnet", buyer),
      event = complete.events.find((e) => e.kind === "option_buy")!;
    assert.equal(complete.coverage.historyComplete, true);
    assert.equal(
      event.settlement?.status,
      "confirmed",
      JSON.stringify(complete),
    );
    assert.notEqual(
      complete.coverage.generation,
      pending.coverage.generation,
      "counterparty activation changes the owner projection without an owner-head change",
    );
    assert(
      complete.coverage.relatedAccounts?.some(
        (a) => a.account === series && a.historyComplete,
      ),
    );
    const proof = event.movements.find(
      (m) => m.asset.kind === "option_position",
    )!.evidence.optionPosition!;
    assert.equal(proof.seriesId, "7");
    assert.equal(proof.positionId, "3");
    assert.equal(proof.buyStateRaw, "525");
    const counts = await pool.query(
      "SELECT (SELECT count(*) FROM ledger_runs)::text AS runs,(SELECT count(*) FROM ledger_membership)::text AS members,(SELECT count(*) FROM ledger_projection_events)::text AS events",
    );
    await service.syncAccount(buyer);
    const quiet = await store.page("testnet", buyer);
    assert.equal(
      quiet.coverage.generation,
      complete.coverage.generation,
      "identical immutable activation evidence does not copy the full ledger",
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM ledger_runs)::text AS runs,(SELECT count(*) FROM ledger_membership)::text AS members,(SELECT count(*) FROM ledger_projection_events)::text AS events",
        )
      ).rows,
      counts.rows,
    );
    const originalRight = event.movements.find(
      (m) => m.asset.kind === "option_position",
    );
    for (const stage of ["reduced", "deleted"] as const) {
      lifecycle = stage;
      f.tx(factory, stage === "reduced" ? 90 : 100);
      await pool.query("DELETE FROM ledger_account_states");
      await service.syncAccount(buyer);
      const rebuilt = await store.page("testnet", buyer);
      assert.equal(
        rebuilt.events.find((e) => e.kind === "option_buy")?.settlement?.status,
        "confirmed",
        stage + " current state must not erase historical acquisition",
      );
      assert.deepEqual(
        rebuilt.events
          .find((e) => e.kind === "option_buy")
          ?.movements.find((m) => m.asset.kind === "option_position"),
        originalRight,
        "cold archive reconstruction preserves original acquisition after " +
          stage,
      );
    }
    wrongCode = true;
    await service.syncAccount(buyer);
    const unsupported = await store.page("testnet", buyer);
    assert.equal(
      unsupported.events.find((e) => e.kind === "option_buy")?.settlement
        ?.status,
      "incomplete",
      "a deployed series-code mismatch cannot retain active ownership proof",
    );
    await service.stop();
  } finally {
    await pool.end();
  }
}
async function main() {
  const owner = A(addr(800)), inviter = A(addr(801));
  const purchasePrefix = () => beginCell().storeUint(OPTION_FACTORY_BUY, 32).storeUint(7, 64)
    .storeAddress(owner).storeCoins(100n).storeCoins(10n).storeUint(10000, 32);
  for (const referrer of [null, inviter]) {
    assert.equal(optionBuyForward(purchasePrefix().storeAddress(referrer).endCell())?.referrer, referrer?.toRawString() ?? null);
  }
  assert.equal(optionBuyForward(purchasePrefix().endCell()), null, 'omitted inviter is not a current purchase');
  assert.equal(optionBuyForward(purchasePrefix().storeAddress(owner).endCell()), null, 'self-referral is invalid');
  assert.equal(optionBuyForward(purchasePrefix().storeAddress(inviter).storeBit(true).endCell()), null, 'inviter tail must be exact');
  for (const kind of [1, 2] as const) {
    const f = fixture(kind),
      event = await option(f.input);
    assert.equal(event.settlement?.status, "confirmed", JSON.stringify(event));
    assert.equal(event.settlement?.queryId, "1234");
    assert.equal(event.settlement?.wireId, "55");
    assert.equal(event.settlement?.positionId, "3");
    assert.equal(event.settlement?.seriesId, "7");
    assert.equal(event.settlement?.positionHash, f.positionHash);
    assert.equal(event.settlement?.protocolFeeRaw, "20");
    assert.equal(event.settlement?.referrer, null);
    assert.deepEqual(
      event.movements
        .filter((m) => m.asset.kind === "jetton")
        .map((m) => [m.purpose, m.direction, m.amountRaw]),
      [
        ["option_premium", "out", "100"],
        ["protocol_fee", "fee", "20"],
      ],
    );
    const right = event.movements.find(
      (m) => m.asset.kind === "option_position",
    )!;
    assert.equal(right.amountRaw, "1");
    assert.equal(right.asset.id, `testnet:option-position:${factory}:7:3`);
    assert.equal(right.asset.owner, buyer);
    assert.equal(right.evidence.optionPosition?.sourceWallet, factoryWallet);
    assert.equal(event.movements.some(m => m.purpose === 'option_collateral'), false);
    assert.equal(right.evidence.optionPosition?.collateralRaw, '1100');
    assert.equal(right.evidence.optionPosition?.seriesId, "7");
    assert.equal(right.evidence.optionPosition?.beforeBuyStateRaw, "269");
    assert.equal(right.evidence.transactions?.length, 7);
    assert.deepEqual(event.issues, []);
  }
  const reserved = fixture();
  reserved.input.chains.get(factory)!.transactions.splice(1);
  reserved.input.chains.get(series)!.transactions.splice(1);
  assert.equal(
    (await option(reserved.input)).settlement?.status,
    "incomplete",
    "global reservation/open notional cannot confirm a purchase",
  );
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.position.owner = other;
    },
    (f: ReturnType<typeof fixture>) => {
      f.position.buyState = 13n;
    },
    (f: ReturnType<typeof fixture>) => {
      f.position.buyState = 541n;
    },
    (f: ReturnType<typeof fixture>) => {
      f.position.notional = "10001";
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(factory)!.transactions.at(-1)!.success = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(series)!.historyComplete = false;
    },
    (f: ReturnType<typeof fixture>) => {
      const ack = f.input.chains.get(series)!.transactions.at(-1)!
        .outMessages[0];
      ack.body = f
        .activation(OPTION_ACTIVATE_ACK, 56n)
        .toBoc()
        .toString("base64");
      f.input.chains.get(factory)!.transactions.at(-1)!.inMessage = { ...ack };
    },
    (f: ReturnType<typeof fixture>) => {
      const ack = f.input.chains.get(series)!.transactions.at(-1)!
        .outMessages[0];
      ack.body = f
        .activation(OPTION_ACTIVATE_ACK, 55n, "11".repeat(32))
        .toBoc()
        .toString("base64");
      f.input.chains.get(factory)!.transactions.at(-1)!.inMessage = { ...ack };
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.chains.get(factory)!.transactions.at(-1)!.inMessage!.createdLt =
        undefined;
    },
    (f: ReturnType<typeof fixture>) => {
      f.input.optionFactories!.clear();
    },
  ]) {
    const f = fixture();
    mutate(f);
    const event = await option(f.input);
    assert.equal(event.settlement?.status, "incomplete");
    assert(!event.movements.some((m) => m.asset.kind === "option_position"));
  }
  const missingArchive = fixture();
  missingArchive.input.stateAt = async () => null;
  assert(
    (await option(missingArchive.input)).issues.includes(
      "option_activation_state_unavailable",
    ),
  );
  for (const field of ["sourceWallet", "wireId", "custodyWireId"] as const) {
    const wrong = fixture();
    wrong.position[field] = field === "sourceWallet" ? other : "0";
    assert.equal((await option(wrong.input)).settlement?.status, "incomplete");
  }
  const missingPrerequisite = fixture();
  missingPrerequisite.position.buyState = 512n;
  assert.equal(
    (await option(missingPrerequisite.input)).settlement?.status,
    "incomplete",
    "ACTIVE without funding/reservation prerequisites is inconsistent",
  );
  const replay = fixture(),
    a = msg(factory, series, 91, replay.activation(OPTION_ACTIVATE)),
    b = msg(series, factory, 101, replay.activation(OPTION_ACTIVATE_ACK));
  replay.tx(factory, 90, undefined, [a]);
  replay.tx(series, 100, a, [b]);
  replay.tx(factory, 110, b);
  assert.equal(
    (await projectOwnerLedger(replay.input)).events
      .flatMap((e) => e.movements)
      .filter((m) => m.asset.kind === "option_position").length,
    1,
    "activation retry does not mint another position",
  );
  await durableGraph();
  console.log(
    "option purchase owner/query/position activation and funding attribution tests passed",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
