import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Address, beginCell, Cell, Dictionary } from "@ton/core";
import {
  projectOwnerLedger,
  type LedgerChain,
  type ProjectionInput,
} from "../ledger/project";
import type {
  RawMessage,
  RawTransaction,
  TonDataSource,
} from "../data/dataSource";
import { PGlite } from "@electric-sql/pglite";
import { PostgresLedgerStore, type LedgerSqlPool } from "../ledger/store";
import { LedgerService } from "../ledger/service";
import { createLogger } from "../utils/logger";
import { loadOpcodes } from "../utils/opcodes";
import { perpsWalletAddress } from "../ledger/perpsWire";
import {
  TRANSFER,
  INTERNAL,
  SETTLEMENT_INTERNAL,
  NOTIFY,
} from "../ledger/wire";
import {
  optionSettlementKey,
  optionPositionClaimIdentity,
  optionIngressClaimIdentity,
  OPTION_EXERCISE,
  OPTION_SHOUT_EXERCISE,
  OPTION_SPREAD_EXERCISE,
  OPTION_SHOUT_PAYOUT,
  OPTION_VAULT_PAYOUT,
  OPTION_CLAIM_RECEIPT,
} from "../ledger/optionLifecycleWire";
import {
  readOptionFactoryConfig,
  readOptionProductState,
  readOptionVaultState,
} from "../ledger/optionLifecycleState";
import { parseLedgerOptionsCodeHashes } from "../config/ledgerOptions";

const A = (s: string) => Address.parse(s),
  addr = (n: number) => `0:${n.toString(16).padStart(64, "0")}`;
const owner = addr(701),
  factory = addr(702),
  vault = addr(703),
  series = addr(704),
  root = addr(705),
  other = addr(706);
const factoryCode = beginCell().storeUint(701, 32).endCell(),
  vaultCode = beginCell().storeUint(702, 32).endCell(),
  shoutCode = beginCell().storeUint(703, 32).endCell(),
  spreadCode = beginCell().storeUint(704, 32).endCell(),
  walletCode = beginCell().storeUint(705, 32).endCell();
const q = {
  factoryCodeHash: factoryCode.hash().toString("hex"),
  vaultCodeHash: vaultCode.hash().toString("hex"),
  shoutCodeHash: shoutCode.hash().toString("hex"),
  outperformanceCodeHash: spreadCode.hash().toString("hex"),
  walletCodeHash: walletCode.hash().toString("hex"),
};
const wallet = (o: string) => perpsWalletAddress(walletCode, root, o),
  ownerWallet = wallet(owner),
  factoryWallet = wallet(factory),
  vaultWallet = wallet(vault);
const notional = 2n ** 68n + 31n,
  collateral = 2n ** 74n + 17n,
  payout = 2n ** 70n + 19n,
  premium = 1200n;
const zero = "0".repeat(64),
  boc = (c: Cell) => c.toBoc().toString("base64");
const inline = {
  serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
  parse: (s: any) => s.asCell(),
};
type Position = {
  owner: string;
  premium: bigint;
  collateral: bigint;
  ready: boolean;
  settled: boolean;
  payout: bigint;
  excess: bigint;
  flags: bigint;
  custodyWire: bigint;
  refundWire: bigint;
  walletFunding: bigint;
};
const position = (overrides: Partial<Position> = {}): Position => ({
  owner,
  premium,
  collateral,
  ready: false,
  settled: false,
  payout: 0n,
  excess: 0n,
  flags: 525n,
  custodyWire: 56n,
  refundWire: 0n,
  walletFunding: 0n,
  ...overrides,
});
type Claim = {
  id: bigint;
  identity: string;
  kind: number;
  amount: bigint;
  wire: bigint;
  finalWire: bigint;
  status: number;
  owner: string;
  recipient: string;
};
export type FactorySeriesFixture = {
  seriesId: bigint;
  templateId: number;
  kind: number;
  expiry: bigint;
  maxNotional: bigint;
  premiumBps: number;
  collateralMultiplierBps: number;
  strikeBps: number;
  openNotional: bigint;
  collateralLocked: bigint;
  status: number;
  settlementTimestamp: bigint;
  nextTokenId: bigint;
  correlationScaleBps: number;
  correlationBps: number;
  correlationDispersionBps: number;
  correlationTimestamp: bigint;
  correlationConfig: Cell;
  optionAddress: string | null;
  underlyingPool: string | null;
  quotePool: string | null;
  activationWireId: bigint;
  activationRequestHash: string;
  configHash: string;
};
const factorySeries = (
  overrides: Partial<FactorySeriesFixture> = {},
): FactorySeriesFixture => ({
  seriesId: 7n,
  templateId: 1,
  kind: 1,
  expiry: 1900000000n,
  maxNotional: notional * 10n,
  premiumBps: 100,
  collateralMultiplierBps: 10000,
  strikeBps: 10000,
  openNotional: notional,
  collateralLocked: collateral,
  status: 0,
  settlementTimestamp: 0n,
  nextTokenId: 4n,
  correlationScaleBps: 10000,
  correlationBps: 0,
  correlationDispersionBps: 0,
  correlationTimestamp: 0n,
  correlationConfig: beginCell()
    .storeUint(0, 32)
    .storeUint(10000, 32)
    .storeUint(10000, 32)
    .storeUint(10000, 32)
    .storeUint(0, 32)
    .endCell(),
  optionAddress: series,
  underlyingPool: other,
  quotePool: other,
  activationWireId: 0n,
  activationRequestHash: zero,
  configHash: zero,
  ...overrides,
});
export type FactoryStateFixture = {
  series?: FactorySeriesFixture[];
  seriesBuyIndex?: Array<[bigint, bigint]>;
  nextBuyWireId?: bigint;
};
function factoryData(
  p: Position | null,
  claims: Claim[] = [],
  active = 0n,
  tombstone?: string,
  state: FactoryStateFixture = {},
) {
  const seriesEntries = Dictionary.empty(Dictionary.Keys.BigUint(64), inline),
    buyIndex = Dictionary.empty(
      Dictionary.Keys.BigUint(64),
      Dictionary.Values.BigUint(128),
    );
  for (const s of state.series ?? [])
    seriesEntries.set(
      s.seriesId,
      beginCell()
        .storeUint(s.templateId, 32)
        .storeUint(s.kind, 16)
        .storeInt(s.expiry, 64)
        .storeCoins(s.maxNotional)
        .storeUint(s.premiumBps, 32)
        .storeUint(s.collateralMultiplierBps, 32)
        .storeUint(s.strikeBps, 32)
        .storeCoins(s.openNotional)
        .storeCoins(s.collateralLocked)
        .storeUint(s.status, 8)
        .storeInt(s.settlementTimestamp, 64)
        .storeUint(s.nextTokenId, 64)
        .storeUint(s.correlationScaleBps, 32)
        .storeInt(s.correlationBps, 32)
        .storeUint(s.correlationDispersionBps, 32)
        .storeInt(s.correlationTimestamp, 64)
        .storeRef(s.correlationConfig)
        .storeRef(
          beginCell()
            .storeAddress(s.optionAddress ? A(s.optionAddress) : null)
            .storeAddress(s.underlyingPool ? A(s.underlyingPool) : null)
            .storeAddress(s.quotePool ? A(s.quotePool) : null),
        )
        .storeRef(
          beginCell()
            .storeUint(s.activationWireId, 64)
            .storeUint(BigInt("0x" + s.activationRequestHash), 256)
            .storeUint(BigInt("0x" + s.configHash), 256),
        )
        .endCell(),
    );
  for (const [wire, key] of state.seriesBuyIndex ?? []) buyIndex.set(wire, key);
  const emptyDict = beginCell().storeDict(null).endCell(),
    seriesAux = beginCell()
      .storeRef(emptyDict)
      .storeRef(emptyDict)
      .storeRef(beginCell().storeDict(buyIndex)),
    oracleBundle = beginCell()
      .storeRef(emptyDict)
      .storeRef(
        beginCell()
          .storeUint(7000, 16)
          .storeUint(6000, 16)
          .storeUint(8500, 16)
          .storeUint(1000, 16)
          .storeBit(false)
          .storeUint(0, 32),
      )
      .storeRef(beginCell().storeAddress(null).storeUint(0, 32))
      .storeRef(seriesAux),
    maps = beginCell()
      .storeRef(emptyDict)
      .storeRef(emptyDict)
      .storeRef(beginCell().storeDict(seriesEntries));
  const positions = Dictionary.empty(Dictionary.Keys.BigUint(128), inline);
  if (p)
    positions.set(
      (7n << 64n) | 3n,
      beginCell()
        .storeAddress(A(p.owner))
        .storeAddress(A(factoryWallet))
        .storeCoins(notional)
        .storeCoins(p.premium)
        .storeCoins(p.collateral)
        .storeCoins(p.payout)
        .storeBit(p.ready)
        .storeBit(p.settled)
        .storeUint(p.flags, 16)
        .storeRef(
          beginCell()
            .storeAddress(A(owner))
            .storeUint(55, 64)
            .storeUint(p.custodyWire, 64)
            .storeUint(p.refundWire, 64)
            .storeCoins(20)
            .storeCoins(p.excess)
            .storeCoins(p.walletFunding),
        )
        .endCell(),
    );
  const cd = Dictionary.empty(
      Dictionary.Keys.BigUint(64),
      Dictionary.Values.Cell(),
    ),
    ci = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.BigUint(64),
    );
  for (const c of claims) {
    cd.set(
      c.id,
      beginCell()
        .storeUint(c.id, 64)
        .storeUint(BigInt("0x" + c.identity), 256)
        .storeUint(c.kind, 8)
        .storeCoins(c.amount)
        .storeUint(c.wire, 64)
        .storeUint(c.finalWire, 64)
        .storeUint(c.status, 8)
        .storeCoins(100)
        .storeRef(
          beginCell().storeAddress(A(c.owner)).storeAddress(A(c.recipient)),
        )
        .endCell(),
    );
    ci.set(BigInt("0x" + c.identity), c.id);
  }
  if (tombstone) ci.set(BigInt("0x" + tombstone), 0n);
  const config = beginCell()
    .storeAddress(A(other))
    .storeAddress(A(vault))
    .storeRef(beginCell().storeAddress(A(other)).storeAddress(A(other)))
    .storeRef(beginCell().storeRef(shoutCode).storeRef(spreadCode))
    .storeRef(beginCell().storeAddress(A(root)).storeRef(walletCode))
    .storeRef(
      beginCell()
        .storeAddress(A(other))
        .storeAddress(A(root))
        .storeRef(walletCode)
        .storeRef(
          beginCell()
            .storeRef(beginCell().storeDict(cd))
            .storeRef(beginCell().storeDict(ci)),
        )
        .storeRef(Cell.EMPTY)
        .storeUint(20, 16)
        .storeUint(0, 8)
        .storeUint(state.nextBuyWireId ?? 91n, 64)
        .storeUint(active, 128)
        .storeCoins(0)
        .storeUint(0, 64),
    );
  return beginCell()
    .storeRef(
      beginCell()
        .storeRef(Cell.EMPTY)
        .storeRef(config)
        .storeRef(Cell.EMPTY)
        .storeRef(oracleBundle),
    )
    .storeRef(maps)
    .storeRef(beginCell().storeDict(positions))
    .endCell();
}
function productData(
  kind: 1 | 2,
  after: boolean,
  amount = payout,
  ownerOverride = owner,
  stage: "active" | "reserved" | "absent" = "active",
) {
  const config = beginCell()
    .storeRef(beginCell().storeAddress(A(factory)).storeAddress(A(other)))
    .storeRef(beginCell().storeAddress(A(other)).storeAddress(A(vault)));
  if (kind === 1)
    config
      .storeAddress(A(other))
      .storeInt(1900000000, 64)
      .storeInt(1, 64)
      .storeInt(1, 64)
      .storeUint(1, 32)
      .storeUint(2, 32)
      .storeRef(beginCell().storeCoins(notional * 10n))
      .storeInt(1, 64)
      .storeInt(1, 64)
      .storeRef(
        beginCell()
          .storeUint(10000, 32)
          .storeUint(10000, 32)
          .storeInt(1000, 128)
          .storeInt(1000, 128)
          .storeUint(0, 8),
      );
  else
    config
      .storeRef(beginCell().storeAddress(A(other)).storeAddress(A(other)))
      .storeInt(1900000000, 64)
      .storeUint(10000, 32)
      .storeUint(1, 32)
      .storeUint(2, 32)
      .storeCoins(notional * 10n)
      .storeInt(1, 64)
      .storeInt(1, 64)
      .storeUint(0, 8);
  const positions = Dictionary.empty(Dictionary.Keys.BigUint(64), inline);
  if (stage !== "absent" && (kind === 2 || !after)) {
    const p = beginCell()
      .storeAddress(A(ownerOverride))
      .storeUint(3, 64)
      .storeCoins(notional)
      .storeCoins(premium);
    if (kind === 1)
      p.storeCoins(0)
        .storeInt(0, 64)
        .storeBit(false)
        .storeBit(false)
        .storeCoins(collateral);
    else
      p.storeCoins(collateral)
        .storeCoins(amount)
        .storeBit(stage === "active")
        .storeBit(stage === "active" && after);
    p.storeBit(stage === "active").storeUint(55, 64);
    positions.set(3n, p.endCell());
  }
  const runtime = beginCell()
    .storeInt(0, 64)
    .storeBit(false)
    .storeCoins(after ? 0 : notional)
    .storeUint(7, 64)
    .storeUint(1, 64)
    .storeUint(0, 256)
    .storeUint(0, 256);
  return beginCell()
    .storeUint(kind === 1 ? 0x5348 : 0x4f50, 16)
    .storeRef(Cell.EMPTY)
    .storeRef(config)
    .storeRef(beginCell().storeDict(positions))
    .storeRef(beginCell().storeRef(runtime).storeRef(Cell.EMPTY))
    .endCell();
}
type Entry = {
  kind: number;
  requestId: bigint;
  status: number;
  wire: bigint;
  amount: bigint;
  recipient: string;
  requestHash: string;
  risk: bigint;
  accounting: number;
  premium: bigint;
};
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  kind: 1,
  requestId: 3n,
  status: 2,
  wire: 91n,
  amount: payout,
  recipient: owner,
  requestHash: zero,
  risk: 0n,
  accounting: 1,
  premium: 500n,
  ...overrides,
});
function vaultData(
  e: Entry | null,
  final = false,
  overrides: {
    depositReceipt?: bigint;
    tracked?: bigint;
    bucketLocked?: bigint;
    bucketPremium?: bigint;
    totalLocked?: bigint;
    totalPremium?: bigint;
  } = {},
) {
  const dict = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    ),
    key = optionSettlementKey(
      e?.kind ?? 1,
      "7",
      (e?.requestId ?? 3n).toString(),
    );
  if (e)
    dict.set(
      BigInt("0x" + key),
      beginCell()
        .storeUint(e.kind, 8)
        .storeUint(e.requestId, 64)
        .storeUint(7, 64)
        .storeUint(e.status, 8)
        .storeCoins(e.amount)
        .storeUint(e.wire, 64)
        .storeInt(1700000000, 64)
        .storeCoins(e.status === 3 || e.status === 4 ? 0 : 10)
        .storeCoins(e.kind === 3 ? 0 : e.amount)
        .storeCoins(e.premium)
        .storeUint(e.accounting, 8)
        .storeUint(e.risk, 64)
        .storeUint(e.risk ? 4 : 0, 8)
        .storeInt(1700000000, 64)
        .storeRef(
          beginCell()
            .storeAddress(A(e.recipient))
            .storeAddress(A(wallet(e.recipient))),
        )
        .storeRef(
          beginCell()
            .storeUint(BigInt("0x" + e.requestHash), 256)
            .storeUint(0, 256)
            .storeCoins(e.risk ? e.amount : 0)
            .storeRef(Cell.EMPTY),
        )
        .endCell(),
    );
  const config = beginCell()
    .storeRef(beginCell().storeAddress(A(factory)))
    .storeRef(beginCell().storeAddress(A(other)))
    .storeRef(
      beginCell()
        .storeAddress(A(other))
        .storeAddress(null)
        .storeUint(0, 16)
        .storeUint(0, 8),
    )
    .storeRef(
      beginCell()
        .storeAddress(A(vaultWallet))
        .storeAddress(A(vaultWallet))
        .storeAddress(A(root))
        .storeRef(walletCode),
    );
  const receipts = Dictionary.empty(
    Dictionary.Keys.BigUint(128),
    Dictionary.Values.BigUint(256),
  );
  if (overrides.depositReceipt !== undefined)
    receipts.set((7n << 64n) | 3n, overrides.depositReceipt);
  const buckets = Dictionary.empty(
    Dictionary.Keys.BigUint(64),
    Dictionary.Values.Cell(),
  );
  if (overrides.bucketLocked !== undefined)
    buckets.set(
      7n,
      beginCell()
        .storeCoins(overrides.bucketLocked)
        .storeCoins(overrides.bucketPremium ?? 0n)
        .storeCoins(0)
        .storeCoins(0)
        .storeUint(1, 64)
        .storeUint(0, 8)
        .storeInt(0, 64)
        .storeRef(
          beginCell()
            .storeUint(0, 256)
            .storeCoins(0)
            .storeCoins(0)
            .storeCoins(0),
        )
        .endCell(),
    );
  const journal = beginCell()
    .storeDict(dict)
    .storeDict(null)
    .storeDict(receipts)
    .storeUint(0, 256)
    .storeUint(e?.status === 3 ? BigInt("0x" + key) : 0n, 256)
    .storeUint(0, 256)
    .storeUint(92, 64)
    .storeUint(1, 64)
    .storeUint(1, 64);
  return beginCell()
    .storeRef(Cell.EMPTY)
    .storeRef(config)
    .storeRef(beginCell().storeDict(buckets))
    .storeRef(journal)
    .storeCoins(
      (overrides.tracked ?? collateral * 2n) - (final ? e!.amount : 0n),
    )
    .storeCoins(final ? 0 : (e?.amount ?? 0n))
    .storeCoins(overrides.totalLocked ?? collateral)
    .storeCoins(overrides.totalPremium ?? premium)
    .endCell();
}
function fixture() {
  let nextLt = 1;
  const chains = new Map<string, LedgerChain>(),
    states = new Map<string, { code: Cell; data: Cell }>();
  const input: ProjectionInput = {
    network: "testnet",
    owner,
    chains,
    wallets: new Map(),
    pools: new Map(),
    opcodes: loadOpcodes(),
    optionFactories: new Map([
      [
        factory,
        {
          address: factory,
          collateralRoot: root,
          codeHash: q.factoryCodeHash,
          qualification: q,
          vault,
          vaultWallet,
          factoryWallet,
          walletCode,
          series: new Map([["7", { address: series, kind: 1 }]]),
        },
      ],
    ]),
    stateAt: async (account, lt, hash) => {
      const s = states.get(`${account}:${lt}`);
      return s && hash === txHash(Number(lt))
        ? {
            seqno: Number(lt),
            state: {
              accountState: "active",
              balance: "0",
              lastTxLt: lt,
              lastTxHash: hash,
              codeBoc: boc(s.code),
              dataBoc: boc(s.data),
            },
          }
        : null;
    },
  };
  const txHash = (lt: number) =>
    createHash("sha256").update(String(lt)).digest("base64");
  const addAccount = (account: string) => {
    if (!chains.has(account))
      chains.set(account, {
        account,
        role:
          account === owner
            ? "owner"
            : account === ownerWallet
              ? "owned_jetton_wallet"
              : "counterparty",
        generation: "fixture",
        historyComplete: true,
        transactions: [],
      });
  };
  for (const o of [owner, other, factory, vault]) {
    addAccount(o);
    addAccount(wallet(o));
    input.wallets.set(wallet(o), {
      kind: "jetton",
      id: `testnet:jetton:${root}`,
      master: root,
      owner: o,
      wallet: wallet(o),
      decimals: 9,
    });
  }
  addAccount(series);
  const msg = (
    source: string,
    destination: string,
    body: Cell,
  ): RawMessage => ({
    source,
    destination,
    body: boc(body),
    createdLt: String(nextLt++),
    value: "100",
    forwardFeeRaw: "3",
    ihrFeeRaw: "0",
    bounced: false,
  });
  const tx = (
    account: string,
    incoming?: RawMessage,
    outgoing: RawMessage[] = [],
    state?: { code: Cell; data: Cell },
  ) => {
    addAccount(account);
    const list = chains.get(account)!.transactions,
      previous = list.at(-1),
      lt = nextLt++;
    const raw: RawTransaction = {
      lt: String(lt),
      hash: txHash(lt),
      prevTransactionLt: previous?.lt ?? "0",
      prevTransactionHash:
        previous?.hash ?? Buffer.alloc(32).toString("base64"),
      utime: 1700000000 + lt,
      success: true,
      status: "success",
      totalFeesRaw: "7",
      inMessage: incoming,
      outMessages: outgoing,
    };
    list.push(raw);
    if (state) states.set(`${account}:${lt}`, state);
    return raw;
  };
  return { input, states, msg, tx };
}
function cash(
  f: ReturnType<typeof fixture>,
  controller: string,
  start: RawTransaction,
  recipient: string,
  amount: bigint,
  wire: bigint,
  before: Cell,
  after: Cell,
  finalReceipt?: Cell,
) {
  const source = wallet(controller),
    destination = wallet(recipient),
    code = controller === vault ? vaultCode : factoryCode;
  const request = f.msg(
    controller,
    source,
    beginCell()
      .storeUint(TRANSFER, 32)
      .storeUint(wire, 64)
      .storeCoins(amount)
      .storeAddress(A(recipient))
      .storeAddress(A(controller))
      .storeRef(beginCell().storeUint(0x4a535454, 32))
      .storeCoins(1)
      .storeRef(Cell.EMPTY)
      .endCell(),
  );
  start.outMessages.push(request);
  const transfer = f.msg(
    source,
    destination,
    beginCell()
      .storeUint(SETTLEMENT_INTERNAL, 32)
      .storeUint(wire, 64)
      .storeCoins(amount)
      .storeAddress(A(controller))
      .storeAddress(A(source))
      .storeCoins(1)
      .storeRef(Cell.EMPTY)
      .endCell(),
  );
  const control = (src: string, dest: string, op: number) =>
    f.msg(
      src,
      dest,
      beginCell()
        .storeUint(op, 32)
        .storeUint(wire, 64)
        .storeCoins(amount)
        .storeAddress(A(destination))
        .endCell(),
    );
  const ack = control(destination, source, 0x4a534143),
    success = control(source, controller, 0x4a535543),
    finalize = control(controller, source, 0x4a53464e),
    finalized = control(source, controller, 0x4a53464b);
  const sourceTx = f.tx(source, request, [transfer]),
    creditTx = f.tx(destination, transfer, [ack]);
  f.tx(source, ack, [success]);
  f.tx(controller, success, [finalize], { code, data: before });
  f.tx(source, finalize, [finalized]);
  const receipt = finalReceipt && f.msg(controller, recipient, finalReceipt),
    terminal = f.tx(controller, finalized, receipt ? [receipt] : [], {
      code,
      data: after,
    });
  if (receipt) f.tx(recipient, receipt);
  return { sourceTx, creditTx, terminal, transfer, finalized };
}
function exercise(
  kind: 1 | 2 = 1,
  amount = payout,
  paid = true,
  recipient = owner,
) {
  const f = fixture();
  f.input.optionFactories!.get(factory)!.series.get("7")!.kind = kind;
  const before = position({
      ready: kind === 2,
      payout: kind === 2 ? amount : 0n,
    }),
    after = position({
      premium: premium - 500n,
      collateral: 0n,
      settled: true,
    });
  f.tx(factory, undefined, [], {
    code: factoryCode,
    data: factoryData(before),
  });
  f.tx(series, undefined, [], {
    code: kind === 1 ? shoutCode : spreadCode,
    data: productData(kind, false, amount),
  });
  f.tx(vault, undefined, [], { code: vaultCode, data: vaultData(null) });
  const original = f.msg(
    owner,
    factory,
    beginCell()
      .storeUint(OPTION_EXERCISE, 32)
      .storeUint(7, 64)
      .storeUint(3, 64)
      .storeAddress(A(recipient))
      .storeCoins(amount)
      .storeCoins(500)
      .endCell(),
  );
  const productBody = beginCell()
    .storeUint(kind === 1 ? OPTION_SHOUT_EXERCISE : OPTION_SPREAD_EXERCISE, 32)
    .storeUint(3, 64)
    .storeCoins(amount);
  if (kind === 1)
    productBody
      .storeAddress(A(recipient))
      .storeCoins(500)
      .storeAddress(A(owner));
  const request = f.msg(factory, series, productBody.endCell());
  f.tx(owner, undefined, [original]);
  const start = f.tx(factory, original, [request], {
    code: factoryCode,
    data: factoryData(kind === 1 ? position({ ready: true }) : after),
  });
  const spyt = f.msg(
    factory,
    vault,
    beginCell()
      .storeUint(OPTION_VAULT_PAYOUT, 32)
      .storeUint(3, 64)
      .storeUint(7, 64)
      .storeAddress(A(recipient))
      .storeCoins(amount)
      .storeCoins(500)
      .storeAddress(A(owner))
      .endCell(),
  );
  const callback = f.msg(
    series,
    factory,
    beginCell()
      .storeUint(OPTION_SHOUT_PAYOUT, 32)
      .storeUint(3, 64)
      .storeAddress(A(recipient))
      .storeCoins(amount)
      .storeCoins(500)
      .storeAddress(A(owner))
      .endCell(),
  );
  f.tx(series, request, kind === 1 ? [callback] : [], {
    code: kind === 1 ? shoutCode : spreadCode,
    data: productData(kind, true, amount),
  });
  if (kind === 1)
    f.tx(factory, callback, [spyt], {
      code: factoryCode,
      data: factoryData(after),
    });
  else start.outMessages.push(spyt);
  const e = entry({
    amount,
    recipient,
    requestHash: Cell.fromBase64(spyt.body!).hash().toString("hex"),
    status: amount === 0n ? 4 : paid ? 2 : 1,
  });
  const dispatch = f.tx(vault, spyt, [], {
    code: vaultCode,
    data: vaultData(e),
  });
  const payment =
    amount > 0n && paid
      ? cash(
          f,
          vault,
          dispatch,
          recipient,
          amount,
          e.wire,
          vaultData({ ...e, status: 3 }),
          vaultData({ ...e, status: 4 }, true),
        )
      : undefined;
  return { ...f, original, start, spyt, entry: e, dispatch, payment };
}
function refund(kind: 1 | 3 = 3, paid = true) {
  const f = fixture(),
    amount = payout,
    wire = 91n,
    query = 9007199254741017n,
    payload = beginCell().storeUint(0x46425559, 32).endCell();
  const identity =
    kind === 1
      ? optionIngressClaimIdentity(
          owner,
          query.toString(),
          amount.toString(),
          payload.hash().toString("hex"),
        )
      : optionPositionClaimIdentity(
          3,
          "7",
          "3",
          owner,
          owner,
          amount.toString(),
        );
  const claim: Claim = {
      id: 88n,
      identity,
      kind,
      amount,
      wire,
      finalWire: 0n,
      status: 2,
      owner,
      recipient: owner,
    },
    p = kind === 3 ? position({ excess: amount }) : null;
  f.tx(factory, undefined, [], { code: factoryCode, data: factoryData(p) });
  let incoming: RawMessage;
  if (kind === 1) {
    const transfer = f.msg(
      owner,
      ownerWallet,
      beginCell()
        .storeUint(TRANSFER, 32)
        .storeUint(query, 64)
        .storeCoins(amount)
        .storeAddress(A(factory))
        .storeAddress(A(owner))
        .storeRef(Cell.EMPTY)
        .storeCoins(1)
        .storeRef(payload)
        .endCell(),
    );
    const internal = f.msg(
      ownerWallet,
      factoryWallet,
      beginCell()
        .storeUint(INTERNAL, 32)
        .storeUint(query, 64)
        .storeCoins(amount)
        .storeAddress(A(owner))
        .storeAddress(A(owner))
        .storeCoins(1)
        .storeRef(payload)
        .endCell(),
    );
    incoming = f.msg(
      factoryWallet,
      factory,
      beginCell()
        .storeUint(NOTIFY, 32)
        .storeUint(query, 64)
        .storeCoins(amount)
        .storeAddress(A(owner))
        .storeAddress(A(ownerWallet))
        .storeCoins(1)
        .storeRef(payload)
        .endCell(),
    );
    f.tx(owner, undefined, [transfer]);
    f.tx(ownerWallet, transfer, [internal]);
    f.tx(factoryWallet, internal, [incoming]);
  } else {
    incoming = f.msg(
      other,
      factory,
      beginCell().storeUint(0x4f435259, 32).storeUint(claim.id, 64).endCell(),
    );
    f.tx(other, undefined, [incoming]);
  }
  const receiptBody = beginCell()
    .storeUint(OPTION_CLAIM_RECEIPT, 32)
    .storeUint(claim.id, 64)
    .storeUint(kind, 8)
    .storeUint(wire, 64)
    .storeCoins(amount)
    .storeUint(BigInt("0x" + identity), 256)
    .endCell();
  const early = f.msg(factory, owner, receiptBody),
    dispatch = f.tx(factory, incoming, [early], {
      code: factoryCode,
      data: factoryData(p, [claim], claim.id),
    });
  f.tx(owner, early);
  const payment = paid
    ? cash(
        f,
        factory,
        dispatch,
        owner,
        amount,
        wire,
        factoryData(p, [{ ...claim, status: 3, finalWire: wire }], claim.id),
        factoryData(p, [], 0n, identity),
        receiptBody,
      )
    : undefined;
  return { ...f, claim, p, incoming, dispatch, payment };
}
const exerciseEvent = async (f: ReturnType<typeof exercise>) =>
  (await projectOwnerLedger(f.input)).events.find(
    (e) => e.kind === "option_exercise",
  )!;
async function durableLifecycle() {
  const f = exercise(),
    db = new PGlite();
  const pool: LedgerSqlPool = {
    query: async (sql, params) =>
      !params && sql.includes(";")
        ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] }
        : db.query(sql, params),
    connect: async () => pool,
    end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool);
  let paid = false,
    wrongVaultCode = false;
  const history = (account: string) =>
    (f.input.chains.get(account)?.transactions ?? []).filter(
      (t) => paid || BigInt(t.lt) <= BigInt(f.dispatch.lt),
    );
  const code = (account: string) =>
    account === factory
      ? factoryCode
      : account === vault
        ? wrongVaultCode
          ? Cell.EMPTY
          : vaultCode
        : account === series
          ? shoutCode
          : walletCode;
  const stateAtSeq = (account: string, seqno = 1000) => {
    const transactions = history(account).filter(
        (t) => BigInt(t.lt) <= BigInt(seqno),
      ),
      latest = transactions.at(-1);
    const data = transactions
      .slice()
      .reverse()
      .map((t) => f.states.get(`${account}:${t.lt}`)?.data)
      .find(Boolean);
    return {
      accountState: "active" as const,
      balance: "0",
      lastTxLt: latest?.lt,
      lastTxHash: latest?.hash,
      codeBoc: boc(code(account)),
      dataBoc: data && boc(data),
    };
  };
  const int = (value: number) => ({
      type: "int" as const,
      value: BigInt(value),
    }),
    cell = (address: string) => ({
      type: "slice" as const,
      cell: beginCell().storeAddress(A(address)).endCell(),
    });
  const source: TonDataSource = {
    network: "testnet",
    getMasterchainInfo: async () => ({ seqno: 1000 }),
    getAccountState: async (account) => stateAtSeq(account),
    getAccountStateAtSeqno: async (account, seqno) =>
      stateAtSeq(account, seqno),
    getTransactions: async (account, limit, lt) =>
      history(account)
        .filter((t) => BigInt(t.lt) <= BigInt(lt!))
        .slice()
        .reverse()
        .slice(0, limit),
    getJettonBalance: async (party, master) =>
      master === root && [owner, other, factory, vault].includes(party)
        ? { wallet: wallet(party), balance: "0" }
        : null,
    getJettonMetadata: async () => ({ decimals: 9 }),
    close: async () => {},
    runGetMethod: async (account, method) => {
      const asset = f.input.wallets.get(account);
      if (method === "get_wallet_data" && asset)
        return {
          exitCode: 0,
          stack: [
            int(0),
            cell(asset.owner!),
            cell(root),
            { type: "cell", cell: walletCode },
          ],
        };
      if (account === factory && method === "factory_config") {
        const stack: any[] = Array.from({ length: 13 }, () => int(0));
        stack[1] = cell(vault);
        stack[4] = { type: "cell", cell: shoutCode };
        stack[5] = { type: "cell", cell: spreadCode };
        stack[6] = cell(root);
        stack[7] = { type: "cell", cell: walletCode };
        return { exitCode: 0, stack };
      }
      if (account === factory && method === "series_info") {
        const stack: any[] = Array.from({ length: 18 }, () => int(0));
        stack[0] = int(-1);
        stack[2] = int(1);
        stack[3] = cell(series);
        return { exitCode: 0, stack };
      }
      if (method === "position_info")
        throw Error("Latest positions cannot establish lifecycle evidence");
      return null;
    },
  };
  const service = new LedgerService(
    "testnet",
    store,
    source,
    loadOpcodes(),
    createLogger("silent"),
    2,
    {
      jettonRoots: [root],
      t3Root: root,
      optionFactory: factory,
      optionVault: vault,
      optionCodeHashes: q,
    },
  );
  try {
    await store.initialize();
    await service.syncAccount(owner);
    const pending = await store.page("testnet", owner);
    assert.equal(
      pending.coverage.historyComplete,
      true,
      JSON.stringify(pending.coverage),
    );
    assert.equal(
      pending.events.find((e) => e.kind === "option_exercise")?.settlement
        ?.optionLifecycle?.payout.status,
      "pending",
      JSON.stringify(pending),
    );
    paid = true;
    await service.syncAccount(owner);
    const completed = await store.page("testnet", owner),
      event = completed.events.find((e) => e.kind === "option_exercise");
    assert.equal(
      completed.coverage.historyComplete,
      true,
      JSON.stringify(completed.coverage),
    );
    assert.equal(
      event?.settlement?.optionLifecycle?.payout.status,
      "completed",
      JSON.stringify(completed),
    );
    assert.notEqual(
      completed.coverage.generation,
      pending.coverage.generation,
      "vault dependency changes a quiet holder projection",
    );
    assert(
      completed.coverage.relatedAccounts?.some(
        (a) => a.account === series && a.historyComplete,
      ),
    );
    assert(
      completed.coverage.relatedAccounts?.some(
        (a) => a.account === vaultWallet && a.historyComplete,
      ),
    );
    const count = async () =>
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM ledger_runs)::text AS runs,(SELECT count(*) FROM ledger_membership)::text AS members,(SELECT count(*) FROM ledger_projection_events)::text AS events",
        )
      ).rows;
    const before = await count();
    await service.syncAccount(owner);
    assert.deepEqual(
      await count(),
      before,
      "unchanged complete dependencies reuse one immutable projection",
    );
    assert.deepEqual(
      (await store.page("testnet", owner)).events,
      completed.events,
    );
    await pool.query("DELETE FROM ledger_account_states");
    await service.syncAccount(owner);
    assert.deepEqual(
      (await store.page("testnet", owner)).events,
      completed.events,
      "cold archive reconstruction preserves already exercised/deleted position",
    );
    wrongVaultCode = true;
    await service.syncAccount(owner);
    const unsupported = await store.page("testnet", owner);
    assert(
      unsupported.coverage.issues.includes(
        "option_factory_identity_unresolved",
      ),
    );
    assert(
      !unsupported.events.some(
        (e) => e.settlement?.optionLifecycle?.payout.status === "completed",
      ),
    );
    assert(
      unsupported.events.some((e) =>
        e.issues.includes("option_identity_or_cash_settlement_unverified"),
      ),
    );
  } finally {
    await service.stop();
    await pool.end();
  }
}
export function testFactoryState() {
  const empty = readOptionFactoryConfig(boc(factoryData(null)));
  assert.equal(empty.series.size, 0);
  assert.equal(empty.seriesBuyIndex.size, 0);
  assert.equal(empty.positions.size, 0);
  const seriesId = (1n << 62n) + 7n,
    tokenId = (1n << 53n) + 3n,
    wire = (1n << 63n) + 13n,
    key = (seriesId << 64n) | tokenId,
    value = factorySeries({
      seriesId,
      kind: 2,
      templateId: 4294967295,
      expiry: (1n << 53n) + 11n,
      maxNotional: (1n << 116n) + 23n,
      premiumBps: 101,
      collateralMultiplierBps: 12345,
      strikeBps: 9876,
      openNotional: (1n << 113n) + 31n,
      collateralLocked: (1n << 115n) + 17n,
      status: 4,
      settlementTimestamp: -((1n << 53n) + 19n),
      nextTokenId: tokenId,
      correlationScaleBps: 10007,
      correlationBps: -2345,
      correlationDispersionBps: 51,
      correlationTimestamp: -((1n << 54n) + 29n),
      optionAddress: other,
      underlyingPool: owner,
      quotePool: vault,
      activationWireId: wire + 1n,
      activationRequestHash: "1".repeat(64),
      configHash: "2".repeat(64),
    }),
    source = factoryData(position(), [], 0n, undefined, {
      series: [factorySeries(), value],
      seriesBuyIndex: [[55n, (7n << 64n) | 3n], [wire, key]],
    }),
    read = readOptionFactoryConfig(boc(source)),
    parsed = read.series.get(seriesId.toString())!;
  assert.equal(read.positions.size, 1, "existing position state remains readable");
  assert.equal(read.series.size, 2);
  assert.equal(read.series.get("7")!.kind, 1);
  assert.equal(read.series.get("7")!.optionAddress, series);
  assert.equal(read.seriesBuyIndex.get(55n), (7n << 64n) | 3n);
  assert.equal(read.seriesBuyIndex.get(wire), key);
  assert.equal(read.seriesBuyIndex.get(wire + 1n), undefined);
  const { stateHash, ...fields } = parsed;
  assert.deepEqual(fields, {
    templateId: 4294967295,
    kind: 2,
    expiry: ((1n << 53n) + 11n).toString(),
    maxNotionalRaw: ((1n << 116n) + 23n).toString(),
    premiumBps: 101,
    collateralMultiplierBps: 12345,
    strikeBps: 9876,
    openNotionalRaw: ((1n << 113n) + 31n).toString(),
    collateralLockedRaw: ((1n << 115n) + 17n).toString(),
    status: 4,
    settlementTimestamp: (-((1n << 53n) + 19n)).toString(),
    nextTokenId: tokenId.toString(),
    correlationScaleBps: 10007,
    correlationBps: -2345,
    correlationDispersionBps: 51,
    correlationTimestamp: (-((1n << 54n) + 29n)).toString(),
    correlationConfigHash: value.correlationConfig.hash().toString("hex"),
    optionAddress: other,
    underlyingPool: owner,
    quotePool: vault,
    activationWireId: (wire + 1n).toString(),
    activationRequestHash: "1".repeat(64),
    configHash: "2".repeat(64),
  });
  const rawSeries = source.refs[1]!.refs[2]!.beginParse().loadDict(
    Dictionary.Keys.BigUint(64), inline,
  );
  assert.equal(stateHash, rawSeries.get(seriesId)!.hash().toString("hex"));
  const nullable = readOptionFactoryConfig(boc(factoryData(null, [], 0n, undefined, {
    series: [factorySeries({
      kind: 65535, optionAddress: null, underlyingPool: null, quotePool: null,
      openNotional: 0n, collateralLocked: 0n,
    })],
  }))).series.get("7")!;
  assert.equal(nullable.kind, 65535, "parser preserves unsupported kind for qualification to reject");
  assert.equal(nullable.optionAddress, null, "no deployed address is fabricated");
  assert.equal(nullable.underlyingPool, null);
  assert.equal(nullable.quotePool, null);
  assert.equal(nullable.openNotionalRaw, "0");
  assert.equal(nullable.collateralLockedRaw, "0");

  // Preserve unrelated capacity and buy wires across allocation and exact unwind.
  const capacityState = (allocated: boolean) => readOptionFactoryConfig(boc(factoryData(
    null, [], 0n, undefined, {
      series: [factorySeries({
        openNotional: 111n + (allocated ? notional : 0n),
        collateralLocked: 222n + (allocated ? collateral : 0n),
        nextTokenId: allocated ? 4n : 3n,
      }), value],
      seriesBuyIndex: allocated ? [[wire, key], [55n, (7n << 64n) | 3n]] : [[wire, key]],
    },
  ))),
    before = capacityState(false),
    allocated = capacityState(true),
    unwound = readOptionFactoryConfig(boc(factoryData(null, [], 0n, undefined, {
      series: [factorySeries({openNotional: 111n, collateralLocked: 222n, nextTokenId: 4n}), value],
      seriesBuyIndex: [[wire, key]],
    })));
  for (const field of ["openNotionalRaw", "collateralLockedRaw"] as const) {
    const principal = field === "openNotionalRaw" ? notional : collateral;
    assert.equal(BigInt(allocated.series.get("7")![field]) - BigInt(before.series.get("7")![field]), principal);
    assert.equal(BigInt(allocated.series.get("7")![field]) - BigInt(unwound.series.get("7")![field]), principal);
  }
  assert.equal(allocated.seriesBuyIndex.get(55n), (7n << 64n) | 3n);
  assert.equal(unwound.seriesBuyIndex.get(55n), undefined);
  assert.equal(unwound.seriesBuyIndex.get(wire), key);
  assert.deepEqual(before.series.get(seriesId.toString()), unwound.series.get(seriesId.toString()));
  assert.equal(unwound.series.get("7")!.nextTokenId, "4", "unwind does not recycle a token ID");
  assert.notEqual(before.series.get("7")!.stateHash, allocated.series.get("7")!.stateHash);
  assert.notEqual(allocated.series.get("7")!.stateHash, unwound.series.get("7")!.stateHash);

  const replace = (cell: Cell, path: number[], mutate: (c: Cell) => Cell): Cell => {
    if (!path.length) return mutate(cell);
    const [index, ...rest] = path,
      builder = beginCell().storeBits(cell.bits);
    cell.refs.forEach((ref, i) => builder.storeRef(i === index ? replace(ref, rest, mutate) : ref));
    return builder.endCell();
  };
  const appendBit = (cell: Cell) => beginCell().storeSlice(cell.beginParse()).storeBit(true).endCell();
  const appendRef = (cell: Cell) => beginCell().storeSlice(cell.beginParse()).storeRef(Cell.EMPTY).endCell();
  const negatives: Array<[string, Cell]> = [];
  for (const [label, path] of [
    ["map bundle", [1]],
    ["series dictionary", [1, 2]],
    ["oracle bundle", [0, 3]],
    ["series auxiliary", [0, 3, 3]],
    ["buy index dictionary", [0, 3, 3, 2]],
  ] as Array<[string, number[]]>) {
    negatives.push([`missing ${label}`, replace(source, path, () => Cell.EMPTY)]);
    negatives.push([`trailing ${label} bits`, replace(source, path, appendBit)]);
  }
  for (const [label, path] of [
    ["map bundle", [1]],
    ["series dictionary", [1, 2]],
    ["series auxiliary", [0, 3, 3]],
    ["buy index dictionary", [0, 3, 3, 2]],
  ] as Array<[string, number[]]>)
    negatives.push([`trailing ${label} reference`, replace(source, path, appendRef)]);
  const alterSeries = (mutate: (c: Cell) => Cell) => replace(source, [1, 2], (cell) => {
    const entries = cell.beginParse().loadDict(Dictionary.Keys.BigUint(64), inline);
    entries.set(seriesId, mutate(entries.get(seriesId)!));
    return beginCell().storeDict(entries).endCell();
  });
  negatives.push(["trailing persisted series bits", alterSeries(appendBit)]);
  negatives.push(["trailing persisted series reference", alterSeries(appendRef)]);
  for (const [label, ref] of [["correlation", 0], ["addresses", 1], ["activation", 2]] as const) {
    negatives.push([`missing ${label} fields`, alterSeries((c) => replace(c, [ref], () => Cell.EMPTY))]);
    negatives.push([`trailing ${label} bits`, alterSeries((c) => replace(c, [ref], appendBit))]);
    negatives.push([`trailing ${label} reference`, alterSeries((c) => replace(c, [ref], appendRef))]);
  }
  for (const bits of [127, 129]) {
    const wrongWidth = Dictionary.empty(Dictionary.Keys.BigUint(64), inline);
    wrongWidth.set(wire, beginCell().storeUint(key, bits).endCell());
    negatives.push([`buy index value width ${bits}`, replace(source, [0, 3, 3, 2], () => beginCell().storeDict(wrongWidth).endCell())]);
  }
  const referencedSeries = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  referencedSeries.set(seriesId, rawSeries.get(seriesId)!);
  negatives.push(["noncanonical referenced series values", replace(source, [1, 2], () => beginCell().storeDict(referencedSeries).endCell())]);
  const prune = (cell: Cell) => beginCell()
    .storeUint(1, 8)
    .storeUint(1, 8)
    .storeBuffer(cell.hash())
    .storeUint(cell.depth(), 16)
    .endCell({ exotic: true });
  for (const [label, path] of [
    ["series", [1, 2]],
    ["buy index", [0, 3, 3, 2]],
  ] as Array<[string, number[]]>) {
    negatives.push([`pruned ${label} root`, replace(source, [...path, 0], prune)]);
    negatives.push([`pruned ${label} branch`, replace(source, [...path, 0, 0], prune)]);
  }
  const factoryPositions = source.refs[2]!.beginParse().loadDict(Dictionary.Keys.BigUint(128), inline);
  factoryPositions.set((7n << 64n) | 4n, factoryPositions.get((7n << 64n) | 3n)!);
  const withFactoryPositions = replace(source, [2], () => beginCell().storeDict(factoryPositions).endCell());
  negatives.push(["pruned factory position root cannot prove absence", replace(withFactoryPositions, [2, 0], prune)]);
  negatives.push(["pruned factory position branch cannot prove absence", replace(withFactoryPositions, [2, 0, 0], prune)]);
  for (const [label, corrupt] of negatives)
    assert.throws(() => readOptionFactoryConfig(boc(corrupt)), label);
  for (const kind of [1, 2] as const) {
    assert.equal(readOptionProductState(boc(productData(kind, false, 0n, owner, "absent")), kind, "3").position, null);
    const data = productData(kind, false),
      positions = data.refs[2]!.beginParse().loadDict(Dictionary.Keys.BigUint(64), inline);
    positions.set(4n, positions.get(3n)!);
    const withPositions = replace(data, [2], () => beginCell().storeDict(positions).endCell());
    for (const path of [[2, 0], [2, 0, 0]])
      for (const target of ["3", "999"])
        assert.throws(() => readOptionProductState(boc(replace(withPositions, path, prune)), kind, target),
          `kind ${kind} pruned product positions cannot prove present/absent target ${target}`);
  }
  console.log(`factory current-state parsing, exact capacity allocation/unwind, ${negatives.length} factory corruption and 8 product-pruning cases passed`);
}
async function main() {
  testFactoryState();
  for (const kind of [1, 2] as const) {
    const f = exercise(kind),
      events = (await projectOwnerLedger(f.input)).events,
      event = events.find((e) => e.kind === "option_exercise");
    assert.equal(
      event?.settlement?.status,
      "confirmed",
      JSON.stringify(events),
    );
    assert.equal(event.settlement.optionLifecycle?.payout.status, "completed");
    assert.equal(
      event.settlement.optionLifecycle?.payout.amountRaw,
      payout.toString(),
    );
    assert.equal(
      event.movements.filter((m) => m.purpose === "option_payout").length,
      1,
    );
    assert.equal(
      event.movements.find((m) => m.purpose === "option_payout")?.amountRaw,
      payout.toString(),
    );
    assert.equal(
      event.movements.find((m) => m.purpose === "option_right_retired")
        ?.amountRaw,
      "1",
    );
    assert.equal(
      event.movements.find((m) => m.purpose === "option_payout")?.evidence.kind,
      "option_payout",
    );
    assert.equal(
      event.settlement.optionLifecycle?.collateralLiabilityReleasedRaw,
      (collateral - payout).toString(),
    );
    assert.equal(
      event.settlement.optionLifecycle?.premiumAccountingReleasedRaw,
      "500",
    );
    assert.equal(
      event.movements.filter((m) => m.asset.kind === "jetton").length,
      1,
      "liability and premium changes do not create extra token transfers",
    );
    assert.equal(
      event.movements
        .filter((m) => m.evidence.kind === "transaction_fee")
        .reduce((s, m) => s + BigInt(m.amountRaw), 0n)
        .toString(),
      event.totalFeesRaw,
    );
    assert(
      event.settlement.optionLifecycle?.localNetworkFees.some(
        (fee) => !fee.includedInOwnerFeeMovements,
      ),
      "counterparty costs are evidence, not another owner debit",
    );
    assert.equal(
      event.settlement.queryId,
      undefined,
      "exercise has no user query ID",
    );
    assert.equal(
      event.settlement.optionLifecycle?.requestEvidence?.stateBeforeHash,
      event.settlement.optionLifecycle?.beforePosition?.dataHash,
    );
    assert.equal(
      event.settlement.optionLifecycle?.productEvidence?.stateBeforeHash,
      event.settlement.optionLifecycle?.productBefore?.dataHash,
    );
    assert.deepEqual(event.issues, []);
  }
  const zeroPayout = await exerciseEvent(exercise(1, 0n));
  assert.equal(zeroPayout.settlement?.status, "confirmed");
  assert.equal(zeroPayout.settlement?.optionLifecycle?.payout.status, "none");
  assert(
    !zeroPayout.movements.some((m) => m.asset.kind === "jetton"),
    "zero payout retires only a right; ReleaseCollateral is not cash",
  );
  const computed = exercise();
  computed.original.body = boc(
    beginCell()
      .storeUint(OPTION_EXERCISE, 32)
      .storeUint(7, 64)
      .storeUint(3, 64)
      .storeAddress(A(owner))
      .storeCoins(1)
      .storeCoins(500)
      .endCell(),
  );
  computed.start.outMessages[0].body = boc(
    beginCell()
      .storeUint(OPTION_SHOUT_EXERCISE, 32)
      .storeUint(3, 64)
      .storeCoins(1)
      .storeAddress(A(owner))
      .storeCoins(500)
      .storeAddress(A(owner))
      .endCell(),
  );
  const computedEvent = await exerciseEvent(computed);
  assert.equal(
    computedEvent.settlement?.optionLifecycle?.requestedPayoutRaw,
    "1",
  );
  assert.equal(
    computedEvent.settlement?.optionLifecycle?.payout.amountRaw,
    payout.toString(),
    "Shout actual payout comes from the qualified product callback, never the caller hint",
  );
  const ready = await exerciseEvent(exercise(1, payout, false));
  assert.equal(
    ready.settlement?.status,
    "confirmed",
    "completed right retirement is independent from queued cash",
  );
  assert.equal(ready.settlement?.optionLifecycle?.payout.status, "pending");
  assert(ready.issues.includes("option_payout_settlement_pending"));
  assert(!ready.movements.some((m) => m.purpose === "option_payout"));
  const recipient = exercise(1, payout, true, other),
    holderEvent = await exerciseEvent(recipient);
  assert.equal(
    holderEvent.settlement?.optionLifecycle?.payout.status,
    "completed",
  );
  assert(
    !holderEvent.movements.some((m) => m.asset.kind === "jetton"),
    "third-party payout is not the holder credit",
  );
  recipient.input.owner = other;
  const recipientEvent = await exerciseEvent(recipient);
  assert.equal(recipientEvent.settlement?.optionLifecycle?.owner, owner);
  assert.equal(
    recipientEvent.movements.filter((m) => m.purpose === "option_payout")
      .length,
    1,
  );
  assert(
    !recipientEvent.movements.some((m) => m.purpose === "option_right_retired"),
    "recipient never inherits the holder right",
  );
  for (const mutate of [
    (f: ReturnType<typeof exercise>) => {
      f.input.stateAt = async () => null;
    },
    (f: ReturnType<typeof exercise>) => {
      f.input.optionFactories!.get(factory)!.qualification = undefined;
    },
    (f: ReturnType<typeof exercise>) => {
      f.input.chains.get(series)!.historyComplete = false;
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${factory}:${f.start.prevTransactionLt}`)!.data =
        factoryData(position({ owner: other }));
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${factory}:${f.start.prevTransactionLt}`)!.code =
        Cell.EMPTY;
    },
    (f: ReturnType<typeof exercise>) => {
      const t = f.input.chains.get(series)!.transactions.at(-1)!;
      f.states.get(`${series}:${t.prevTransactionLt}`)!.data = productData(
        1,
        false,
        payout,
        other,
      );
    },
    (f: ReturnType<typeof exercise>) => {
      f.input.chains.get(series)!.transactions.at(-1)!.success = false;
    },
    (f: ReturnType<typeof exercise>) => {
      f.input.chains.get(factory)!.transactions.at(-1)!.inMessage!.createdLt =
        undefined;
    },
  ]) {
    const f = exercise();
    mutate(f);
    const e = await exerciseEvent(f);
    assert.notEqual(e?.settlement?.status, "confirmed");
    assert(!e?.movements.some((m) => m.purpose === "option_right_retired"));
  }
  for (const mutate of [
    (f: ReturnType<typeof exercise>) => {
      f.payment!.terminal.success = false;
    },
    (f: ReturnType<typeof exercise>) => {
      f.payment!.finalized.createdLt = undefined;
    },
    (f: ReturnType<typeof exercise>) => {
      f.payment!.finalized.body = boc(
        beginCell()
          .storeUint(0x4a53464b, 32)
          .storeUint(92, 64)
          .storeCoins(payout)
          .storeAddress(A(ownerWallet))
          .endCell(),
      );
    },
    (f: ReturnType<typeof exercise>) => {
      f.payment!.finalized.bounced = true;
    },
    (f: ReturnType<typeof exercise>) => {
      f.input.chains.get(vaultWallet)!.historyComplete = false;
    },
    (f: ReturnType<typeof exercise>) => {
      f.input.wallets.get(ownerWallet)!.master = other;
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${vault}:${f.payment!.terminal.lt}`)!.data = vaultData(
        { ...f.entry, status: 4, amount: payout + 1n },
        true,
      );
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${vault}:${f.payment!.terminal.lt}`)!.data = vaultData(
        { ...f.entry, status: 4, requestHash: "11".repeat(32) },
        true,
      );
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${vault}:${f.payment!.terminal.lt}`)!.data = vaultData(
        { ...f.entry, status: 4, recipient: other },
        true,
      );
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${vault}:${f.payment!.terminal.lt}`)!.data = vaultData(
        { ...f.entry, status: 4, wire: 92n },
        true,
      );
    },
    (f: ReturnType<typeof exercise>) => {
      f.states.get(`${vault}:${f.payment!.terminal.lt}`)!.data = vaultData(
        { ...f.entry, status: 4 },
        false,
      );
    },
  ]) {
    const f = exercise();
    mutate(f);
    const events = (await projectOwnerLedger(f.input)).events;
    assert(
      !events.some(
        (e) => e.settlement?.optionLifecycle?.payout.status === "completed",
      ),
    );
    assert(
      !events
        .flatMap((e) => e.movements)
        .some((m) => m.purpose === "option_payout"),
    );
  }
  const risk = exercise();
  risk.states.get(`${vault}:${risk.payment!.terminal.lt}`)!.data = vaultData(
    { ...risk.entry, status: 4, risk: 99n },
    true,
  );
  const riskEvent = await exerciseEvent(risk);
  assert.equal(
    riskEvent.settlement?.optionLifecycle?.payout.status,
    "completed",
  );
  assert.equal(
    riskEvent.settlement?.optionLifecycle?.protocolAccounting.status,
    "unverified",
    "risk FINAL metadata is not authenticated reimbursement cash",
  );
  for (const kind of [1, 3] as const) {
    const f = refund(kind),
      events = (await projectOwnerLedger(f.input)).events,
      event = events.find((e) => e.kind === "option_refund");
    assert.equal(
      event?.settlement?.status,
      "confirmed",
      JSON.stringify(events),
    );
    assert.equal(
      event.settlement.optionLifecycle?.refund?.kind,
      kind === 1 ? "ingress" : "excess",
    );
    assert.equal(
      event.settlement.optionLifecycle?.payout.amountRaw,
      payout.toString(),
    );
    assert.equal(
      event.movements.find((m) => m.purpose === "option_refund")?.evidence.kind,
      "option_refund",
    );
    assert.equal(
      event.movements.filter((m) => m.purpose === "option_refund").length,
      1,
    );
    const net = event.movements
      .filter((m) => m.asset.kind === "jetton")
      .reduce(
        (s, m) => s + (m.direction === "in" ? 1n : -1n) * BigInt(m.amountRaw),
        0n,
      );
    assert.equal(
      net,
      kind === 1 ? 0n : payout,
      "full ingress return and excess conserve exact owned tokens",
    );
    assert.equal(
      event.settlement.queryId,
      kind === 1 ? "9007199254741017" : undefined,
    );
    const pending = (await projectOwnerLedger(refund(kind, false).input)).events;
    assert(
      !pending.some((e) => e.kind === "option_refund"),
      "the early queued OCRC receipt cannot confirm payment",
    );
  }
  for (const mutate of [
    (f: ReturnType<typeof refund>) => {
      f.input.stateAt = async () => null;
    },
    (f: ReturnType<typeof refund>) => {
      f.input.chains.get(factoryWallet)!.historyComplete = false;
    },
    (f: ReturnType<typeof refund>) => {
      f.payment!.terminal.success = false;
    },
    (f: ReturnType<typeof refund>) => {
      f.payment!.terminal.outMessages = [];
    },
    (f: ReturnType<typeof refund>) => {
      f.states.get(`${factory}:${f.payment!.terminal.lt}`)!.data = factoryData(
        f.p,
      );
    },
    (f: ReturnType<typeof refund>) => {
      f.states.get(
        `${factory}:${f.payment!.terminal.prevTransactionLt}`,
      )!.data = factoryData(
        f.p,
        [{ ...f.claim, status: 3, finalWire: 92n }],
        f.claim.id,
      );
    },
    (f: ReturnType<typeof refund>) => {
      f.states.get(`${factory}:${f.dispatch.lt}`)!.data = factoryData(
        f.p,
        [{ ...f.claim, owner: other }],
        f.claim.id,
      );
    },
    (f: ReturnType<typeof refund>) => {
      f.states.get(`${factory}:${f.dispatch.lt}`)!.data = factoryData(
        f.p,
        [{ ...f.claim, amount: payout + 1n }],
        f.claim.id,
      );
    },
  ]) {
    const f = refund();
    mutate(f);
    const events = (await projectOwnerLedger(f.input)).events;
    assert(!events.some((e) => e.kind === "option_refund"));
    assert(
      !events
        .flatMap((e) => e.movements)
        .some((m) => m.purpose === "option_refund"),
    );
    assert(
      events.some((e) =>
        e.issues.includes("option_identity_or_cash_settlement_unverified"),
      ),
      "known protocol cash stays unresolved when its terminal evidence is absent",
    );
  }
  assert.equal(parseLedgerOptionsCodeHashes(undefined), undefined);
  assert.equal(parseLedgerOptionsCodeHashes("  "), undefined);
  assert.deepEqual(parseLedgerOptionsCodeHashes(JSON.stringify(q)), q);
  for (const bad of [
    {},
    { ...q, extra: "x" },
    { ...q, walletCodeHash: "ABC".repeat(21) + "A" },
    { ...q, factoryCodeHash: undefined },
  ])
    assert.throws(() => parseLedgerOptionsCodeHashes(JSON.stringify(bad)));
  const replay = exercise(),
    originalEvents = (await projectOwnerLedger(replay.input)).events;
  const again = replay.msg(
    owner,
    factory,
    Cell.fromBase64(replay.original.body!),
  );
  replay.tx(owner, undefined, [again]);
  replay.tx(factory, again, [], {
    code: factoryCode,
    data: factoryData(
      position({ premium: premium - 500n, collateral: 0n, settled: true }),
    ),
  });
  const replayed = (await projectOwnerLedger(replay.input)).events;
  assert.equal(
    replayed
      .flatMap((e) => e.movements)
      .filter((m) => m.purpose === "option_right_retired").length,
    1,
    "replayed exercise cannot retire another right",
  );
  assert.deepEqual(
    replayed
      .flatMap((e) => e.movements)
      .filter((m) => m.purpose === "option_payout"),
    originalEvents
      .flatMap((e) => e.movements)
      .filter((m) => m.purpose === "option_payout"),
    "replayed request does not attribute the prior payout again",
  );
  await durableLifecycle();
  console.log(
    "option lifecycle historical right retirement and actual payout tests passed",
  );
}
export {
  A,
  owner,
  other,
  factory,
  vault,
  root,
  series,
  wallet,
  ownerWallet,
  factoryWallet,
  vaultWallet,
  factoryCode,
  vaultCode,
  shoutCode,
  spreadCode,
  walletCode,
  notional,
  premium,
  collateral,
  payout,
  q,
  boc,
  position,
  factorySeries,
  factoryData,
  productData,
  entry,
  vaultData,
  fixture,
  cash,
  exercise,
  refund,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
