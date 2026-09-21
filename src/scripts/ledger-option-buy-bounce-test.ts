import assert from "node:assert/strict";
import { beginCell, Cell, Dictionary } from "@ton/core";
import type { RawTransaction } from "../data/dataSource";
import { projectOwnerLedger } from "../ledger/project";
import { readOptionFactoryConfig } from "../ledger/optionLifecycleState";
import { readOptionPositionState } from "../ledger/optionState";
import { durableOptionAbort } from "./ledger-option-abort-store-test";
import { TRANSFER, INTERNAL, NOTIFY, tokenWire } from "../ledger/wire";
import {
  OPTION_FACTORY_BUY,
  OPTION_BUY_SHOUT,
  OPTION_BUY_SPREAD,
} from "../ledger/options";
import {
  A, owner, other, factory, series, ownerWallet, factoryWallet,
  factoryCode, shoutCode, spreadCode, notional, premium, collateral,
  boc, position, factoryData, factorySeries, productData, fixture, cash,
  type FactoryStateFixture, acceptedIngressState,
} from "./ledger-option-lifecycle-test";

/** Actual physical funding and failed product transaction emitting the bounded
 * VM bounce. No owner abort or product cancellation request/ACK is inserted. */
export function bounceFixture(kind: 1 | 2 = 1, paid = true) {
  const f = fixture(),
    amount = premium + 20n,
    key = (7n << 64n) | 3n,
    refundWire = 56n,
    p = position({
      flags: 0n, custodyWire: 55n, excess: 0n, walletFunding: 360000000n,
    }),
    productCode = kind === 1 ? shoutCode : spreadCode,
    beforeSeries = factorySeries({kind, openNotional: 0n, collateralLocked: 0n, nextTokenId: 3n}),
    allocatedSeries = factorySeries({kind}),
    unwoundSeries = factorySeries({kind, openNotional: 0n, collateralLocked: 0n});
  f.input.optionFactories!.get(factory)!.series.get("7")!.kind = kind;
  const initialFactory = f.tx(factory, undefined, [], {
    code: factoryCode,
    data: factoryData(null, [], 0n, undefined, {
      series: [beforeSeries], nextBuyWireId: 55n,
    }),
  });
  f.tx(series, undefined, [], {
    code: productCode, data: productData(kind, false, 0n, owner, "absent"),
  });
  const payload = beginCell()
    .storeUint(OPTION_FACTORY_BUY, 32).storeUint(7, 64).storeAddress(A(owner))
    .storeCoins(notional).storeCoins(premium + 20n).storeUint(10000, 32).storeAddress(null).endCell();
  const request = f.msg(owner, ownerWallet, beginCell()
    .storeUint(TRANSFER, 32).storeUint(1234, 64).storeCoins(amount)
    .storeAddress(A(factory)).storeAddress(A(owner)).storeRef(Cell.EMPTY)
    .storeCoins(1).storeRef(payload).endCell());
  const internal = f.msg(ownerWallet, factoryWallet, beginCell()
    .storeUint(INTERNAL, 32).storeUint(1234, 64).storeCoins(amount)
    .storeAddress(A(owner)).storeAddress(A(owner)).storeCoins(1)
    .storeRef(payload).endCell());
  const notify = f.msg(factoryWallet, factory, beginCell()
    .storeUint(NOTIFY, 32).storeUint(1234, 64).storeCoins(amount)
    .storeAddress(A(owner)).storeAddress(A(ownerWallet)).storeCoins(1)
    .storeRef(payload).endCell());
  const ingressState = acceptedIngressState(notify);
  const assigned = f.msg(factory, series, beginCell()
    .storeUint(kind === 1 ? OPTION_BUY_SHOUT : OPTION_BUY_SPREAD, 32)
    .storeUint(55, 64).storeAddress(A(owner)).storeUint(3, 64)
    .storeCoins(notional).storeCoins(premium).storeCoins(collateral).endCell());
  f.tx(owner, undefined, [request]);
  f.tx(ownerWallet, request, [internal]);
  f.tx(factoryWallet, internal, [notify]);
  const origin = f.tx(factory, notify, [assigned], {
    code: factoryCode,
    data: factoryData(p, [], 0n, undefined, {
      ...ingressState, series: [allocatedSeries], seriesBuyIndex: [[55n, key]], nextBuyWireId: 56n,
    }),
  });
  const bounce = f.msg(series, factory, beginCell().storeUint(0xffffffff, 32)
    .storeBits(Cell.fromBase64(assigned.body!).beginParse().loadBits(256)).endCell());
  bounce.bounced = true;
  const failed = f.tx(series, assigned, [bounce], {
    code: productCode, data: productData(kind, false, 0n, owner, "absent"),
  });
  failed.success = false;
  failed.status = "failed";
  const returnPosition = {...p, flags: 112n, settled: true, refundWire, walletFunding: 220000000n};
  const recovery = f.tx(factory, bounce, [], {
    code: factoryCode,
    data: factoryData(returnPosition, [], key, undefined, {
      ...ingressState, series: [unwoundSeries], nextBuyWireId: 57n,
    }),
  });
  const payment = cash(f, factory, recovery, owner, amount, refundWire,
    factoryData({...returnPosition, flags: 8304n, walletFunding: 180000000n}, [], key, undefined, {
      ...ingressState, series: [unwoundSeries], nextBuyWireId: 57n,
    }),
    factoryData({...returnPosition, flags: 176n, walletFunding: 0n}, [], 0n, undefined, {
      ...ingressState, series: [unwoundSeries], nextBuyWireId: 57n,
    }),
  );
  if (!paid) {
    // The transfer was dispatched, but this snapshot has no recipient credit
    // or later acknowledgment/finalization. No terminal state is fabricated.
    for (const [account, chain] of f.input.chains) {
      for (const transaction of chain.transactions)
        if (BigInt(transaction.lt) >= BigInt(payment.creditTx.lt))
          f.states.delete(`${account}:${transaction.lt}`);
      chain.transactions = chain.transactions.filter((t) => BigInt(t.lt) < BigInt(payment.creditTx.lt));
    }
  }
  return {
    ...f, kind, paid, amount, key, refundWire, p, returnPosition,
    beforeSeries, allocatedSeries, unwoundSeries, initialFactory,
    request, payload, assigned, origin, failed, bounce, recovery, ingressState,
    factoryPayment: paid ? payment : undefined,
    cashSource: payment.sourceTx, cashTransfer: payment.transfer,
  };
}

type BounceFixture = ReturnType<typeof bounceFixture>;
const bounceEvent = async (f: BounceFixture) => {
  const events = (await projectOwnerLedger(f.input)).events;
  return { events, event: events.find((e) =>
    e.settlement?.optionLifecycle?.refund?.unwind?.trigger.kind === "initial_series_buy_bounced") };
};
const factoryState = (f: BounceFixture, lt: string) =>
  readOptionFactoryConfig(boc(f.states.get(`${factory}:${lt}`)!.data));
const factoryPosition = (f: BounceFixture, lt: string) =>
  readOptionPositionState(boc(f.states.get(`${factory}:${lt}`)!.data), "7", "3")!;

function rewriteFactory(f: BounceFixture, stage: "initial" | "origin" | "recovery", changes: {
  position?: ReturnType<typeof position> | null;
  active?: bigint;
  state?: FactoryStateFixture;
}) {
  const defaults = stage === "initial"
    ? { tx: f.initialFactory, p: null, active: 0n, state: {series: [f.beforeSeries], nextBuyWireId: 55n} }
    : stage === "origin"
      ? { tx: f.origin, p: f.p, active: 0n, state: {...f.ingressState, series: [f.allocatedSeries], seriesBuyIndex: [[55n, f.key]] as Array<[bigint, bigint]>, nextBuyWireId: 56n} }
      : { tx: f.recovery, p: f.returnPosition, active: f.key, state: {...f.ingressState, series: [f.unwoundSeries], nextBuyWireId: 57n} };
  f.states.get(`${factory}:${defaults.tx.lt}`)!.data = factoryData(
    changes.position === undefined ? defaults.p : changes.position,
    [], changes.active ?? defaults.active, undefined, {...defaults.state, ...changes.state},
  );
}

function insertBeforeRecovery(f: BounceFixture, data: Cell) {
  // A distinct archived factory boundary between allocation and recovery. This
  // isolates recovery accounting from the already-proved original allocation.
  const tx: RawTransaction = {
    ...f.failed, success: true, status: "success", inMessage: undefined, outMessages: [],
    prevTransactionLt: f.origin.lt, prevTransactionHash: f.origin.hash,
  };
  const chain = f.input.chains.get(factory)!;
  chain.transactions.splice(chain.transactions.indexOf(f.recovery), 0, tx);
  f.states.set(`${factory}:${tx.lt}`, {code: factoryCode, data});
  f.recovery.prevTransactionLt = tx.lt;
  f.recovery.prevTransactionHash = tx.hash;
  return tx;
}

function occupiedFactoryFixture(kind: 1 | 2, wire: bigint) {
  const f = bounceFixture(kind, false), otherKey = (7n << 64n) | 2n,
    own = {...f.p, custodyWire: wire},
    foreign = position({owner: other, custodyWire: 44n, flags: 2n, walletFunding: 220000000n}),
    inline = {serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()), parse: (s: any) => s.asCell()};
  // The foreign position already owns the wallet controller, so this bounce
  // can cancel/unwind but cannot start a refund or allocate another wire.
  f.recovery.outMessages = [];
  for (const [account, chain] of f.input.chains) {
    for (const t of chain.transactions) if (BigInt(t.lt) > BigInt(f.recovery.lt)) f.states.delete(`${account}:${t.lt}`);
    chain.transactions = chain.transactions.filter((t) => BigInt(t.lt) <= BigInt(f.recovery.lt));
  }
  const assigned = Cell.fromBase64(f.assigned.body!).beginParse();
  const opcode = assigned.loadUint(32); assigned.loadUintBig(64);
  f.assigned.body = boc(beginCell().storeUint(opcode, 32).storeUint(wire, 64).storeSlice(assigned).endCell());
  f.bounce.body = boc(beginCell().storeUint(0xffffffff, 32)
    .storeBits(Cell.fromBase64(f.assigned.body).beginParse().loadBits(256)).endCell());
  const positionCell = (p: ReturnType<typeof position>, buyWire: bigint, refundOwner: string) => {
    const cell = factoryData(p).refs[2]!.beginParse().loadDict(Dictionary.Keys.BigUint(128), inline).get(f.key)!;
    return beginCell().storeBits(cell.bits).storeRef(beginCell()
      .storeAddress(A(refundOwner)).storeUint(buyWire, 64).storeUint(p.custodyWire, 64)
      .storeUint(p.refundWire, 64).storeCoins(20).storeCoins(p.excess).storeCoins(p.walletFunding)).endCell();
  };
  for (const stage of ["initial", "origin", "recovery"] as const) {
    const tx = stage === "initial" ? f.initialFactory : stage === "origin" ? f.origin : f.recovery,
      p = stage === "initial" ? null : stage === "origin" ? own : {...own, flags: 48n, settled: true},
      allocated = stage === "origin",
      data = factoryData(null, [], otherKey, undefined, {
        ...(stage === "initial" ? {} : f.ingressState),
        series: [factorySeries({kind,
          openNotional: notional * (allocated ? 2n : 1n),
          collateralLocked: collateral * (allocated ? 2n : 1n),
          nextTokenId: stage === "initial" ? 3n : 4n,
        })],
        seriesBuyIndex: allocated ? [[44n, otherKey], [wire, f.key]] : [[44n, otherKey]],
        nextBuyWireId: stage === "initial" ? wire : wire + 1n,
      }),
      positions = Dictionary.empty(Dictionary.Keys.BigUint(128), inline);
    positions.set(otherKey, positionCell(foreign, 44n, other));
    if (p) positions.set(f.key, positionCell(p, wire, owner));
    f.states.get(`${factory}:${tx.lt}`)!.data = beginCell().storeRef(data.refs[0]!).storeRef(data.refs[1]!)
      .storeRef(beginCell().storeDict(positions)).endCell();
  }
  return f;
}

async function reservedWireBoundary() {
  for (const kind of [1, 2] as const) {
    const control = occupiedFactoryFixture(kind, 55n), {event} = await bounceEvent(control);
    assert(event, `kind ${kind}: unrelated active position permits exact pending unwind`);
    assert.equal(event.settlement!.status, "incomplete");
    assert.equal(event.settlement!.optionLifecycle!.refund!.unwind!.cancellation.status, "completed");
    assert(!event.movements.some((m) => m.purpose === "option_refund"));
    const terminalWire = occupiedFactoryFixture(kind, 0xfffffffffffffffen);
    assert.equal((await bounceEvent(terminalWire)).event, undefined,
      `kind ${kind}: reserved terminal wire cannot be an authentic initial allocation`);
  }
  console.log("two occupied-wallet pending controls and two reserved-wire boundary rejections passed");
}

async function adverseCases() {
  const cases: Array<[string, (f: BounceFixture) => void]> = [
    ["missing actual emitted bounce", (f) => {f.failed.outMessages = [];}],
    ["successful product transaction cannot prove rejection", (f) => {f.failed.success = true; f.failed.status = "success";}],
    ["pending product transaction cannot prove rejection", (f) => {f.failed.status = "pending";}],
    ["failed-status/success inconsistency", (f) => {f.failed.success = true;}],
    ["non-bounced recovery input", (f) => {f.bounce.bounced = false;}],
    ["wrong bounce source", (f) => {f.bounce.source = other;}],
    ["wrong bounce destination", (f) => {f.bounce.destination = other;}],
    ["failed recovery transaction", (f) => {f.recovery.success = false; f.recovery.status = "failed";}],
    ["unavailable exact product archive", (f) => {f.states.delete(`${series}:${f.failed.lt}`);}],
    ["different product code", (f) => {f.states.get(`${series}:${f.failed.lt}`)!.code = Cell.EMPTY;}],
    ["failed product mutated state", (f) => {f.states.get(`${series}:${f.failed.lt}`)!.data = productData(f.kind, true, 0n, owner, "absent");}],
    ["failed product retained reserved position", (f) => {f.states.get(`${series}:${f.failed.lt}`)!.data = productData(f.kind, false, 0n, owner, "reserved");}],
    ["failed transaction hash not archived hash", (f) => {f.failed.hash = Buffer.alloc(32, 7).toString("base64");}],
    ["funding was never transferred", (f) => {f.input.chains.get(ownerWallet)!.transactions.find((t) => t.inMessage === f.request)!.outMessages = [];}],
    ["missing physical acceptance tombstone", (f) => rewriteFactory(f, "origin", {state: {physicalTombstones: []}})],
    ["missing logical acceptance receipt", (f) => rewriteFactory(f, "origin", {state: {ingressReceipts: []}})],
    ["preexisting accepted business cannot allocate twice", (f) => rewriteFactory(f, "initial", {state: f.ingressState})],
    ["previously refunded business cannot allocate", (f) => rewriteFactory(f, "initial", {state: {ingressReceipts: f.ingressState.ingressReceipts!.map((r) => ({...r, accepted: false}))}})],
    ["changed original notification created_lt", (f) => { f.origin.inMessage!.createdLt = String(BigInt(f.origin.inMessage!.createdLt!) + 1n); }],
    ["allocation missing index", (f) => rewriteFactory(f, "origin", {state: {seriesBuyIndex: []}})],
    ["allocation wrong indexed position", (f) => rewriteFactory(f, "origin", {state: {seriesBuyIndex: [[55n, f.key + 1n]]}})],
    ["allocation preexisting wire", (f) => rewriteFactory(f, "initial", {state: {seriesBuyIndex: [[55n, f.key]]}})],
    ["allocation incorrect open notional", (f) => rewriteFactory(f, "origin", {state: {series: [factorySeries({kind: f.kind, openNotional: notional + 1n})]}})],
    ["allocation incorrect collateral", (f) => rewriteFactory(f, "origin", {state: {series: [factorySeries({kind: f.kind, collateralLocked: collateral + 1n})]}})],
    ["allocation did not advance token ID", (f) => rewriteFactory(f, "origin", {state: {series: [factorySeries({kind: f.kind, nextTokenId: 3n})]}})],
    ["allocation changed active buy", (f) => rewriteFactory(f, "origin", {active: f.key})],
    ["allocation did not allocate exact wire", (f) => rewriteFactory(f, "initial", {state: {nextBuyWireId: 54n}})],
    ["allocation advanced wire incorrectly", (f) => rewriteFactory(f, "origin", {state: {nextBuyWireId: 57n}})],
    ["allocation invented wallet budget", (f) => rewriteFactory(f, "origin", {position: {...f.p, walletFunding: 360000001n}})],
    ["unacknowledged retry cannot consume stored wallet budget", (f) => {
      insertBeforeRecovery(f, factoryData({...f.p, walletFunding: 359000000n}, [], 0n, undefined, {
        series: [f.allocatedSeries], seriesBuyIndex: [[55n, f.key]], nextBuyWireId: 56n,
      }));
      rewriteFactory(f, "recovery", {position: {...f.returnPosition, walletFunding: 219000000n}});
    }],
    ["unwind did not clear index", (f) => rewriteFactory(f, "recovery", {state: {seriesBuyIndex: [[55n, f.key]]}})],
    ["unwind failed to release full notional", (f) => rewriteFactory(f, "recovery", {state: {series: [{...f.unwoundSeries, openNotional: 1n}]}})],
    ["unwind failed to release full collateral", (f) => rewriteFactory(f, "recovery", {state: {series: [{...f.unwoundSeries, collateralLocked: 1n}]}})],
    ["unwind recycled token ID", (f) => rewriteFactory(f, "recovery", {state: {series: [{...f.unwoundSeries, nextTokenId: 3n}]}})],
    ["unwind changed series identity", (f) => rewriteFactory(f, "recovery", {state: {series: [{...f.unwoundSeries, optionAddress: other}]}})],
    ["unwind changed immutable expiry", (f) => rewriteFactory(f, "recovery", {state: {series: [{...f.unwoundSeries, expiry: f.unwoundSeries.expiry + 1n}]}})],
    ["unwind changed owner", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, owner: other}})],
    ["unwind changed principal", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, collateral: collateral - 1n}})],
    ["unwind not settled", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, settled: false}})],
    ["unwind already acknowledged", (f) => rewriteFactory(f, "origin", {position: {...f.p, flags: 1n}})],
    ["unwind missing cancelled flag", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, flags: 80n}})],
    ["unwind invents refunded flag before cash", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, flags: 240n}})],
    ["unwind incorrect reserved wallet budget", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, walletFunding: 220000001n}})],
    ["unwind wrong refund wire", (f) => rewriteFactory(f, "recovery", {position: {...f.returnPosition, refundWire: 57n}})],
    ["unwind missing active buy", (f) => rewriteFactory(f, "recovery", {active: 0n})],
    ["unwind did not advance next wire", (f) => rewriteFactory(f, "recovery", {state: {nextBuyWireId: 56n}})],
  ];
  for (const [label, change] of [
    ["wrong marker", (c: Cell) => beginCell().storeUint(0, 32).storeBits(c.beginParse().skip(32).loadBits(256)).endCell()],
    ["truncated standard bounce", (c: Cell) => beginCell().storeBits(c.beginParse().loadBits(287)).endCell()],
    ["extended standard bounce", (c: Cell) => beginCell().storeSlice(c.beginParse()).storeBit(false).endCell()],
    ["referenced standard bounce", (c: Cell) => beginCell().storeSlice(c.beginParse()).storeRef(Cell.EMPTY).endCell()],
    ["wrong wire with intact prefix width", (c: Cell) => beginCell().storeBits(c.beginParse().loadBits(64)).storeUint(54, 64).storeBits(c.beginParse().skip(128).loadBits(160)).endCell()],
    ["wrong truncated owner fragment", (c: Cell) => beginCell().storeBits(c.beginParse().loadBits(287)).storeBit(!c.bits.at(287)).endCell()],
  ] as Array<[string, (c: Cell) => Cell]>)
    cases.push([label, (f) => {f.bounce.body = boc(change(Cell.fromBase64(f.bounce.body!)));}]);
  for (const kind of [1, 2] as const) for (const [label, mutate] of cases) {
    const f = bounceFixture(kind); mutate(f);
    const {events, event} = await bounceEvent(f);
    assert.equal(event, undefined, `kind ${kind}: ${label}`);
    assert(!events.flatMap((e) => e.movements).some((m) => m.purpose === "option_refund"), `kind ${kind}: ${label} cannot qualify the unrelated physical cash as a buy refund`);
  }
  const cashCases: Array<[string, (f: BounceFixture) => void]> = [
    ["missing physical refund credit", (f) => {f.cashSource.outMessages = [];}],
    ["failed recipient credit", (f) => {f.factoryPayment!.creditTx.success = false; f.factoryPayment!.creditTx.status = "failed";}],
    ["missing finalized wallet receipt", (f) => {f.input.chains.get(factoryWallet)!.transactions.find((t) => t.outMessages.includes(f.factoryPayment!.finalized))!.outMessages = [];}],
    ["missing exact final archive", (f) => {f.states.delete(`${factory}:${f.factoryPayment!.terminal.lt}`);}],
    ["terminal budget not cleared", (f) => {f.states.get(`${factory}:${f.factoryPayment!.terminal.lt}`)!.data = factoryData(
      {...f.returnPosition, flags: 176n, walletFunding: 1n}, [], 0n, undefined, {series: [f.unwoundSeries], nextBuyWireId: 57n},
    );}],
  ];
  for (const kind of [1, 2] as const) for (const [label, mutate] of cashCases) {
    const f = bounceFixture(kind); mutate(f);
    const {event} = await bounceEvent(f);
    assert(event, `kind ${kind}: ${label} retains proved cancellation`);
    assert.equal(event.settlement!.status, "incomplete", label);
    assert.equal(event.settlement!.optionLifecycle!.refund!.unwind!.factoryReturn.status, "pending", label);
    assert(!event.movements.some((m) => m.purpose === "option_refund"), label);
  }
  console.log(`${cases.length * 2} physical/state rejection and ${cashCases.length * 2} incomplete-cash cases passed`);
}

async function positives() {
  for (const kind of [1, 2] as const) for (const paid of [true, false]) {
    const f = bounceFixture(kind, paid), {events, event} = await bounceEvent(f);
    assert(event, JSON.stringify({kind, paid, events: events.map((e) => ({kind: e.kind, issues: e.issues}))}));
    const lifecycle = event.settlement!.optionLifecycle!, unwind = lifecycle.refund!.unwind!;
    assert.equal(event.settlement!.status, paid ? "confirmed" : "incomplete");
    assert.equal(lifecycle.payout.status, paid ? "completed" : "pending");
    assert.equal(unwind.funding.amountRaw, f.amount.toString());
    assert.equal(unwind.funding.queryId, "1234");
    assert.equal(unwind.reservationStatus, "failed");
    assert.equal(unwind.custody.status, "not_transferred");
    assert.equal(unwind.vaultReturn.status, "none");
    assert.equal(unwind.vaultReturn.amountRaw, "0");
    assert.equal(unwind.cancellation.status, "completed");
    assert.equal(unwind.factoryReturn.status, paid ? "completed" : "pending");
    const trigger = unwind.trigger;
    assert.equal(trigger.kind, "initial_series_buy_bounced");
    assert(trigger.kind === "initial_series_buy_bounced");
    assert.equal(trigger.opcode, kind === 1 ? OPTION_BUY_SHOUT : OPTION_BUY_SPREAD);
    assert.equal(trigger.wireId, "55");
    assert.equal(trigger.failedTransaction.lt, f.failed.lt);
    assert.equal(trigger.failedTransaction.hash, f.failed.hash);
    assert.equal(trigger.recoveryTransaction.lt, f.recovery.lt);
    assert.equal(trigger.originalMessageBodyHash, Cell.fromBase64(f.assigned.body!).hash().toString("hex"));
    assert.equal(trigger.bodyHash, Cell.fromBase64(f.bounce.body!).hash().toString("hex"));
    assert.equal(Cell.fromBase64(trigger.bodyBoc).bits.length, 288);
    assert.equal(trigger.factoryUnwind.seriesBuyIndexBefore, f.key.toString());
    assert.equal(trigger.factoryUnwind.seriesBuyIndexAfter, null);
    assert.deepEqual(trigger.factoryUnwind.beforeSeries, {
      kind, optionAddress: series, openNotionalRaw: notional.toString(), collateralLockedRaw: collateral.toString(),
    });
    assert.deepEqual(trigger.factoryUnwind.afterSeries, {
      kind, optionAddress: series, openNotionalRaw: "0", collateralLockedRaw: "0",
    });
    const refunds = event.movements.filter((m) => m.purpose === "option_refund");
    assert.equal(refunds.reduce((sum, m) => sum + BigInt(m.amountRaw), 0n), paid ? f.amount : 0n);
    assert.equal(refunds.length, paid ? 1 : 0);
    assert(!event.movements.some((m) => m.asset.kind === "option_position"), "failed buy never creates or retires a right");
    assert(!event.movements.some((m) => m.purpose === "option_payout"), "refund is not exercise income");
    assert.equal(factoryState(f, f.initialFactory.lt).nextBuyWireId, "55");
    assert.equal(factoryState(f, f.origin.lt).nextBuyWireId, "56");
    assert.equal(factoryState(f, f.recovery.lt).nextBuyWireId, "57");
    assert.equal(factoryState(f, f.recovery.lt).activeBuyKey, f.key.toString());
    assert.equal(factoryPosition(f, f.origin.lt).walletFundingRaw, "360000000");
    assert.equal(factoryPosition(f, f.recovery.lt).walletFundingRaw, "220000000");
    assert.equal(factoryPosition(f, f.recovery.lt).buyStateRaw, "112");
    if (f.factoryPayment) {
      const terminal = factoryPosition(f, f.factoryPayment.terminal.lt);
      assert.equal(terminal.buyStateRaw, "176");
      assert.equal(terminal.walletFundingRaw, "0");
      assert.equal(factoryState(f, f.factoryPayment.terminal.lt).activeBuyKey, "0");
    } else {
      assert(f.recovery.outMessages.some((m) => tokenWire(m)?.op === TRANSFER));
      assert.equal(f.cashSource.outMessages[0], f.cashTransfer);
      assert(![...f.input.chains.values()].some((c) => c.transactions.some((t) => t.inMessage === f.cashTransfer)));
    }
    const forbidden = new Set([0x4f424152, 0x4f42434c, 0x4f424341]);
    for (const chain of f.input.chains.values()) for (const transaction of chain.transactions)
      for (const m of transaction.outMessages)
        if (m.body) assert(!forbidden.has(Cell.fromBase64(m.body).beginParse().loadUint(32)), "no fabricated owner/cancel request or ACK");
    assert.deepEqual((await projectOwnerLedger(f.input)).events, events, "reprojection keeps exact stable IDs and cash");
  }
  console.log("four physical initial-buy bounce paid/pending fixtures passed");
}

async function main() {
  await positives();
  await adverseCases();
  await reservedWireBoundary();
  for (const kind of [1, 2] as const) {
    const f = bounceFixture(kind);
    await durableOptionAbort(f, f.recovery.lt, kind);
  }
  console.log("two durable pending-to-complete bounce projections and cold archive rebuilds passed");
}
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
