import { writeCurrentJettonWalletStorage } from "../ledger/jettonWalletState";
import './t3-mint-fees-test';
import assert from "node:assert/strict";
import { Address, Cell, Dictionary, beginCell } from "@ton/core";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  projectOwnerLedger,
  type ProjectionInput,
  type LedgerChain,
} from "../ledger/project";
import { LedgerGraphBuilder } from "../ledger/graph";
import type { RawMessage, RawTransaction } from "../data/dataSource";
import { loadOpcodes } from "../utils/opcodes";
import { INTERNAL, NOTIFY, TRANSFER, BURN, BURN_NOTIFY } from "../ledger/wire";
import { NATIVE_FUNDING } from "../ledger/nativeFunding";
import * as w from "../ledger/t3Wire";
import { perpsWalletAddress } from "../ledger/perpsWire";
import { readT3RecoveryHub, t3ReceiptKey } from "../ledger/t3RecoveryState";
import { validateT3RedemptionBinding } from "../ledger/bindings";
import {
  projectionFingerprint,
  PostgresLedgerStore,
  type LedgerSqlPool,
} from "../ledger/store";
import { PGlite } from "@electric-sql/pglite";
import { LedgerService } from "../ledger/service";
import { createLogger } from "../utils/logger";
import type { TonDataSource } from "../data/dataSource";
const address = (n: number) => `0:${n.toString(16).padStart(64, "0")}`,
  A = (s: string) => Address.parse(s);
const code = beginCell().storeUint(17, 32).endCell();
const owner = address(301),
  hub = address(302),
  root = address(303),
  tw = perpsWalletAddress(code, root, owner),
  receiver = w.receiverAddress(
    beginCell().storeUint(17, 32).endCell(),
    hub,
    owner,
  ),
  other = address(306),
  roots = [307, 308, 309].map(address),
  vaults = [310, 311, 312].map(address),
  wallets = [313, 314, 315].map(address),
  custody = [316, 317, 318].map(address);
const query = "9007199254741033",
  rootQuery = "9007199254741049",
  wire = "9007199254741061",
  payout = "9007199254741067",
  refundPayout = "9223372036854775813",
  amount = 2n ** 80n + 31n;
function wrapNativeFundingMessage(message: RawMessage, correlationId = wire) {
  const business = Cell.fromBase64(message.body!);
  const envelope = beginCell().storeUint(NATIVE_FUNDING, 32)
    .storeUint(BigInt(correlationId), 64).storeUint(0, 8).storeUint(0, 32)
    .storeAddress(A(owner)).storeRef(business).endCell();
  message.body = envelope.toBoc().toString('base64');
  message.op = NATIVE_FUNDING;
}
function emptyReferralState(completedMints?: Dictionary<bigint, Cell>) {
  return beginCell().storeUint(0, 32).storeCoins(0).storeUint(1, 64).storeUint(0, 64).storeUint(0, 64)
    .storeRef(Cell.EMPTY).storeRef(beginCell().storeUint(0, 64).storeUint(0, 64).storeDict(null).storeDict(null)).storeDict(completedMints ?? null).endCell();
}
function emptyBounceState(mintState = Cell.EMPTY) {
  return beginCell().storeAddress(null).storeUint(0, 32).storeUint(0, 32).storeCoins(0).storeInt(0, 64)
    .storeRef(mintState).storeRef(beginCell().storeUint(1, 64).storeDict(null)
      .storeDict(null).storeDict(null).storeDict(null))
    .storeRef(emptyReferralState()).endCell();
}
function mintJournal(status: number, rootId: string, minted: bigint, receipt: Cell, requestHash = 0n) {
  const idle = status === 0;
  const funding = beginCell().storeUint(idle ? 0n : BigInt(query), 64)
    .storeUint(0, 8).storeUint(0, 32).storeAddress(A(idle ? address(0) : owner)).endCell();
  return beginCell().storeUint(status, 8).storeUint(idle ? 0n : BigInt(query), 64)
    .storeUint(idle ? 0n : BigInt(rootId), 64).storeCoins(idle ? 0n : minted)
    .storeAddress(idle ? null : A(owner)).storeRef(beginCell()
      .storeAddress(idle ? null : A(owner)).storeUint(requestHash, 256)
      .storeCoins(status === 1 ? 360_000_000n : status === 5 ? 20_000_000n : 0n)
      .storeRef(idle ? Cell.EMPTY : receipt).storeRef(funding)).endCell();
}
const mintBusinessKey = () => BigInt('0x' + beginCell().storeUint(0x54334d52, 32)
  .storeAddress(A(owner)).storeUint(BigInt(query), 64).endCell().hash().toString('hex'));
function mintLane(nextId: string, journal: Cell, failed?: Dictionary<bigint, Cell>) {
  return beginCell().storeUint(BigInt(nextId), 64).storeUint(1, 64)
    .storeUint(0, 8).storeUint(0, 64).storeRef(journal).storeDict(failed ?? null).endCell();
}
function feeCell(proportional = [0n, 0n, 0n], single = [0n, 0n, 0n]) {
  const builder = beginCell();
  [...proportional, ...single].forEach(amount => builder.storeCoins(amount));
  return builder.endCell();
}
const inviterCell = (referrer: string | null = null) => beginCell().storeAddress(referrer ? A(referrer) : null).endCell();
function state(
  mintFee = 100,
  redeemFee = 100,
  supply = 1000n,
  balance = [1000n, 0n, 0n],
  bounce = emptyBounceState(),
  enabled = 1,
  fees = feeCell(),
) {
  const peg = beginCell()
    .storeUint(0, 8)
    .storeUint(0, 16)
    .storeUint(0, 8)
    .storeUint(0, 128);
  for (let i = 0; i < 5; i++) peg.storeCoins(0);
  peg
    .storeUint(0, 32)
    .storeUint(mintFee, 16)
    .storeUint(redeemFee, 16)
    .storeUint(0, 16)
    .storeUint(0, 48);
  const s = beginCell().storeInt(100, 24).storeUint(30, 16).storeCoins(supply);
  balance.forEach((v) => s.storeCoins(v));
  s.storeRef(fees)
    .storeRef(Cell.EMPTY)
    .storeUint(0, 208)
    .storeRef(
      beginCell().storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).storeRef(peg.endCell()).storeRef(Cell.EMPTY).endCell(),
    )
    .storeAddress(A(other))
    .storeAddress(A(root))
    .storeUint(enabled, 8)
    .storeRef(bounce);
  return beginCell().storeUint(0x54335354, 32).storeRef(s.endCell()).endCell();
}
function fixture() {
  let lt = 10;
  const chains = new Map<string, LedgerChain>();
  for (const a of [
    owner,
    hub,
    root,
    tw,
    receiver,
    ...roots,
    ...vaults,
    ...wallets,
    ...custody,
  ])
    chains.set(a, {
      account: a,
      generation: "fixture",
      historyComplete: true,
      role:
        a === owner
          ? "owner"
          : a === receiver
            ? "controlled_contract"
            : [tw, ...wallets, ...custody].includes(a)
              ? "owned_jetton_wallet"
              : "counterparty",
      transactions: [],
    });
  const asset = (wallet: string, o: string, r: string, controlled = false) => ({
    kind: "jetton" as const,
    id: `localnet:jetton:${r}`,
    master: r,
    wallet,
    owner: o,
    decimals: 9,
    ...(controlled
      ? { controller: owner, custody: "t3_receiver" as const }
      : {}),
  });
  const identity = {
    payoutId: payout,
    wireId: wire,
    consumed: true,
    getter: {
      account: hub,
      method: "redemption_identity" as const,
      args: [owner, query],
      result: ["1", payout, "1", wire],
      observedAt: "2026-09-07T00:00:00.000Z",
    },
  };
  const config = {
    address: hub,
    root,
    codeHash: code.hash().toString("hex"),
    reserveRoots: roots,
    vaults,
    receiver,
    redemptions: new Map([[query, identity]]),
  };
  const input: ProjectionInput = {
    network: "localnet",
    owner,
    chains,
    wallets: new Map([
      [tw, asset(tw, owner, root)],
      ...roots.flatMap(
        (r, i) =>
          [
            [wallets[i], asset(wallets[i], owner, r)],
            [vaults[i], asset(vaults[i], hub, r)],
            [custody[i], asset(custody[i], receiver, r, true)],
          ] as [string, ReturnType<typeof asset>][],
      ),
    ]),
    pools: new Map(),
    opcodes: loadOpcodes(),
    t3Hubs: new Map([[hub, config]]),
    stateAt: async () => null,
  };
  const msg = (src: string, dest: string, body: Cell): RawMessage => ({
    source: src,
    destination: dest,
    createdLt: String(++lt),
    body: body.toBoc().toString("base64"),
    op: body.beginParse().preloadUint(32),
    value: "100",
    forwardFeeRaw: "3",
    extraFlagsRaw: "0",
    bounced: false,
  });
  const tx = (
    account: string,
    inMessage?: RawMessage,
    outMessages: RawMessage[] = [],
  ) => {
    const list = chains.get(account)!.transactions,
      prev = list.at(-1),
      raw: RawTransaction = {
        lt: String(++lt),
        hash: createHash("sha256").update(String(lt)).digest("base64"),
        prevTransactionLt: prev?.lt ?? "0",
        prevTransactionHash: prev?.hash ?? Buffer.alloc(32).toString("base64"),
        utime: 1700000000 + lt,
        status: "success",
        success: true,
        totalFeesRaw: "7",
        inMessage,
        outMessages,
      };
    list.push(raw);
    return raw;
  };
  const transfer = (
    srcOwner: string,
    srcWallet: string,
    dstOwner: string,
    dstWallet: string,
    q: string,
    n: bigint,
    payload: Cell,
    standard = false,
  ) => {
    const request = msg(
        srcOwner,
        srcWallet,
        beginCell()
          .storeUint(TRANSFER, 32)
          .storeUint(BigInt(q), 64)
          .storeCoins(n)
          .storeAddress(A(dstOwner))
          .storeAddress(A(srcOwner))
          .storeBuilder(
            standard
              ? beginCell().storeMaybeRef(null)
              : beginCell().storeRef(Cell.EMPTY),
          )
          .storeCoins(1)
          .storeBuilder(standard ? beginCell().storeBit(true) : beginCell())
          .storeRef(payload)
          .endCell(),
      ),
      internal = msg(
        srcWallet,
        dstWallet,
        beginCell()
          .storeUint(INTERNAL, 32)
          .storeUint(BigInt(q), 64)
          .storeCoins(n)
          .storeAddress(A(srcOwner))
          .storeAddress(A(srcOwner))
          .storeCoins(1)
          .storeBuilder(standard ? beginCell().storeBit(true) : beginCell())
          .storeRef(payload)
          .endCell(),
      ),
      notification = msg(
        dstWallet,
        dstOwner,
        beginCell()
          .storeUint(NOTIFY, 32)
          .storeUint(BigInt(q), 64)
          .storeCoins(n)
          .storeAddress(A(srcOwner))
          .storeBuilder(
            standard
              ? beginCell().storeBit(true)
              : beginCell().storeAddress(A(srcWallet)).storeCoins(1),
          )
          .storeRef(payload)
          .endCell(),
      );
    const source = tx(srcWallet, request, [internal]),
      dest = tx(dstWallet, internal, [notification]);
    return { request, notification, source, dest };
  };
  return { input, config, identity, msg, tx, transfer };
}
function mint(basket = [amount, 0n, 0n], referrer: string | null = null, wrapped = false,
  parked: boolean | number | 'duplicate-finalize' = false,
  economics?: { beforeBalances: bigint[]; fees: bigint[]; minted: bigint }) {
  const f = fixture(),
    note = beginCell()
      .storeUint(w.DEPOSIT_NOTE, 32)
      .storeUint(1, 8)
      .storeUint(basket.filter((v) => v > 0n).length > 1 ? 0 : 1, 8)
      .storeUint(10000, 16)
      .storeAddress(A(owner))
      .storeRef(inviterCell(referrer))
      .endCell(),
    deposit = f.transfer(
      owner,
      wallets[0],
      hub,
      vaults[0],
      query,
      basket[0],
      note,
    );
  f.tx(owner, undefined, [deposit.request]);
  f.tx(hub);
  const extra = basket.slice(1).flatMap((n, index) => {
    if (n === 0n) return [];
    const d = f.transfer(
      owner,
      wallets[index + 1],
      hub,
      vaults[index + 1],
      query,
      n,
      note,
    );
    f.tx(owner, undefined, [d.request]);
    f.tx(hub, d.notification);
    return [d];
  });
  const minted = economics?.minted ?? basket.reduce(
      (a, v) => a + (basket.every((n) => n > 0n) ? v : (v * 9900n) / 10000n),
      0n,
    ),
    internalValue = {
      wireId: wire,
      queryId: rootQuery,
      amountRaw: String(minted),
      caller: hub,
      recipient: owner,
      forwardTonRaw: "0",
      forward: Cell.EMPTY,
    };
  const requestHash = w.mintRequestHash(root, tw, internalValue as any),
    h = BigInt("0x" + requestHash);
  const start = f.msg(
    hub,
    root,
    beginCell()
      .storeUint(w.MINT_START, 32)
      .storeUint(BigInt(rootQuery), 64)
      .storeCoins(minted)
      .storeAddress(A(owner))
      .storeAddress(A(hub))
      .storeCoins(0)
      .storeRef(Cell.EMPTY)
      .endCell(),
  );
  let originMessage = deposit.notification;
  if (extra.length) {
    f.tx(hub, deposit.notification);
    originMessage = f.msg(
      owner,
      hub,
      beginCell()
        .storeUint(w.T3_MINT, 32)
        .storeUint(BigInt(query), 64)
        .storeAddress(A(owner))
        .storeUint(10000, 16)
        .storeCoins(basket[0])
        .storeCoins(basket[1])
        .storeCoins(basket[2])
        .storeMaybeRef(null)
        .storeRef(inviterCell(referrer))
        .endCell(),
    );
    f.tx(owner, undefined, [originMessage]);
  }
  const archives = new Map<string, Cell>();
  const proportional = basket.every(n => n > 0n);
  const beforeBalances = economics?.beforeBalances ?? (proportional ? basket : [1000n, 0n, 0n]);
  const beforeSupply = beforeBalances.reduce((total, n) => total + n, 0n);
  const afterBalances = basket.map((n, i) => n + beforeBalances[i]);
  const assessedFees = economics?.fees ?? basket.map(n => proportional ? 0n : n - n * 9900n / 10000n);
  const originalBefore = (lane: Cell) => state(100, 100, beforeSupply, beforeBalances, emptyBounceState(lane), 1, feeCell());
  const committed = (lane: Cell) => state(100, 100, beforeSupply + minted, afterBalances,
    emptyBounceState(lane), 1, feeCell(assessedFees));
  let originalAdmission: RawTransaction | undefined;
  let failedRoot: RawTransaction | undefined;
  let parkedAt: RawTransaction | undefined;
  const failedAttempts: RawTransaction[] = [], parkedAttempts: RawTransaction[] = [], retryAttempts: RawTransaction[] = [];
  const durableReceipt = beginCell().storeUint(w.T3_MINT_RECEIPT, 32)
    .storeUint(BigInt(query), 64).storeAddress(A(owner)).storeCoins(minted)
    .storeCoins(basket[0]).storeCoins(basket[1]).storeCoins(basket[2]).storeMaybeRef(null).endCell();
  if (parked) {
    const failures = parked === true || parked === 'duplicate-finalize' ? 1 : parked;
    const initialRootId = (BigInt(rootQuery) - BigInt(failures)).toString();
    for (let attempt = 0; attempt < failures; attempt++) {
      const previousRootId = (BigInt(initialRootId) + BigInt(attempt)).toString(),
        nextRootId = (BigInt(previousRootId) + 1n).toString();
      const previousStart = f.msg(hub, root, beginCell().storeUint(w.MINT_START, 32)
      .storeUint(BigInt(previousRootId), 64).storeCoins(minted).storeAddress(A(owner))
      .storeAddress(A(hub)).storeCoins(0).storeRef(Cell.EMPTY).endCell());
      wrapNativeFundingMessage(previousStart, previousRootId);
      previousStart.value = '400000000';
      if (attempt > 0) {
        originMessage = f.msg(owner, hub, beginCell().storeUint(0x4d525459, 32)
          .storeAddress(A(owner)).storeUint(BigInt(query), 64).endCell());
        originMessage.value = '920000000';
        f.tx(owner, undefined, [originMessage]);
      }
      const admitted = f.tx(hub, originMessage, [previousStart]);
      if (attempt === 0) {
        originalAdmission = admitted;
        archives.set(admitted.prevTransactionLt!, originalBefore(
          mintLane(initialRootId, mintJournal(0, '0', 0n, Cell.EMPTY))));
      } else retryAttempts.push(admitted);
      archives.set(admitted.lt, committed(mintLane(nextRootId,
        mintJournal(1, previousRootId, minted, durableReceipt))));
      let failedHash = 0n;
      let duplicateFinal: RawMessage | undefined;
      let returned: RawMessage;
      if (parked === 'duplicate-finalize') {
        const previousWire = (BigInt(wire) - 1n).toString();
        failedHash = BigInt('0x' + w.mintRequestHash(root, tw, {
          ...internalValue, wireId: previousWire, queryId: previousRootId, requestHash: '0'.repeat(64),
        }));
        const previousInternal = f.msg(root, tw, beginCell().storeUint(w.MINT_INTERNAL, 32)
          .storeUint(BigInt(previousWire), 64).storeUint(BigInt(previousRootId), 64)
          .storeCoins(minted).storeUint(failedHash, 256).storeRef(beginCell()
            .storeAddress(A(hub)).storeAddress(A(owner)).storeCoins(0)).storeRef(Cell.EMPTY).endCell());
        wrapNativeFundingMessage(previousInternal, previousRootId);
        f.tx(root, previousStart, [previousInternal]);
        const walletBounce = f.msg(tw, root, beginCell().storeUint(0xfffffffe, 32)
          .storeRef(Cell.fromBase64(previousInternal.body!))
          .storeRef(beginCell().storeCoins(340_000_000n).storeBit(false).storeUint(0, 64).storeUint(0, 32))
          .storeUint(0, 8).storeInt(1103, 32).storeBit(false).endCell());
        walletBounce.bounced = true;
        failedRoot = f.tx(tw, previousInternal, [walletBounce]);
        failedRoot.success = false; failedRoot.status = 'failed'; failedAttempts.push(failedRoot);
        const negative = f.msg(root, hub, beginCell().storeUint(0x4a4d4246, 32)
          .storeUint(BigInt(previousWire), 64).storeUint(BigInt(previousRootId), 64)
          .storeCoins(minted).storeAddress(A(owner)).storeUint(failedHash, 256).endCell());
        wrapNativeFundingMessage(negative, previousRootId);
        f.tx(root, walletBounce, [negative]);
        const finalizeBody = () => beginCell().storeUint(w.MINT_FINALIZE, 32)
          .storeUint(BigInt(previousRootId), 64).storeCoins(minted).storeAddress(A(owner))
          .storeUint(failedHash, 256).endCell();
        const finalize = f.msg(hub, root, finalizeBody()); wrapNativeFundingMessage(finalize, previousRootId);
        const settling = f.tx(hub, negative, [finalize]);
        const settlingState = committed(mintLane(nextRootId, mintJournal(5, previousRootId, minted, durableReceipt, failedHash)));
        archives.set(settling.lt, settlingState);
        const pendingRetry = f.msg(owner, hub, beginCell().storeUint(0x4d525459, 32)
          .storeAddress(A(owner)).storeUint(BigInt(query), 64).endCell());
        pendingRetry.value = '500000000'; f.tx(owner, undefined, [pendingRetry]);
        const finalizeAgain = f.msg(hub, root, finalizeBody()); wrapNativeFundingMessage(finalizeAgain, previousRootId);
        const pending = f.tx(hub, pendingRetry, [finalizeAgain]);
        archives.set(pending.lt, settlingState); retryAttempts.push(pending);
        const finalizedBody = () => beginCell().storeUint(w.MINT_FINALIZED, 32)
          .storeUint(BigInt(previousRootId), 64).storeCoins(minted).storeAddress(A(owner))
          .storeUint(failedHash, 256).endCell();
        returned = f.msg(root, hub, finalizedBody()); wrapNativeFundingMessage(returned, previousRootId);
        f.tx(root, finalize, [returned]);
        duplicateFinal = f.msg(root, hub, finalizedBody()); wrapNativeFundingMessage(duplicateFinal, previousRootId);
        f.tx(root, finalizeAgain, [duplicateFinal]);
      } else {
        returned = f.msg(root, hub, beginCell().storeUint(0xfffffffe, 32)
      .storeRef(Cell.fromBase64(previousStart.body!))
      .storeRef(beginCell().storeCoins(400_000_000n).storeBit(false)
        .storeUint(0, 64).storeUint(0, 32).endCell())
      .storeUint(0, 8).storeInt(1103, 32).storeBit(false).endCell());
        returned.bounced = true;
        failedRoot = f.tx(root, previousStart, [returned]);
        failedRoot.success = false;
        failedRoot.status = 'failed';
        failedAttempts.push(failedRoot);
      }
      parkedAt = f.tx(hub, returned);
      parkedAttempts.push(parkedAt);
      const failed = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
      failed.set(mintBusinessKey(), mintJournal(2, previousRootId, minted, durableReceipt, failedHash));
      const parkedState = committed(mintLane(nextRootId, mintJournal(0, '0', 0n, Cell.EMPTY), failed));
      archives.set(parkedAt.lt, parkedState);
      if (duplicateFinal) {
        const late = f.tx(hub, duplicateFinal);
        archives.set(late.lt, parkedState); parkedAttempts.push(late);
      }
    }
    originMessage = f.msg(owner, hub, beginCell().storeUint(0x4d525459, 32)
      .storeAddress(A(owner)).storeUint(BigInt(query), 64).endCell());
    f.tx(owner, undefined, [originMessage]);
  }
  if (parked) {
    wrapNativeFundingMessage(start, rootQuery);
    start.value = '400000000';
    originMessage.value = '920000000';
  }
  const origin = f.tx(hub, originMessage, [start]);
  if (!parked) archives.set(origin.prevTransactionLt!, originalBefore(
    mintLane(rootQuery, mintJournal(0, '0', 0n, Cell.EMPTY))));
  archives.set(origin.lt, committed(
    mintLane((BigInt(rootQuery) + 1n).toString(), mintJournal(1, rootQuery, minted, durableReceipt))));
  const internal = f.msg(
    root,
    tw,
    beginCell()
      .storeUint(w.MINT_INTERNAL, 32)
      .storeUint(BigInt(wire), 64)
      .storeUint(BigInt(rootQuery), 64)
      .storeCoins(minted)
      .storeUint(h, 256)
      .storeRef(
        beginCell()
          .storeAddress(A(hub))
          .storeAddress(A(owner))
          .storeCoins(0)
          .endCell(),
      )
      .storeRef(Cell.EMPTY)
      .endCell(),
  );
  f.tx(root, start, [internal]);
  const accepted = f.msg(
      tw,
      root,
      beginCell()
        .storeUint(w.MINT_ACCEPTED, 32)
        .storeUint(BigInt(wire), 64)
        .storeUint(BigInt(rootQuery), 64)
        .storeCoins(minted)
        .storeUint(h, 256)
        .endCell(),
    ),
    credit = f.tx(tw, internal, [accepted]);
  const success = f.msg(
    root,
    hub,
    beginCell()
      .storeUint(w.MINT_SUCCEEDED, 32)
      .storeUint(BigInt(wire), 64)
      .storeUint(BigInt(rootQuery), 64)
      .storeCoins(minted)
      .storeAddress(A(owner))
      .storeUint(h, 256)
      .endCell(),
  );
  f.tx(root, accepted, [success]);
  const receipt = f.msg(
      hub,
      owner,
      beginCell()
        .storeUint(w.T3_MINT_RECEIPT, 32)
        .storeUint(BigInt(query), 64)
        .storeAddress(A(owner))
        .storeCoins(minted)
        .storeCoins(basket[0])
        .storeCoins(basket[1])
        .storeCoins(basket[2])
        .storeMaybeRef(null)
        .endCell(),
    ),
    final = f.msg(
      hub,
      root,
      beginCell()
        .storeUint(w.MINT_FINALIZE, 32)
        .storeUint(BigInt(rootQuery), 64)
        .storeCoins(minted)
        .storeAddress(A(owner))
        .storeUint(h, 256)
        .endCell(),
    ),
    hubSuccess = f.tx(hub, success, [receipt, final]);
  f.tx(owner, receipt);
  const finalized = f.msg(
    root,
    hub,
    beginCell()
      .storeUint(w.MINT_FINALIZED, 32)
      .storeUint(BigInt(rootQuery), 64)
      .storeCoins(minted)
      .storeAddress(A(owner))
      .storeUint(h, 256)
      .endCell(),
  );
  f.tx(root, final, [finalized]);
  f.tx(hub, finalized);
  if (wrapped || parked) {
    for (const message of [start, internal, accepted, success, final, finalized])
      if (message.op !== NATIVE_FUNDING) wrapNativeFundingMessage(message, parked ? rootQuery : wire);
  }
  f.input.stateAt = async (account, lt, hash) => {
    if (account !== hub) return null;
    const archived = archives.get(lt);
    return archived ? ({
    seqno: Number(lt),
    state: {
      accountState: "active",
      lastTxLt: lt, lastTxHash: hash,
      codeBoc: code.toBoc().toString("base64"),
      dataBoc: archived.toBoc().toString("base64"),
    } as any,
  }) : null;
  };
  return {
    ...f,
    credit,
    hubSuccess,
    origin,
    minted,
    deposit,
    internal,
    accepted,
    originalAdmission,
    failedRoot,
    parkedAt,
    archives,
    failedAttempts,
    parkedAttempts,
    retryAttempts,
  };
}
function rejectedMintRefund(stage: 'queued' | 'dispatching' | 'credited', kind: 3 | 5 = 3) {
  const f = fixture(), raw = 1_000_000n;
  const note = beginCell().storeUint(w.DEPOSIT_NOTE, 32).storeUint(1, 8)
    .storeUint(1, 8).storeUint(10000, 16).storeAddress(A(owner))
    .storeRef(inviterCell()).endCell();
  const deposit = f.transfer(owner, wallets[0], hub, vaults[0], query, raw, note);
  f.tx(owner, undefined, [deposit.request]);
  const zeroReceipt = f.msg(hub, owner, beginCell()
    .storeUint(w.T3_MINT_RECEIPT, 32).storeUint(BigInt(query), 64)
    .storeAddress(A(owner)).storeCoins(0).storeCoins(raw).storeCoins(0)
    .storeCoins(0).storeMaybeRef(null).endCell());
  const hubAdmission = f.tx(hub, deposit.notification, [zeroReceipt]);
  f.tx(owner, zeroReceipt);
  const businessQueryId = kind === 3 ? query : hubAdmission.lt;
  const observedAt = '2026-09-25T00:00:00.000Z';
  const getter = (method: 'vault_payout_identity' | 'refund_queue_item' | 'vault_payout_state',
    args: string[], result: string[]) => ({ account: hub, method, args, result, observedAt });
  const identityEvidence = getter('vault_payout_identity', [String(kind), owner, businessQueryId],
    ['1', refundPayout, w.refundPayloadHash(kind, owner, [String(raw), '0', '0'])]);
  f.input.t3Hubs!.get(hub)!.refunds = new Map([[hubAdmission.lt, {
    kind, businessQueryId, payoutId: refundPayout, token: 0, amountRaw: String(raw),
    basketRaw: [String(raw), '0', '0'], identityEvidence,
    ...(stage === 'queued' ? { queueEvidence: getter('refund_queue_item',
      [String(kind), owner, businessQueryId], ['1', String(raw), '0', '0']) } : {}),
    ...(stage === 'dispatching' ? {
      payoutEvidence: getter('vault_payout_state', [refundPayout], ['1', owner, '1', String(raw), '0', '0']),
      payout: { phase: 1, activeToken: 0, wireId: '55', amountRaw: String(raw),
        routeEpoch: 1, receiverWallet: custody[0], sourceAccepted: false,
        receiverCredited: false },
    } : {}),
  }]]);
  if (stage === 'credited') {
    const payload = beginCell().storeUint(w.RECEIVER_PAYOUT, 32)
      .storeUint(BigInt(refundPayout), 64).storeUint(55, 64).storeUint(1, 32)
      .storeUint(0, 8).storeCoins(raw).storeRef(beginCell()
        .storeAddress(A(hub)).storeAddress(A(owner)).storeAddress(A(receiver)).endCell()).endCell();
    const transfer = f.transfer(hub, vaults[0], receiver, custody[0], '55', raw, payload, true);
    f.tx(hub, undefined, [transfer.request]);
    const ack = f.msg(receiver, hub, beginCell().storeUint(w.RECEIVER_CREDITED, 32)
      .storeUint(BigInt(refundPayout), 64).storeUint(55, 64).storeUint(1, 32)
      .storeUint(0, 8).storeCoins(raw).storeAddress(A(custody[0]))
      .storeUint(BigInt(`0x${payload.hash().toString('hex')}`), 256).endCell());
    f.tx(receiver, transfer.notification, [ack]);
    f.tx(hub, ack);
  }
  return { ...f, deposit, hubAdmission, raw };
}
async function discoverRejectedMintRefund(identityHash?: string, kind: 3 | 5 = 3,
  repeated = false) {
  const f = rejectedMintRefund('queued', kind);
  let repeatAdmissionLt: string | undefined;
  if (repeated) {
    const note = beginCell().storeUint(w.DEPOSIT_NOTE, 32).storeUint(1, 8)
      .storeUint(1, 8).storeUint(10000, 16).storeAddress(A(owner))
      .storeRef(inviterCell()).endCell();
    const second = f.transfer(owner, wallets[0], hub, vaults[0], query, f.raw, note);
    f.tx(owner, undefined, [second.request]);
    repeatAdmissionLt = f.tx(hub, second.notification).lt;
  }
  const walletAssets = f.input.wallets;
  const store = {
    account: async (_network: string, account: string) => ({ current_generation: account, syncing: false }),
    rawHistory: async (generation: string) =>
      (repeated ? [...(f.input.chains.get(generation)?.transactions ?? [])].reverse()
        : f.input.chains.get(generation)?.transactions ?? []).map(raw => ({ raw })),
    pool: { query: async () => ({ rows: [{ complete: true }] }) },
  } as unknown as PostgresLedgerStore;
  const slice = (address: string) => ({ type: 'slice' as const,
    cell: beginCell().storeAddress(A(address)).endCell() });
  const integer = (value: bigint) => ({ type: 'int' as const, value });
  const routes = Array.from({ length: 18 }, () => integer(0n)) as any[];
  routes[1] = { type: 'cell', cell: code };
  routes[2] = { type: 'cell', cell: code };
  for (const [index, rootAddress] of [[3, roots[0]], [8, roots[1]], [13, roots[2]]] as const)
    routes[index] = slice(rootAddress);
  const source = {
    getAccountState: async (account: string) => account === hub
      ? { accountState: 'active', codeBoc: code.toBoc().toString('base64'),
        dataBoc: state().toBoc().toString('base64') }
      : account === receiver
        ? { accountState: 'active', codeBoc: code.toBoc().toString('base64'),
          dataBoc: Cell.EMPTY.toBoc().toString('base64') }
        : { accountState: 'uninitialized', codeBoc: null, dataBoc: null },
    getJettonBalance: async (holder: string, master: string) => {
      if (holder === owner && master === root) return { wallet: tw, balance: '0' };
      const token = roots.indexOf(master);
      if (token < 0) return null;
      return holder === owner ? { wallet: wallets[token], balance: '0' }
        : holder === receiver ? { wallet: custody[token], balance: '0' } : null;
    },
    runGetMethod: async (account: string, method: string, args: any[] = []) => {
      if (account === hub && method === 'vault_routes') return { exitCode: 0, stack: routes };
      if (account === hub && method === 'vault_addresses') return { exitCode: 0, stack: vaults.map(slice) };
      if (account === root && method === 'root_emitter') return { exitCode: 0, stack: [slice(hub)] };
      if (account === receiver && method === 'receiver_identity') return { exitCode: 0,
        stack: [integer(1n), slice(hub), slice(owner)] };
      if (account === hub && method === 'vault_payout_identity') {
        const requestedKind = args[0]?.value;
        const requestedQuery = args[2]?.value;
        const businessQuery = kind === 3 ? BigInt(query) : BigInt(f.hubAdmission.lt);
        const first = requestedKind === BigInt(kind) && requestedQuery === businessQuery;
        const second = repeated && requestedKind === 5n &&
          requestedQuery === BigInt(repeatAdmissionLt!);
        return { exitCode: 0, stack: first || second
          ? [integer(1n), integer(BigInt(refundPayout) + (second ? 1n : 0n)),
            integer(BigInt(second ? w.refundPayloadHash(5, owner, [String(f.raw), '0', '0'])
              : identityHash ?? w.refundPayloadHash(kind, owner, [String(f.raw), '0', '0'])))]
          : [integer(0n), integer(0n), integer(0n)] };
      }
      if (account === hub && method === 'refund_queue_item') return { exitCode: 0,
        stack: [integer(1n), integer(f.raw), integer(0n), integer(0n)] };
      return null;
    },
  } as unknown as TonDataSource;
  const graph = await new LedgerGraphBuilder('localnet', source, store, [], undefined,
    async address => walletAssets.get(address) ?? null, async () => true, 256,
    undefined, hub, root).build(owner, owner);
  return { graph, admissionLt: f.hubAdmission.lt, repeatAdmissionLt };
}
function redeem(sliced = false, recovery = false, referrer: string | null = null, wrapped = false) {
  const f = fixture();
  if (recovery) for (const a of [tw, root, hub]) f.tx(a);
  const n = 2n ** 60n + 37n,
    net = (n * 9900n) / 10000n,
    receiptAmount = sliced ? n / 2n : n,
    payoutAmount = sliced ? (net * receiptAmount) / n : net,
    payload = beginCell()
      .storeUint(0x54335242, 32)
      .storeAddress(A(owner))
      .storeUint(0, 16)
      .storeUint(0, 8)
      .storeUint(0, 8)
      .storeAddress(referrer ? A(referrer) : null)
      .endCell(),
    request = f.msg(
      owner,
      tw,
      beginCell()
        .storeUint(BURN, 32)
        .storeUint(BigInt(query), 64)
        .storeCoins(n)
        .storeAddress(A(hub))
        .storeRef(payload)
        .endCell(),
    ),
    notify = f.msg(
      tw,
      root,
      beginCell()
        .storeUint(BURN_NOTIFY, 32)
        .storeUint(BigInt(query), 64)
        .storeCoins(n)
        .storeAddress(A(owner))
        .storeAddress(A(hub))
        .storeRef(payload)
        .endCell(),
    );
  f.tx(owner, undefined, [request]);
  const burn = f.tx(tw, request, [notify]),
    proof = f.msg(
      root,
      hub,
      beginCell()
        .storeUint(BURN_NOTIFY, 32)
        .storeUint(BigInt(wire), 64)
        .storeCoins(n)
        .storeAddress(A(owner))
        .storeAddress(A(hub))
        .storeRef(
          beginCell()
            .storeUint(0x54335250, 32)
            .storeUint(BigInt(query), 64)
            .storeRef(payload)
            .endCell(),
        )
        .endCell(),
    );
  const rootBurn = f.tx(root, notify, [proof]);
  const hubAck = f.msg(
    hub,
    root,
    beginCell()
      .storeUint(w.BURN_ACCEPTED, 32)
      .storeUint(BigInt(wire), 64)
      .storeCoins(n)
      .storeUint(BigInt("0x" + w.burnIntentHash(owner, query)), 256)
      .endCell(),
  );
  const hubProof = f.tx(hub, proof, recovery ? [] : [hubAck]);
  const walletAck = f.msg(
    root,
    tw,
    beginCell()
      .storeUint(w.BURN_ACCEPTED, 32)
      .storeUint(BigInt(query), 64)
      .storeCoins(n)
      .storeUint(
        BigInt(
          "0x" + w.burnRequestHash(root, tw, owner, w.burnRequest(request)!),
        ),
        256,
      )
      .endCell(),
  );
  let rootAccepted: RawTransaction | undefined,
    walletAccepted: RawTransaction | undefined;
  if (!recovery) {
    rootAccepted = f.tx(root, hubAck, [walletAck]);
    walletAccepted = f.tx(tw, walletAck);
  }
  const redeemRequest = f.msg(
    owner,
    hub,
    beginCell()
      .storeUint(w.T3_REDEEM, 32)
      .storeUint(BigInt(query), 64)
      .storeAddress(A(owner))
      .storeAddress(A(owner))
      .storeUint(0, 16)
      .storeCoins(n)
      .storeUint(0, 8)
      .storeUint(0, 8)
      .storeMaybeRef(null)
      .storeRef(inviterCell(referrer))
      .endCell(),
  );
  f.tx(owner, undefined, [redeemRequest]);
  const receipt = f.msg(
    hub,
    owner,
    beginCell()
      .storeUint(w.T3_REDEEM_RECEIPT, 32)
      .storeUint(BigInt(query), 64)
      .storeAddress(A(owner))
      .storeCoins(receiptAmount)
      .storeCoins(payoutAmount)
      .storeCoins(0)
      .storeCoins(0)
      .storeUint(0, 8)
      .storeUint(0, 8)
      .storeMaybeRef(null)
      .endCell(),
  );
  const payoutPayload = beginCell()
      .storeUint(w.RECEIVER_PAYOUT, 32)
      .storeUint(BigInt(payout), 64)
      .storeUint(55, 64)
      .storeUint(1, 32)
      .storeUint(0, 8)
      .storeCoins(payoutAmount)
      .storeRef(
        beginCell()
          .storeAddress(A(hub))
          .storeAddress(A(owner))
          .storeAddress(A(receiver))
          .endCell(),
      )
      .endCell(),
    p = f.transfer(
      hub,
      vaults[0],
      receiver,
      custody[0],
      "55",
      payoutAmount,
      payoutPayload,
      true,
    );
  const execute = f.tx(hub, redeemRequest, [
    receipt,
    p.request,
    ...(recovery ? [hubAck] : []),
  ]);
  if (recovery) {
    rootAccepted = f.tx(root, hubAck, [walletAck]);
    walletAccepted = f.tx(tw, walletAck);
  }
  f.tx(owner, receipt);
  const ack = f.msg(
    receiver,
    hub,
    beginCell()
      .storeUint(w.RECEIVER_CREDITED, 32)
      .storeUint(BigInt(payout), 64)
      .storeUint(55, 64)
      .storeUint(1, 32)
      .storeUint(0, 8)
      .storeCoins(payoutAmount)
      .storeAddress(A(custody[0]))
      .storeUint(BigInt("0x" + payoutPayload.hash().toString("hex")), 256)
      .endCell(),
  );
  const receiverTx = f.tx(receiver, p.notification, [ack]);
  f.tx(hub, ack);
  if (sliced) {
    const remaining = n - receiptAmount,
      remainingPayout = net - payoutAmount,
      secondPayload = beginCell()
        .storeUint(w.RECEIVER_PAYOUT, 32)
        .storeUint(BigInt(payout), 64)
        .storeUint(56, 64)
        .storeUint(1, 32)
        .storeUint(0, 8)
        .storeCoins(remainingPayout)
        .storeRef(
          beginCell()
            .storeAddress(A(hub))
            .storeAddress(A(owner))
            .storeAddress(A(receiver))
            .endCell(),
        )
        .endCell();
    const second = f.transfer(
        hub,
        vaults[0],
        receiver,
        custody[0],
        "56",
        remainingPayout,
        secondPayload,
      ),
      receipt = f.msg(
        hub,
        owner,
        beginCell()
          .storeUint(w.T3_REDEEM_RECEIPT, 32)
          .storeUint(BigInt(query), 64)
          .storeAddress(A(owner))
          .storeCoins(remaining)
          .storeCoins(remainingPayout)
          .storeCoins(0)
          .storeCoins(0)
          .storeUint(0, 8)
          .storeUint(0, 8)
          .storeMaybeRef(null)
          .endCell(),
      );
    f.tx(hub, undefined, [receipt, second.request]);
    f.tx(owner, receipt);
    const ack = f.msg(
      receiver,
      hub,
      beginCell()
        .storeUint(w.RECEIVER_CREDITED, 32)
        .storeUint(BigInt(payout), 64)
        .storeUint(56, 64)
        .storeUint(1, 32)
        .storeUint(0, 8)
        .storeCoins(remainingPayout)
        .storeAddress(A(custody[0]))
        .storeUint(BigInt("0x" + secondPayload.hash().toString("hex")), 256)
        .endCell(),
    );
    f.tx(receiver, second.notification, [ack]);
    f.tx(hub, ack);
  }
  // This wire fixture burns half the outstanding supply, so its 1% fee is
  // nonterminal. A full-supply proportional burn exits at gross backing.
  const data = state(100, 100, 2n * n, [2n * n, 0n, 0n]);
  const afterData = state(100, 100, n, [2n * n - net, 0n, 0n]);
  f.input.stateAt = async (_account, lt, hash) => ({
    seqno: Number(lt),
    state: {
      accountState: "active",
      lastTxLt: lt, lastTxHash: hash,
      codeBoc: code.toBoc().toString("base64"),
      dataBoc: (lt === execute.lt ? afterData : data).toBoc().toString("base64"),
    } as any,
  });
  if (wrapped) {
    for (const message of [notify, proof, hubAck, walletAck, ack])
      wrapNativeFundingMessage(message);
  }
  return {
    ...f,
    n,
    net,
    burn,
    rootBurn,
    hubProof,
    rootAccepted: rootAccepted!,
    walletAccepted: walletAccepted!,
    execute,
    p,
    receiverTx,
    request,
  };
}
function recoveredRedeem(referrer: string | null = null) {
  const f = redeem(false, true, referrer);
  const request = w.burnRequest(f.request)!;
  const requestHash = w.burnRequestHash(root, tw, owner, request);
  const intentHash = w.burnIntentHash(owner, query);
  const binding = {
    network: "localnet" as const,
    hub,
    root,
    hubCodeHash: code.hash().toString("hex"),
    rootCodeHash: code.hash().toString("hex"),
    walletCodeHash: code.hash().toString("hex"),
    receiverCodeHash: code.hash().toString("hex"),
    reserveRoutes: roots.map((r, i) => ({
      root: r,
      vault: vaults[i],
      discovery: r,
    })),
  };
  f.input.t3Hubs!.get(hub)!.redemptionBinding = binding;
  const rootState = (
    pending: boolean,
    accepted = false,
    supply = pending ? f.n : f.n * 2n,
  ) => {
    const receipts = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.BigUint(256),
    );
    const set = (domain: number, party: string, id: string, value: bigint) =>
      receipts.set(
        BigInt("0x" + t3ReceiptKey(domain, root, party, id).toString("hex")),
        value,
      );
    if (pending) {
      for (const domain of [0x4a425354, 0x54334250])
        set(domain, tw, query, BigInt("0x" + requestHash));
      if (accepted) set(0x54334241, tw, query, BigInt("0x" + requestHash));
      set(0x54334257, hub, wire, BigInt("0x" + A(tw).hash.toString("hex")));
      set(0x54334251, hub, wire, BigInt(query));
      set(0x54334249, hub, wire, BigInt("0x" + intentHash));
      set(0x5433424d, hub, wire, f.n);
    }
    return beginCell()
      .storeUint(0x4a545253, 32)
      .storeRef(
        beginCell()
          .storeAddress(A(other))
          .storeUint(1, 8)
          .storeUint(0, 8)
          .storeRef(Cell.EMPTY),
      )
      .storeRef(
        beginCell()
          .storeCoins(supply)
          .storeAddress(A(other))
          .storeRef(code)
          .storeRef(Cell.EMPTY)
          .storeAddress(A(hub)),
      )
      .storeRef(beginCell().storeDict(receipts))
      .storeRef(Cell.EMPTY)
      .endCell();
  };
  // Synthetic archive boundary in the sole current wallet storage layout.
  const walletState = (
    status: number,
    balance = status ? f.n : f.n * 2n,
    journalQuery = status ? BigInt(query) : 0n,
  ) => writeCurrentJettonWalletStorage({
    owner: A(owner), root: A(root), feeDelegate: null,
    balance, lockedFees: 0n, borrowedFees: 0n,
    lastBounceOpcode: 0, lastBounceQueryId: 0n, lastBounceAmount: 0n,
    burnJournal: beginCell().storeUint(status, 8).storeUint(journalQuery, 64)
      .storeCoins(status ? f.n : 0n).storeUint(status ? BigInt("0x" + requestHash) : 0n, 256)
      .storeAddress(status ? A(hub) : null).endCell(),
    mintJournal: beginCell().storeUint(0, 8).storeUint(0, 64).storeUint(0, 64)
      .storeCoins(0).storeUint(0, 256).endCell(),
    mintReceipts: null, referralNotifications: null,
  });
  const hubState = (
    consumed: number | null,
    proofWire = wire,
    proofPayout = payout,
    enabled = 1,
    proofReferrer: string | null = referrer,
  ) => {
    const entries = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    const identities = Dictionary.empty(
      Dictionary.Keys.BigUint(64),
      Dictionary.Values.BigUint(256),
    );
    const payoutBusiness = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    const repeatRefundLinks = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    if (consumed !== null) {
      const key = BigInt("0x" + beginCell().storeUint(0x54335049, 32)
        .storeUint(1, 8).storeAddress(A(owner)).storeUint(BigInt(query), 64)
        .endCell().hash().toString("hex"));
      const referral = inviterCell(proofReferrer);
      const proofPayloadHash = BigInt("0x" + beginCell()
        .storeUint(0x54335249, 32)
        .storeUint(BigInt(query), 64)
        .storeUint(BigInt(proofWire), 64)
        .storeUint(BigInt("0x" + referral.hash().toString("hex")), 256)
        .storeRef(beginCell().storeAddress(A(owner)).storeAddress(A(owner))
          .storeCoins(f.n).storeUint(0, 16).storeUint(0, 8).storeUint(0, 8)
          .endCell())
        .endCell().hash().toString("hex"));
      const referralEconomics = beginCell().storeCoins(0).storeCoins(0)
        .storeCoins(0).storeCoins(0).storeCoins(0).storeUint(0, 32)
        .storeRef(Cell.EMPTY).endCell();
      const reservation = beginCell().storeUint(proofPayloadHash, 256)
        .storeCoins(0).storeCoins(0).storeCoins(0)
        .storeRef(beginCell().storeCoins(0).storeCoins(0).storeCoins(0)
          .storeCoins(0).storeUint(0, 8).storeRef(referralEconomics)
          .endCell()).endCell();
      entries.set(
        key,
        beginCell()
          .storeUint(consumed ? 0n : BigInt(query), 64)
          .storeUint(BigInt(proofWire), 64)
          .storeCoins(f.n)
          .storeUint(BigInt(proofPayout), 64)
          .storeUint(consumed, 8)
          .storeRef(consumed ? Cell.EMPTY : beginCell().storeAddress(A(owner))
            .storeAddress(A(owner)).storeUint(0, 16).storeUint(0, 8)
            .storeUint(0, 8).storeRef(referral).endCell())
          .storeRef(reservation)
          .endCell(),
      );
      identities.set(BigInt(proofPayout), key);
      payoutBusiness.set(key, beginCell().storeUint(BigInt(proofPayout), 64)
        .storeUint(proofPayloadHash, 256).storeDict(Dictionary.empty(
          Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()))
        .endCell());
    }
    const proofs = beginCell()
      .storeUint(BigInt(payout) + 1n, 64)
      .storeDict(entries)
      .storeDict(identities)
      .storeDict(payoutBusiness)
      .storeDict(repeatRefundLinks);
    const bounce = beginCell()
      .storeAddress(null)
      .storeUint(0, 32)
      .storeUint(0, 32)
      .storeCoins(0)
      .storeInt(0, 64)
      .storeRef(Cell.EMPTY)
      .storeRef(proofs)
      .storeRef(emptyReferralState())
      .endCell();
    return state(
      100,
      100,
      consumed ? f.n : 2n * f.n,
      [consumed ? 2n * f.n - f.net : 2n * f.n, 0n, 0n],
      bounce,
      enabled,
    );
  };
  type Archive = NonNullable<Awaited<ReturnType<ProjectionInput["stateAt"]>>>;
  const archives = new Map<string, Archive>();
  const archiveKey = (account: string, lt: string, hash: string) =>
    `${account}:${lt}:${hash}`;
  const snapshot = (data: Cell, lt: string, hash: string): Archive => ({
    seqno: Number(lt),
    state: {
      balance: "1000000000",
      lastTxLt: lt,
      lastTxHash: hash,
      accountState: "active",
      codeBoc: code.toBoc().toString("base64"),
      dataBoc: data.toBoc().toString("base64"),
    },
  });
  const boundary = (
    account: string,
    tx: RawTransaction,
    before: Cell,
    after: Cell,
  ) => {
    archives.set(
      archiveKey(account, tx.prevTransactionLt!, tx.prevTransactionHash!),
      snapshot(before, tx.prevTransactionLt!, tx.prevTransactionHash!),
    );
    archives.set(
      archiveKey(account, tx.lt, tx.hash),
      snapshot(after, tx.lt, tx.hash),
    );
  };
  boundary(tw, f.burn, walletState(0), walletState(4));
  boundary(root, f.rootBurn, rootState(false), rootState(true));
  boundary(hub, f.hubProof, hubState(null), hubState(0));
  boundary(hub, f.execute, hubState(0), hubState(1));
  boundary(root, f.rootAccepted, rootState(true), rootState(true, true));
  boundary(tw, f.walletAccepted, walletState(4), walletState(5));
  f.input.stateAt = async (account, lt, hash) =>
    archives.get(archiveKey(account, lt, hash)) ?? null;
  return {
    ...f,
    archives,
    archiveKey,
    snapshot,
    boundary,
    rootState,
    walletState,
    hubState,
    binding,
  };
}
async function recoveryTests() {
  const f = recoveredRedeem();
  assert.deepEqual(
    validateT3RedemptionBinding(f.binding, "localnet"),
    f.binding,
  );
  for (const value of [undefined, null, "", "  ", JSON.stringify(f.binding)])
    assert.throws(() => validateT3RedemptionBinding(value, "localnet"));
  for (const binding of [
    { ...f.binding, network: "testnet" },
    { ...f.binding, extra: true },
    { ...f.binding, walletCodeHash: " " + f.binding.walletCodeHash },
    { ...f.binding, hub: A(hub).toString() },
    {
      ...f.binding,
      reserveRoutes: [
        f.binding.reserveRoutes[0],
        f.binding.reserveRoutes[0],
        f.binding.reserveRoutes[2],
      ],
    },
    {
      ...f.binding,
      reserveRoutes: f.binding.reserveRoutes.map((r, i) =>
        i ? r : { ...r, discovery: other },
      ),
    },
  ])
    assert.throws(() =>
      validateT3RedemptionBinding(binding, "localnet"),
    );
  const result = (await projectOwnerLedger(f.input)).events.find(
    (e) => e.kind === "t3_redeem",
  )!;
  assert.equal(result.settlement?.status, "confirmed", JSON.stringify(result));
  assert.equal(result.settlement?.t3?.burnRecovery?.status, "accepted");
  assert.equal(result.settlement?.t3?.feeBreakdown, "verified");
  assert.equal(
    result.movements.filter((m) => m.purpose === "t3_burn").length,
    1,
  );
  assert.equal(
    result.movements.find((m) => m.purpose === "t3_burn")?.amountRaw,
    String(f.n),
  );
  assert.equal(
    result.movements.find((m) => m.purpose === "t3_payout")?.amountRaw,
    String(f.net),
  );
  assert.equal(
    result.settlement?.t3?.burnRecovery?.walletAcceptance.after.journal.status,
    5,
  );
  assert.equal(
    result.settlement?.t3?.burnRecovery?.rootAcceptance.before.totalSupplyRaw,
    result.settlement?.t3?.burnRecovery?.rootAcceptance.after.totalSupplyRaw,
  );
  for (const status of [0, 2, 3]) {
    const previousBurn = recoveredRedeem();
    previousBurn.boundary(
      tw,
      previousBurn.burn,
      previousBurn.walletState(status, previousBurn.n * 2n, BigInt(query) - 1n),
      previousBurn.walletState(4),
    );
    const event = (await projectOwnerLedger(previousBurn.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )!;
    assert.equal(
      event.settlement?.status,
      "confirmed",
      `prior journal status ${status} permits a new higher-query burn`,
    );
  }
  const disabledProof = recoveredRedeem();
  // Activation is a separate intervening hub transaction, so its snapshot must
  // not overwrite the historical proof recorded while the hub was disabled.
  const activation = disabledProof.tx(hub);
  activation.prevTransactionLt = disabledProof.execute.prevTransactionLt;
  activation.prevTransactionHash = disabledProof.execute.prevTransactionHash;
  activation.lt = String(BigInt(activation.prevTransactionLt!) + 1n);
  activation.hash = createHash("sha256")
    .update(`hub-activation:${activation.lt}`)
    .digest("base64");
  assert(BigInt(activation.lt) < BigInt(disabledProof.execute.lt));
  const hubTransactions = disabledProof.input.chains.get(hub)!.transactions;
  hubTransactions.splice(hubTransactions.indexOf(activation), 1);
  hubTransactions.splice(
    hubTransactions.indexOf(disabledProof.execute),
    0,
    activation,
  );
  disabledProof.execute.prevTransactionLt = activation.lt;
  disabledProof.execute.prevTransactionHash = activation.hash;
  disabledProof.boundary(
    hub,
    disabledProof.hubProof,
    disabledProof.hubState(null, wire, payout, 0),
    disabledProof.hubState(0, wire, payout, 0),
  );
  disabledProof.boundary(
    hub,
    disabledProof.execute,
    disabledProof.hubState(0),
    disabledProof.hubState(1),
  );
  assert.equal(
    (await projectOwnerLedger(disabledProof.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "confirmed",
    "root proof can predate hub activation",
  );
  const hexHashes = recoveredRedeem();
  for (const snapshot of hexHashes.archives.values())
    snapshot.state.lastTxHash = Buffer.from(
      snapshot.state.lastTxHash!,
      "base64",
    ).toString("hex");
  assert.equal(
    (await projectOwnerLedger(hexHashes.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "confirmed",
    "equivalent archive transaction hashes retain exact boundary identity",
  );
  type Archive = ReturnType<ReturnType<typeof recoveredRedeem>["snapshot"]>;
  const archiveMutations: Array<[string, (snapshot: Archive) => void]> = [
    ["missing transaction LT", (s) => {
      delete s.state.lastTxLt;
    }],
    ["different transaction LT", (s) => {
      s.state.lastTxLt = String(BigInt(s.state.lastTxLt!) + 1n);
    }],
    ["missing transaction hash", (s) => {
      delete s.state.lastTxHash;
    }],
    ["different transaction hash", (s) => {
      s.state.lastTxHash = Buffer.alloc(32, 99).toString("base64");
    }],
    ["malformed transaction hash", (s) => {
      s.state.lastTxHash = "invalid";
    }],
    ["frozen account with retained cells", (s) => {
      s.state.accountState = "frozen";
    }],
    ["uninitialized account with retained cells", (s) => {
      s.state.accountState = "uninitialized";
    }],
    ["unknown account status", (s) => {
      s.state.accountState = null;
    }],
    ["missing account status", (s) => {
      delete s.state.accountState;
    }],
    ["missing state object", (s) => {
      Reflect.set(s, "state", null);
    }],
    ["missing code", (s) => {
      s.state.codeBoc = null;
    }],
    ["missing data", (s) => {
      s.state.dataBoc = null;
    }],
    ["negative masterchain seqno", (s) => {
      s.seqno = -1;
    }],
    ["fractional masterchain seqno", (s) => {
      s.seqno = 1.5;
    }],
    ["unsafe masterchain seqno", (s) => {
      s.seqno = Number.MAX_SAFE_INTEGER + 1;
    }],
    ["string masterchain seqno", (s) => {
      Reflect.set(s, "seqno", String(s.seqno));
    }],
    ["missing masterchain seqno", (s) => {
      Reflect.deleteProperty(s, "seqno");
    }],
  ];
  const mutations: Array<
    [string, (v: ReturnType<typeof recoveredRedeem>) => void]
  > = [
    [
      "non-increasing journal query",
      (v) => {
        v.boundary(
          tw,
          v.burn,
          v.walletState(0, v.n * 2n, BigInt(query)),
          v.walletState(4),
        );
      },
    ],
    [
      "active prior journal",
      (v) => {
        v.boundary(
          tw,
          v.burn,
          v.walletState(4, v.n * 2n, BigInt(query) - 1n),
          v.walletState(4),
        );
      },
    ],
    [
      "disabled continuation",
      (v) => {
        v.boundary(
          hub,
          v.execute,
          v.hubState(0, wire, payout, 0),
          v.hubState(1, wire, payout, 0),
        );
      },
    ],
    [
      "unconfigured binding",
      (v) => {
        delete v.input.t3Hubs!.get(hub)!.redemptionBinding;
      },
    ],
    [
      "wrong network binding",
      (v) => {
        v.binding.network = "testnet" as any;
      },
    ],
    [
      "wrong pinned wallet code",
      (v) => {
        v.binding.walletCodeHash = "00".repeat(32);
      },
    ],
    [
      "wrong pinned root code",
      (v) => {
        v.binding.rootCodeHash = "00".repeat(32);
      },
    ],
    [
      "wrong pinned hub code",
      (v) => {
        v.binding.hubCodeHash = "00".repeat(32);
      },
    ],
    [
      "unavailable original wallet archive",
      (v) => {
        v.archives.delete(v.archiveKey(tw, v.burn.lt, v.burn.hash));
      },
    ],
    [
      "unavailable original root archive",
      (v) => {
        v.archives.delete(v.archiveKey(root, v.rootBurn.lt, v.rootBurn.hash));
      },
    ],
    [
      "unavailable original hub proof archive",
      (v) => {
        v.archives.delete(
          v.archiveKey(
            hub,
            v.hubProof.prevTransactionLt!,
            v.hubProof.prevTransactionHash!,
          ),
        );
      },
    ],
    [
      "unavailable acceptance archive",
      (v) => {
        v.archives.delete(
          v.archiveKey(tw, v.walletAccepted.lt, v.walletAccepted.hash),
        );
      },
    ],
    [
      "missing original balance debit",
      (v) => {
        v.boundary(tw, v.burn, v.walletState(0), v.walletState(4, v.n * 2n));
      },
    ],
    [
      "second supply burn during recovery",
      (v) => {
        v.boundary(
          root,
          v.rootAccepted,
          v.rootState(true),
          v.rootState(true, true, 0n),
        );
      },
    ],
    [
      "missing root accepted tombstone",
      (v) => {
        v.boundary(root, v.rootAccepted, v.rootState(true), v.rootState(true));
      },
    ],
    [
      "second wallet debit during recovery",
      (v) => {
        v.boundary(
          tw,
          v.walletAccepted,
          v.walletState(4),
          v.walletState(5, 0n),
        );
      },
    ],
    [
      "wallet acknowledgement pending",
      (v) => {
        v.walletAccepted.success = false;
        v.walletAccepted.status = "failed";
      },
    ],
    [
      "root acknowledgement pending",
      (v) => {
        v.rootAccepted.success = false;
        v.rootAccepted.status = "failed";
      },
    ],
    [
      "proof not consumed",
      (v) => {
        v.boundary(hub, v.execute, v.hubState(0), v.hubState(0));
      },
    ],
    [
      "wrong proof wire",
      (v) => {
        v.boundary(hub, v.execute, v.hubState(0), v.hubState(1, "123"));
      },
    ],
    [
      "changed payout identity",
      (v) => {
        v.boundary(hub, v.execute, v.hubState(0), v.hubState(1, wire, "456"));
      },
    ],
    [
      "foreign continuation sender",
      (v) => {
        v.execute.inMessage!.source = other;
      },
    ],
    [
      "incomplete root history",
      (v) => {
        v.input.chains.get(root)!.historyComplete = false;
      },
    ],
  ];
  for (const side of ["before", "after"] as const)
    for (const [label, change] of archiveMutations)
      mutations.push([
        `${side} original wallet archive: ${label}`,
        (v) => {
          const key = side === "before"
            ? v.archiveKey(
                tw,
                v.burn.prevTransactionLt!,
                v.burn.prevTransactionHash!,
              )
            : v.archiveKey(tw, v.burn.lt, v.burn.hash);
          change(v.archives.get(key)!);
        },
      ]);
  const boundaries = [
    ["original wallet", tw, "burn"],
    ["original root", root, "rootBurn"],
    ["original hub proof", hub, "hubProof"],
    ["continuation", hub, "execute"],
    ["root acceptance", root, "rootAccepted"],
    ["wallet acceptance", tw, "walletAccepted"],
  ] as const;
  for (const [label, account, name] of boundaries)
    for (const side of ["before", "after"] as const)
      mutations.push([
        `${label} ${side} archive has a foreign transaction anchor`,
        (v) => {
          const tx = v[name];
          const key = side === "before"
            ? v.archiveKey(
                account,
                tx.prevTransactionLt!,
                tx.prevTransactionHash!,
              )
            : v.archiveKey(account, tx.lt, tx.hash);
          v.archives.get(key)!.state.lastTxHash = Buffer.alloc(32, 99)
            .toString("base64");
        },
      ]);
  for (const relation of ["reversed"] as const)
    for (const [label, account, name] of boundaries)
      mutations.push([
        `${label} has ${relation} archive sequence numbers`,
        (v) => {
          const tx = v[name];
          const before = v.archives.get(v.archiveKey(
            account,
            tx.prevTransactionLt!,
            tx.prevTransactionHash!,
          ))!;
          const after = v.archives.get(
            v.archiveKey(account, tx.lt, tx.hash),
          )!;
          before.seqno = after.seqno + (relation === "reversed" ? 1 : 0);
        },
      ]);
  for (const [label, change] of mutations) {
    const v = recoveredRedeem();
    change(v);
    const events = (await projectOwnerLedger(v.input)).events;
    const event = events.find((e) => e.kind === "t3_redeem")!;
    assert.equal(event.settlement?.status, "incomplete", label);
    assert.equal(event.settlement?.t3?.burnRecovery, undefined, label);
    assert.equal(
      events.flatMap((e) => e.movements).filter((m) => m.purpose === "t3_burn")
        .length,
      0,
      label,
    );
  }
  const intrablockBurn = recoveredRedeem();
  for (const snapshot of intrablockBurn.archives.values()) snapshot.seqno = 10;
  const intrablockBurnEvents = (await projectOwnerLedger(intrablockBurn.input)).events;
  const intrablockBurnEvent = intrablockBurnEvents.find(e => e.kind === 't3_redeem')!;
  assert.equal(intrablockBurnEvent.settlement?.status, 'confirmed');
  assert.equal(intrablockBurnEvent.settlement?.t3?.burnRecovery?.status, 'accepted');
  assert.equal(intrablockBurnEvents.flatMap(e => e.movements).filter(m => m.purpose === 't3_burn').length, 1,
    'Exact intrablock recovery does not repeat the burn');
  assert.equal(intrablockBurnEvents.flatMap(e => e.movements).filter(m => m.purpose === 't3_payout').length, 1,
    'Exact intrablock recovery does not repeat the payout');
  const conflictingIdentity = recoveredRedeem();
  conflictingIdentity.input.t3Hubs!.get(hub)!.redemptions.get(query)!.payoutId =
    "999";
  const conflict = (await projectOwnerLedger(conflictingIdentity.input)).events.find(
    (e) => e.kind === "t3_redeem",
  )!;
  assert.equal(conflict.settlement?.status, "incomplete");
  assert(conflict.issues.includes("t3_recovery_payout_identity_mismatch"));
  assert.equal(conflict.settlement?.t3?.burnRecovery?.status, "accepted");
  const noPayout = recoveredRedeem();
  noPayout.receiverTx.outMessages = [];
  const pending = (await projectOwnerLedger(noPayout.input)).events.find(
    (e) => e.kind === "t3_redeem",
  )!;
  assert.equal(
    pending.settlement?.status,
    "incomplete",
    "recovered burn does not certify payout",
  );
  assert.equal(pending.settlement?.t3?.burnRecovery?.status, "accepted");
  assert.equal(
    pending.movements.filter((m) => m.purpose === "t3_burn").length,
    1,
  );
  const replay = recoveredRedeem();
  const retry = replay.tx(tw, { ...replay.request, createdLt: "999999" });
  retry.success = false;
  retry.status = "failed";
  replay.input.chains.get(tw)!.transactions.reverse();
  const replayEvents = (await projectOwnerLedger(replay.input)).events;
  assert.equal(
    replayEvents.find((e) => e.kind === "t3_redeem")?.settlement?.status,
    "confirmed",
  );
  assert.equal(
    replayEvents
      .flatMap((e) => e.movements)
      .filter((m) => m.purpose === "t3_burn").length,
    1,
  );
  console.log(
    `T3 recovery: original/continuation archive boundaries, ${mutations.length} adversarial cases, payout separation and replay passed`,
  );
}
async function database() {
  const f = redeem(),
    db = new PGlite(),
    pool: LedgerSqlPool = {
      query: async (sql, args) =>
        !args && sql.includes(";")
          ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] }
          : db.query(sql, args),
      connect: async () => pool,
      end: () => db.close(),
    },
    store = new PostgresLedgerStore(pool);
  let partial = true,
    wrong = false;
  const int = (v: number | string) => ({
      type: "int" as const,
      value: BigInt(v),
    }),
    cell = (v: string) => ({
      type: "slice" as const,
      cell: beginCell().storeAddress(A(v)).endCell(),
    });
  const source: TonDataSource = {
    network: "localnet",
    getMasterchainInfo: async () => ({ seqno: 1 }),
    getAccountState: async (a) => {
      const head = f.input.chains.get(a)?.transactions.at(-1);
      return {
        balance: "0",
        lastTxLt: head?.lt,
        lastTxHash: head?.hash,
        accountState: "active",
        codeBoc: code.toBoc().toString("base64"),
        ...(a === hub ? { dataBoc: state().toBoc().toString("base64") } : {}),
      };
    },
    getTransactions: async (a, limit, lt) =>
      a === receiver && partial
        ? []
        : (f.input.chains.get(a)?.transactions ?? [])
            .filter((t) => !lt || BigInt(t.lt) <= BigInt(lt))
            .slice()
            .reverse()
            .slice(0, limit),
    getJettonBalance: async (o, r) => {
      const a = [...f.input.wallets.values()].find(
        (a) => a.owner === o && a.master === r,
      );
      return a ? { wallet: a.wallet!, balance: "0" } : null;
    },
    getJettonMetadata: async () => ({ decimals: 9 }),
    close: async () => {},
    runGetMethod: async (a, m) => {
      const wallet = f.input.wallets.get(a);
      if (m === "get_wallet_data" && wallet)
        return {
          exitCode: 0,
          stack: [
            int(0),
            cell(wallet.owner!),
            cell(wallet.master!),
            { type: "cell", cell: Cell.EMPTY },
          ],
        };
      if (a === root && m === "root_emitter")
        return { exitCode: 0, stack: [cell(wrong ? other : hub)] };
      if (a === hub && m === "vault_routes")
        return {
          exitCode: 0,
          stack: [
            int(1),
            { type: "cell", cell: code },
            { type: "cell", cell: Cell.EMPTY },
            ...roots.flatMap((r) => [
              cell(r),
              cell(other),
              int(1),
              int(1),
              int(1),
            ]),
          ],
        };
      if (a === hub && m === "vault_addresses")
        return { exitCode: 0, stack: vaults.map(cell) };
      if (a === receiver && m === "receiver_identity")
        return { exitCode: 0, stack: [int(1), cell(hub), cell(owner)] };
      if (a === hub && m === "redemption_identity")
        return { exitCode: 0, stack: [int(1), int(payout), int(1), int(wire)] };
      return null;
    },
  };
  const service = new LedgerService(
    "localnet",
    store,
    source,
    loadOpcodes(),
    createLogger("silent"),
    2,
    { t3Hub: hub, t3Root: root, maxPagesPerSync: 100 },
  );
  try {
    await store.initialize();
    await service.syncAccount(owner);
    let page = await store.page("localnet", owner);
    assert.equal(page.coverage.historyComplete, false);
    assert(
      !page.events.some(
        (e) => e.kind === "t3_redeem" && e.settlement?.status === "confirmed",
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
        (e) => e.kind === "t3_redeem" && e.settlement?.status === "confirmed",
      ),
      JSON.stringify(page.events),
    );
    assert(
      page.coverage.relatedAccounts?.some(
        (a) => a.account === receiver && a.role === "controlled_contract",
      ),
    );
    const generation = page.coverage.generation;
    await service.syncAccount(owner);
    assert.equal(
      (await store.page("localnet", owner)).coverage.generation,
      generation,
      "unchanged receiver/identity evidence must reuse durable snapshot",
    );
    wrong = true;
    await service.syncAccount(owner);
    page = await store.page("localnet", owner);
    assert(
      !page.events.some(
        (e) => e.kind === "t3_redeem" && e.settlement?.status === "confirmed",
      ),
    );
    assert(
      page.coverage.issues.includes("t3_hub_identity_or_custody_unresolved"),
    );
  } finally {
    await service.stop();
    await pool.end();
  }
}
async function main() {
  const currentBounce = emptyBounceState();
  assert.equal(currentBounce.bits.length, 134, "Empty current bounce tuple is exactly 134 bits");
  assert.equal(currentBounce.refs.length, 3, "Mint, burn and referral journals are mandatory");
  const controlBounce = beginCell().storeAddress(A(other)).storeUint(0x52474d44, 32).storeUint(7, 32)
    .storeCoins(40_000_000).storeInt(1_800_000_000, 64);
  currentBounce.refs.forEach(ref => controlBounce.storeRef(ref));
  const controlState = state(100, 100, 1000n, [1000n, 0n, 0n], controlBounce.endCell()).toBoc().toString('base64');
  assert.equal(w.t3State(controlState).mintFeeBps, 100);
  assert.equal(readT3RecoveryHub(controlState, owner, query).proof, null);
  const obsoleteBounce = beginCell().storeSlice(currentBounce.beginParse())
    .storeAddress(null).storeUint(0, 32).storeCoins(0).storeInt(0, 64).endCell();
  const obsoleteBounceState = state(100, 100, 1000n, [1000n, 0n, 0n], obsoleteBounce).toBoc().toString('base64');
  assert.throws(() => w.t3State(obsoleteBounceState), /Trailing T3 wire/);
  assert.throws(() => readT3RecoveryHub(obsoleteBounceState, owner, query), /trailing/i);
  const current = state();
  const reserve = 75_000n * 1_000_000_000n;
  const twoLegSupply = reserve * 2n;
  const threeLegSupply = reserve * 3n;
  const twoLeg = w.t3State(state(0, 0, twoLegSupply, [reserve, reserve, 0n]).toBoc().toString('base64'));
  const threeLeg = w.t3State(state(0, 0, threeLegSupply, [reserve, reserve, reserve]).toBoc().toString('base64'));
  assert.deepEqual(w.redemptionFees(twoLeg, '1000000000', 0, 0)?.net,
    ['500000000', '500000000', '0'], 'two-leg proportional payout uses direct per-leg floor');
  assert.deepEqual(w.redemptionFees(threeLeg, '1000000000', 0, 0)?.net,
    ['333333333', '333333333', '333333333'], 'three-leg proportional payout uses direct per-leg floor');
  assert.deepEqual(w.redemptionFees(twoLeg, '1000000000', 1, 0)?.net,
    ['999999966', '0', '0'], 'two-leg single payout retains the rounded output atom');
  assert.deepEqual(w.redemptionFees(threeLeg, '1000000000', 1, 0)?.net,
    ['999999955', '0', '0'], 'three-leg single payout retains the rounded output atom');
  const small = w.t3State(state(0, 0, 10n, [5n, 5n, 0n]).toBoc().toString('base64'));
  assert.deepEqual(w.redemptionFees(small, '3', 0, 0)?.net,
    ['1', '1', '0'], 'small proportional burns cannot collect a rounded-up share from each leg');
  const terminal = w.t3State(state(100, 100, twoLegSupply, [reserve, reserve, 0n]).toBoc().toString('base64'));
  assert.deepEqual(w.redemptionFees(terminal, twoLegSupply.toString(), 0, 0),
    { net: [reserve.toString(), reserve.toString(), '0'], fees: ['0', '0', '0'] },
    'terminal proportional exit returns all backing without a redemption fee');
  assert.equal(w.redemptionFees(terminal, twoLegSupply.toString(), 1, 0), null,
    'terminal single-leg exit is invalid');
  const payload = current.refs[0];
  const refs = [...payload.refs];
  refs[2] = beginCell().storeRef(refs[2].refs[2]).storeRef(refs[2].refs[3]).endCell();
  const obsoleteRuntime = new Cell({ bits: current.bits, refs: [new Cell({ bits: payload.bits, refs })] });
  assert.throws(() => w.t3State(obsoleteRuntime.toBoc().toString('base64')), /peg runtime layout/);

  const referredMint = mint([amount, 0n, 0n], other);
  const referredMintEvent = (await projectOwnerLedger(referredMint.input)).events.find(e => e.kind === "t3_mint")!;
  assert.equal(referredMintEvent.settlement?.status, "confirmed");
  assert.equal(referredMintEvent.settlement?.t3?.referrer, other);
  const threeBasket = [1_000_000_000n, 1_000_000_001n, 1_000_000_002n];
  const referredBasket = mint(threeBasket, other);
  assert.equal((await projectOwnerLedger(referredBasket.input)).events.find(e => e.kind === "t3_mint")?.settlement?.t3?.referrer, other);
  const referredRedemption = recoveredRedeem(other);
  const referredRedeemEvent = (await projectOwnerLedger(referredRedemption.input)).events.find(e => e.kind === "t3_redeem")!;
  assert.equal(referredRedeemEvent.settlement?.status, "confirmed", JSON.stringify(referredRedeemEvent));
  assert.equal(referredRedeemEvent.settlement?.t3?.referrer, other);
  const swappedInvitation = recoveredRedeem(other);
  swappedInvitation.boundary(hub, swappedInvitation.execute,
    swappedInvitation.hubState(0, wire, payout, 1, owner), swappedInvitation.hubState(1, wire, payout, 1, owner));
  assert.notEqual((await projectOwnerLedger(swappedInvitation.input)).events.find(e => e.kind === "t3_redeem")?.settlement?.status, "confirmed", "A continuation may not replace the original inviter");
  const oldDeposit = beginCell().storeUint(w.DEPOSIT_NOTE, 32).storeUint(1, 8).storeUint(1, 8).storeUint(10000, 16).storeAddress(A(owner)).endCell();
  assert.equal(w.depositNote(oldDeposit), null, "Old deposit without mandatory referral reference is unsupported");
  assert.equal(w.depositNote(beginCell().storeSlice(oldDeposit.beginParse()).storeRef(inviterCell(other)).endCell())?.referrer, other);
  assert.throws(() => w.referralAddress(beginCell().storeAddress(A(other)).storeUint(1, 1).endCell()));
  const oldBurn = beginCell().storeUint(0x54335242, 32).storeAddress(A(owner)).storeUint(0, 16).storeUint(0, 8).storeUint(0, 8).endCell();
  assert.equal(w.burnPayload(oldBurn), null, "Old burn application without mandatory inviter is unsupported");
  assert.equal(w.burnPayload(beginCell().storeSlice(oldBurn.beginParse()).storeAddress(A(other)).endCell())?.referrer, other);
  assert.throws(() => w.t3State(state(100, 100, 1000n, [1000n, 0n, 0n], Cell.EMPTY).toBoc().toString("base64")), "Old hub storage without referral state is unsupported");

  const archivedReceipt = beginCell().storeUint(w.T3_MINT_RECEIPT, 32).storeUint(25, 64).storeAddress(A(owner)).storeCoins(100)
    .storeCoins(100).storeCoins(0).storeCoins(0).storeMaybeRef(null).endCell();
  const archivedMint = beginCell().storeUint(4, 8).storeUint(25, 64).storeUint(3, 64).storeCoins(100)
    .storeAddress(A(owner)).storeRef(beginCell().storeAddress(A(owner))
      .storeUint(42, 256).storeCoins(0).storeRef(archivedReceipt)
      .storeRef(beginCell().storeUint(25, 64).storeUint(0, 8)
        .storeUint(0, 32).storeAddress(A(owner)).endCell()).endCell()).endCell();
  const completedMints = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  const archivedKey = BigInt(`0x${beginCell().storeUint(0x54334d52, 32).storeAddress(A(owner)).storeUint(25, 64).endCell().hash().toString('hex')}`);
  completedMints.set(archivedKey, archivedMint);
  assert.doesNotThrow(() => w.readT3ReferralState(emptyReferralState(completedMints)));
  completedMints.set(archivedKey + 1n, archivedMint);
  assert.throws(() => w.readT3ReferralState(emptyReferralState(completedMints)), /archived mint identity/);
  assert.equal(w.t3State(state().toBoc().toString("base64")).mintFeeBps, 100);
  const m = mint(),
    events = (await projectOwnerLedger(m.input)).events,
    event = events.find((e) => e.kind === "t3_mint")!;
  assert.equal(event.settlement?.status, "confirmed", JSON.stringify(events));
  assert.equal(event.settlement?.t3?.amountRaw, String(m.minted));
  assert.equal(event.settlement?.t3?.feeBreakdown, "verified");
  assert.equal(
    event.movements.filter((v) => v.purpose === "t3_mint").length,
    1,
  );
  const outs = event.movements.filter(
    (v) => v.asset.id === `localnet:jetton:${roots[0]}` && v.direction !== "in",
  );
  assert.equal(
    outs.reduce((a, v) => a + BigInt(v.amountRaw), 0n),
    amount,
  );
  assert.equal(
    outs.find((v) => v.purpose === "protocol_fee")?.amountRaw,
    String(amount - m.minted),
  );
  const fundedMint = mint([amount, 0n, 0n], null, true);
  const fundedEvents = (await projectOwnerLedger(fundedMint.input)).events;
  const fundedEvent = fundedEvents.find((e) => e.kind === 't3_mint')!;
  assert.equal(fundedEvent.settlement?.status, 'confirmed', JSON.stringify(fundedEvents));
  assert.equal(fundedEvent.settlement?.t3?.amountRaw, String(fundedMint.minted));
  assert.equal(fundedEvent.settlement?.t3?.feeBreakdown, 'verified');
  assert(
    event.movements.some(
      (v) => v.direction === "fee" && v.asset.kind === "native",
    ),
  );
  const three = mint(threeBasket);
  const threeEvent = (await projectOwnerLedger(three.input)).events.find(
    (e) => e.kind === "t3_mint",
  )!;
  assert.equal(threeEvent.settlement?.status, "confirmed");
  assert.deepEqual(
    threeEvent.settlement?.t3?.basketRaw,
    threeBasket.map(String),
  );
  assert.deepEqual(threeEvent.settlement?.t3?.feeAmountsRaw, ["0", "0", "0"]);
  assert.equal(
    threeEvent.movements.filter((m) => m.purpose === "t3_collateral").length,
    3,
  );
  const proportionalTwo = mint([100n, 100n, 0n], null, false, false,
    { beforeBalances: [1000n, 1000n, 0n], fees: [0n, 0n, 0n], minted: 200n });
  const proportionalTwoEvent = (await projectOwnerLedger(proportionalTwo.input)).events.find(e => e.kind === 't3_mint')!;
  assert.equal(proportionalTwoEvent.settlement?.status, 'confirmed');
  assert.equal(proportionalTwoEvent.settlement?.t3?.feeBreakdown, 'verified');
  assert.deepEqual(proportionalTwoEvent.settlement?.t3?.feeAmountsRaw, ['0', '0', '0']);
  assert.equal(proportionalTwoEvent.movements.filter(m => m.purpose === 'protocol_fee').length, 0,
    'Two active proportional reserve legs do not incur an invented imbalance fee');
  const skewedTwo = mint([200n, 100n, 0n], null, false, false,
    { beforeBalances: [1000n, 1000n, 0n], fees: [2n, 1n, 0n], minted: 297n });
  const skewedTwoEvent = (await projectOwnerLedger(skewedTwo.input)).events.find(e => e.kind === 't3_mint')!;
  assert.equal(skewedTwoEvent.settlement?.status, 'confirmed');
  assert.equal(skewedTwoEvent.settlement?.t3?.feeBreakdown, 'verified');
  assert.deepEqual(skewedTwoEvent.settlement?.t3?.feeAmountsRaw, ['2', '1', '0']);
  assert.equal(skewedTwoEvent.movements.filter(m => m.purpose === 'protocol_fee')
    .reduce((total, movement) => total + BigInt(movement.amountRaw), 0n), 3n);
  const skewedThree = mint([100n, 101n, 102n], null, false, false,
    { beforeBalances: [1000n, 1000n, 1000n], fees: [1n, 2n, 2n], minted: 298n });
  const skewedThreeEvent = (await projectOwnerLedger(skewedThree.input)).events.find(e => e.kind === 't3_mint')!;
  assert.equal(skewedThreeEvent.settlement?.status, 'confirmed');
  assert.equal(skewedThreeEvent.settlement?.t3?.feeBreakdown, 'verified');
  assert.deepEqual(skewedThreeEvent.settlement?.t3?.feeAmountsRaw, ['1', '2', '2'],
    'Three nonzero legs do not exempt an imbalanced mint');
  const staleFee = mint();
  const exactFeeArchive = staleFee.input.stateAt;
  staleFee.input.stateAt = async (account, lt, hash) => {
    const snapshot = await exactFeeArchive(account, lt, hash);
    return snapshot && lt === staleFee.origin.lt ? { ...snapshot, state: { ...snapshot.state,
      lastTxHash: Buffer.alloc(32).toString('base64') } } : snapshot;
  };
  const staleFeeEvent = (await projectOwnerLedger(staleFee.input)).events.find(e => e.kind === 't3_mint')!;
  assert.equal(staleFeeEvent.settlement?.status, 'confirmed', 'Physical token delivery remains independently proved');
  assert.equal(staleFeeEvent.settlement?.t3?.feeBreakdown, 'unavailable',
    'A stale fee state cannot fabricate verified attribution');
  const missingLeg = mint(threeBasket);
  missingLeg.input.chains.get(wallets[1])!.transactions = [];
  assert.equal(
    (await projectOwnerLedger(missingLeg.input)).events.find(
      (e) => e.kind === "t3_mint",
    )?.settlement?.status,
    "incomplete",
  );
  const retryFee = mint();
  retryFee.origin.inMessage = retryFee.msg(
    owner,
    hub,
    beginCell()
      .storeUint(0x4d525459, 32)
      .storeAddress(A(owner))
      .storeUint(BigInt(query), 64)
      .endCell(),
  );
  const retried = (await projectOwnerLedger(retryFee.input)).events.find(
    (e) => e.kind === "t3_mint",
  )!;
  assert.equal(
    retried.settlement?.t3?.feeBreakdown,
    "unavailable",
    "mint retry state cannot substitute for original fee assessment state",
  );
  assert.equal(retried.settlement?.status, 'incomplete',
    'A retry message without an authenticated original liability stays unresolved');
  const recoveredMint = mint([amount, 0n, 0n], other, false, true);
  const recoveredEvents = (await projectOwnerLedger(recoveredMint.input)).events;
  const recovered = recoveredEvents.find(e => e.kind === 't3_mint')!;
  assert.equal(recovered.settlement?.status, 'confirmed', JSON.stringify({
    status: recovered.settlement?.status, issues: recovered.issues, queryId: recovered.settlement?.t3?.queryId,
  }));
  assert.equal(recovered.settlement?.t3?.feeBreakdown, 'verified');
  assert.equal(recovered.settlement?.t3?.referrer, other,
    'Recovery retains the original deposit invitation');
  assert.equal(recovered.movements.filter(m => m.purpose === 't3_mint').length, 1);
  assert.equal(recovered.movements.filter(m => m.purpose === 't3_collateral' || m.purpose === 'protocol_fee')
    .reduce((total, movement) => total + BigInt(movement.amountRaw), 0n), amount,
    'Recovery attributes the original physical debit exactly once');
  for (const attempted of [recoveredMint.originalAdmission!, recoveredMint.failedRoot!,
    recoveredMint.parkedAt!, recoveredMint.origin]) {
    assert(recovered.settlement?.t3?.localNetworkFees.some(fee => fee.transaction.lt === attempted.lt),
      `Missing native fee attribution for mint attempt ${attempted.lt}`);
  }
  const twice = mint([amount, 0n, 0n], other, false, 2);
  const twiceEvent = (await projectOwnerLedger(twice.input)).events.find(e => e.kind === 't3_mint')!;
  assert.equal(twiceEvent.settlement?.status, 'confirmed', JSON.stringify(twiceEvent.issues));
  assert.equal(twiceEvent.settlement?.t3?.feeBreakdown, 'verified');
  assert.equal(twiceEvent.settlement?.t3?.referrer, other);
  assert.notEqual(w.mintStart(twice.originalAdmission!.outMessages[0])!.queryId,
    w.mintStart(twice.failedRoot!.inMessage)!.queryId,
    'The original wire differs from the most recently parked wire');
  for (const attempted of [...twice.failedAttempts, ...twice.parkedAttempts, ...twice.retryAttempts])
    assert(twiceEvent.settlement?.t3?.localNetworkFees.some(fee => fee.transaction.lt === attempted.lt),
      'Every intermediate attempt retains its physical native fees');
  const duplicatedFinality = mint([amount, 0n, 0n], other, false, 'duplicate-finalize');
  const duplicateEvent = (await projectOwnerLedger(duplicatedFinality.input)).events.find(e => e.kind === 't3_mint')!;
  assert.equal(duplicateEvent.settlement?.status, 'confirmed', JSON.stringify(duplicateEvent.issues));
  assert.equal(duplicateEvent.movements.filter(m => m.purpose === 't3_mint').length, 1);
  for (const attempted of [...duplicatedFinality.parkedAttempts, ...duplicatedFinality.retryAttempts])
    assert(duplicateEvent.settlement?.t3?.localNetworkFees.some(fee => fee.transaction.lt === attempted.lt),
      'The exact duplicate finalizer and pending finalize retry retain their native fees');
  const intrablock = mint([amount, 0n, 0n], null, false, true);
  const intrablockState = intrablock.input.stateAt;
  intrablock.input.stateAt = async (account, lt, hash) => {
    const snapshot = await intrablockState(account, lt, hash);
    return snapshot ? { ...snapshot, seqno: 10 } : null;
  };
  assert.equal((await projectOwnerLedger(intrablock.input)).events.find(e => e.kind === 't3_mint')?.settlement?.status,
    'confirmed', 'Exact distinct intrablock boundaries may share one containing masterchain seqno');
  const unresolvedRetry = async (label: string, mutate: (f: ReturnType<typeof mint>) => void) => {
    const fixture = mint([amount, 0n, 0n], other, false, true);
    mutate(fixture);
    const events = (await projectOwnerLedger(fixture.input)).events;
    assert.equal(events.find(e => e.kind === 't3_mint')?.settlement?.status, 'incomplete', label);
    assert.equal(events.filter(e => e.kind === 't3_mint' && e.settlement?.status === 'confirmed').length, 0, label);
  };
  await unresolvedRetry('Missing original admission archive cannot verify a recovered mint',
    f => { f.archives.delete(f.originalAdmission!.lt); });
  await unresolvedRetry('Missing retained-liability archive cannot verify a recovered mint',
    f => { f.archives.delete(f.parkedAt!.lt); });
  await unresolvedRetry('A retry cannot name a different business owner', f => {
    f.origin.inMessage = f.msg(owner, hub, beginCell().storeUint(0x4d525459, 32)
      .storeAddress(A(other)).storeUint(BigInt(query), 64).endCell());
  });
  await unresolvedRetry('A finalized callback cannot park a SENT start refusal', f => {
    const impossible = f.msg(root, hub, beginCell().storeUint(w.MINT_FINALIZED, 32)
      .storeUint(BigInt(rootQuery) - 1n, 64).storeCoins(f.minted).storeAddress(A(owner)).storeUint(0, 256).endCell());
    wrapNativeFundingMessage(impossible, (BigInt(rootQuery) - 1n).toString());
    Object.assign(f.parkedAt!.inMessage!, impossible);
  });
  await unresolvedRetry('A retry cannot substitute another retained amount', f => {
    const failed = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    const receipt = beginCell().storeUint(w.T3_MINT_RECEIPT, 32).storeUint(BigInt(query), 64)
      .storeAddress(A(owner)).storeCoins(f.minted).storeCoins(amount).storeCoins(0).storeCoins(0)
      .storeMaybeRef(null).endCell();
    failed.set(mintBusinessKey(), mintJournal(2, (BigInt(rootQuery) - 1n).toString(), f.minted + 1n, receipt));
    f.archives.set(f.parkedAt!.lt, state(100, 100, 1000n + f.minted, [1000n + amount, 0n, 0n],
      emptyBounceState(mintLane(rootQuery, mintJournal(0, '0', 0n, Cell.EMPTY), failed)), 1,
      feeCell([amount - f.minted, 0n, 0n])));
  });
  await unresolvedRetry('A foreign Hub code archive cannot verify recovery', f => {
    const original = f.input.stateAt;
    f.input.stateAt = async (account, lt, hash) => {
      const snapshot = await original(account, lt, hash);
      return snapshot && lt === f.origin.lt ? { ...snapshot, state: { ...snapshot.state,
        codeBoc: beginCell().storeUint(99, 32).endCell().toBoc().toString('base64') } } : snapshot;
    };
  });
  for (const [label, mutate] of [
    ['stale transaction LT', (snapshot: any) => { snapshot.state.lastTxLt = '1'; }],
    ['different transaction hash', (snapshot: any) => { snapshot.state.lastTxHash = Buffer.alloc(32).toString('base64'); }],
    ['decreasing masterchain seqno', (snapshot: any) => { snapshot.seqno = 0; }],
    ['unsafe masterchain seqno', (snapshot: any) => { snapshot.seqno = Number.MAX_SAFE_INTEGER + 1; }],
  ] as const) {
    await unresolvedRetry(`A ${label} archive cannot verify recovery`, f => {
      const original = f.input.stateAt;
      f.input.stateAt = async (account, lt, hash) => {
        const snapshot = await original(account, lt, hash);
        if (!snapshot || lt !== f.origin.lt) return snapshot;
        const changed = { ...snapshot, state: { ...snapshot.state } };
        mutate(changed);
        return changed;
      };
    });
  }
  const missingIntermediate = mint([amount, 0n, 0n], other, false, 2);
  missingIntermediate.archives.delete(missingIntermediate.retryAttempts[0].lt);
  assert.equal((await projectOwnerLedger(missingIntermediate.input)).events.find(e => e.kind === 't3_mint')?.settlement?.status,
    'incomplete', 'Missing intermediate rotation archives cannot be inferred from matching business terms');
  for (const mode of ['refusal-on-finalizing', 'wrong-final-hash', 'wrong-final-authority'] as const) {
    const malformed = mint([amount, 0n, 0n], other, false, 'duplicate-finalize');
    const old = malformed.parkedAt!.inMessage!;
    if (mode === 'refusal-on-finalizing') {
      const original = malformed.originalAdmission!.outMessages[0];
      const rich = malformed.msg(root, hub, beginCell().storeUint(0xfffffffe, 32)
        .storeRef(Cell.fromBase64(original.body!)).storeRef(beginCell().storeCoins(400_000_000n)
          .storeBit(false).storeUint(0, 64).storeUint(0, 32))
        .storeUint(0, 8).storeInt(1103, 32).storeBit(false).endCell());
      rich.bounced = true; Object.assign(old, rich);
    } else {
      const finalized = w.mintFinalize(old, w.MINT_FINALIZED)!;
      const business = beginCell().storeUint(w.MINT_FINALIZED, 32).storeUint(BigInt(finalized.queryId), 64)
        .storeCoins(BigInt(finalized.amountRaw)).storeAddress(A(owner))
        .storeUint(mode === 'wrong-final-hash' ? BigInt('0x' + finalized.requestHash) + 1n : BigInt('0x' + finalized.requestHash), 256).endCell();
      const envelope = beginCell().storeUint(NATIVE_FUNDING, 32).storeUint(BigInt(finalized.queryId), 64)
        .storeUint(0, 8).storeUint(0, 32).storeAddress(A(mode === 'wrong-final-authority' ? other : owner))
        .storeRef(business).endCell();
      Object.assign(old, malformed.msg(root, hub, envelope));
    }
    const event = (await projectOwnerLedger(malformed.input)).events.find(e => e.kind === 't3_mint')!;
    assert.equal(event.settlement?.status, 'incomplete', mode);
  }
  await unresolvedRetry('Trailing fields in the current mint lane are rejected', f => {
    const archived = f.archives.get(f.origin.lt)!;
    const payload = archived.refs[0], bounce = payload.refs[3], lane = bounce.refs[0];
    const replacement = beginCell().storeSlice(lane.beginParse()).storeBit(false).endCell();
    const replace = (cell: Cell, index: number, ref: Cell) => {
      const builder = beginCell().storeBits(cell.bits);
      cell.refs.forEach((old, i) => builder.storeRef(i === index ? ref : old));
      return builder.endCell();
    };
    f.archives.set(f.origin.lt, replace(archived, 0, replace(payload, 3, replace(bounce, 0, replacement))));
  });
  const noHistory = mint();
  noHistory.input.chains.get(root)!.historyComplete = false;
  assert.equal(
    (await projectOwnerLedger(noHistory.input)).events.find(
      (e) => e.kind === "t3_mint",
    )?.settlement?.status,
    "incomplete",
  );
  for (const [wireStage, projectedStage] of [
    ['queued', 'refund_queued'],
    ['dispatching', 'refund_dispatching'],
    ['credited', 'receiver_credited'],
  ] as const) {
    const rejected = rejectedMintRefund(wireStage);
    const result = await projectOwnerLedger(rejected.input);
    const refunded = result.events.find(e => e.kind === 't3_mint' && e.settlement?.t3?.refund);
    assert(refunded, `missing ${wireStage} refund projection`);
    assert.equal(refunded.status, 'success', 'the original physical debit was successful');
    assert.equal(refunded.settlement?.status, 'incomplete', 'refund is not a completed T3 mint');
    assert.equal(refunded.settlement?.t3?.stage, projectedStage);
    assert.equal(refunded.settlement?.t3?.queryId, query);
    assert.deepEqual(refunded.settlement?.t3?.basketRaw, [String(rejected.raw), '0', '0']);
    assert.deepEqual(refunded.settlement?.t3?.deliveredRaw,
      wireStage === 'credited' ? [String(rejected.raw), '0', '0'] : ['0', '0', '0']);
    assert.equal(refunded.settlement?.t3?.refund?.kind, 3);
    assert.equal(refunded.settlement?.t3?.refund?.businessQueryId, query);
    assert.equal(refunded.settlement?.t3?.refund?.payoutId, refundPayout);
    assert(refunded.settlement?.evidence.some(ref => ref.account === hub && ref.lt === rejected.hubAdmission.lt));
    assert.equal(Boolean(refunded.settlement?.t3?.refund?.queueEvidence), wireStage === 'queued');
    assert.equal(Boolean(refunded.settlement?.t3?.refund?.payoutEvidence), wireStage === 'dispatching');
    assert.equal(Boolean(refunded.settlement?.t3?.refund?.creditEvidence), wireStage === 'credited');
    assert.equal(refunded.movements.filter(m => m.purpose === 't3_refund').length,
      wireStage === 'credited' ? 1 : 0);
    assert.equal(refunded.movements.filter(m => m.purpose === 't3_mint').length, 0);
    assert(refunded.movements.some(m => m.direction === 'out' && m.amountRaw === String(rejected.raw) &&
      m.asset.kind === 'jetton' && m.asset.master === roots[0] && m.asset.owner === owner),
      'the original gross owner debit remains explicit in a refund lifecycle event');
    assert.equal(refunded.settlement?.t3?.referrer, null);
  }
  const repeatedRefund = rejectedMintRefund('queued', 5);
  const repeatEvent = (await projectOwnerLedger(repeatedRefund.input)).events.find(e => e.kind === 't3_mint' && e.settlement?.t3?.refund)!;
  assert.equal(repeatEvent.settlement?.t3?.refund?.kind, 5);
  assert.equal(repeatEvent.settlement?.t3?.queryId, query);
  assert.equal(repeatEvent.settlement?.t3?.refund?.businessQueryId, repeatedRefund.hubAdmission.lt);
  const discoveredRefund = await discoverRejectedMintRefund();
  assert.equal(discoveredRefund.graph.t3Hubs.get(hub)?.refunds?.get(discoveredRefund.admissionLt)?.payoutId, refundPayout,
    `graph must bind current immutable identity to the original Hub notification: ${JSON.stringify({issues: discoveredRefund.graph.issues, hubs: [...discoveredRefund.graph.t3Hubs.keys()], refunds: [...(discoveredRefund.graph.t3Hubs.get(hub)?.refunds?.keys() ?? [])]})}`);
  const forgedRefund = await discoverRejectedMintRefund('1');
  assert.equal(forgedRefund.graph.t3Hubs.get(hub)?.refunds?.size, 0,
    'a Hub identity whose immutable payload hash differs from the credited basket is inert');
  const discoveredRepeat = await discoverRejectedMintRefund(undefined, 5);
  assert.equal(discoveredRepeat.graph.t3Hubs.get(hub)?.refunds?.get(discoveredRepeat.admissionLt)?.businessQueryId,
    discoveredRepeat.admissionLt, 'repeat refund business identity must bind the physical Hub LT');
  const newestFirst = await discoverRejectedMintRefund(undefined, 3, true);
  assert.equal(newestFirst.graph.t3Hubs.get(hub)?.refunds?.get(newestFirst.admissionLt)?.kind, 3,
    'newest-first account history must not assign the original kind-3 refund to the replay');
  assert.equal(newestFirst.graph.t3Hubs.get(hub)?.refunds?.get(newestFirst.repeatAdmissionLt!)?.kind, 5,
    'the later colliding deposit must retain its kind-5 identity');
  const mintedThenRepeated = mint();
  const repeatedNote = beginCell().storeUint(w.DEPOSIT_NOTE, 32).storeUint(1, 8)
    .storeUint(1, 8).storeUint(10000, 16).storeAddress(A(owner))
    .storeRef(inviterCell()).endCell();
  const rejectedRepeat = mintedThenRepeated.transfer(owner, wallets[0], hub,
    vaults[0], query, amount, repeatedNote);
  mintedThenRepeated.tx(owner, undefined, [rejectedRepeat.request]);
  const repeatedReceipt = mintedThenRepeated.msg(hub, owner, beginCell()
    .storeUint(w.T3_MINT_RECEIPT, 32).storeUint(BigInt(query), 64)
    .storeAddress(A(owner)).storeCoins(0).storeCoins(amount)
    .storeCoins(0).storeCoins(0).storeMaybeRef(null).endCell());
  const repeatedAdmission = mintedThenRepeated.tx(hub, rejectedRepeat.notification,
    [repeatedReceipt]);
  mintedThenRepeated.tx(owner, repeatedReceipt);
  const repeatObservedAt = '2026-09-25T00:00:00.000Z';
  const repeatBasket = [String(amount), '0', '0'];
  mintedThenRepeated.input.t3Hubs!.get(hub)!.refunds = new Map([[
    repeatedAdmission.lt, {
      kind: 5, businessQueryId: repeatedAdmission.lt, payoutId: refundPayout,
      token: 0, amountRaw: String(amount), basketRaw: repeatBasket,
      identityEvidence: { account: hub, method: 'vault_payout_identity',
        args: ['5', owner, repeatedAdmission.lt],
        result: ['1', refundPayout, w.refundPayloadHash(5, owner, repeatBasket)],
        observedAt: repeatObservedAt },
      queueEvidence: { account: hub, method: 'refund_queue_item',
        args: ['5', owner, repeatedAdmission.lt],
        result: ['1', ...repeatBasket], observedAt: repeatObservedAt },
    },
  ]]);
  const mintAndRepeat = (await projectOwnerLedger(mintedThenRepeated.input)).events;
  assert.equal(mintAndRepeat.filter(e => e.kind === 't3_mint' &&
    e.settlement?.status === 'confirmed').length, 1,
    'a later same-query deposit cannot invalidate the earlier completed mint');
  const repeatedRefundEvent = mintAndRepeat.find(e => e.kind === 't3_mint' &&
    e.settlement?.t3?.refund?.kind === 5);
  assert.equal(repeatedRefundEvent?.settlement?.t3?.stage, 'refund_queued',
    'a rejected same-query replay keeps its separate owner-funded refund claim');
  assert(repeatedRefundEvent?.movements.some(m => m.direction === 'out' &&
    m.asset.kind === 'jetton' && m.asset.master === roots[0] &&
    m.asset.owner === owner && m.amountRaw === String(amount)),
    'the repeat refund event retains its own gross owner debit');
  const lostReceiverNotification = rejectedMintRefund('credited');
  const receiverNotice = lostReceiverNotification.input.chains.get(receiver)!.transactions
    .find(tx => tx.inMessage?.op === NOTIFY)!;
  receiverNotice.success = false;
  receiverNotice.status = 'failed';
  const unproved = (await projectOwnerLedger(lostReceiverNotification.input)).events.find(e => e.kind === 't3_mint' && e.settlement?.t3?.refund)!;
  assert.notEqual(unproved.settlement?.t3?.stage, 'receiver_credited',
    'wallet credit without Receiver acceptance cannot create a claim');
  assert.equal(unproved.movements.filter(m => m.purpose === 't3_refund').length, 0);
  const wrong = mint();
  wrong.input.wallets.get(tw)!.master = other;
  assert(
    !(await projectOwnerLedger(wrong.input)).events.some(
      (e) => e.settlement?.status === "confirmed" && e.kind === "t3_mint",
    ),
  );
  const missing = mint();
  missing.input.chains.get(tw)!.transactions = [];
  assert(
    !(await projectOwnerLedger(missing.input)).events.some(
      (e) => e.settlement?.status === "confirmed" && e.kind === "t3_mint",
    ),
  );
  assert(
    !(await projectOwnerLedger(missing.input)).events
      .flatMap((e) => e.movements)
      .some((v) => v.purpose === "t3_mint"),
  );
  const replay = mint();
  const repeated = { ...replay.internal, createdLt: "99001" },
    ack = { ...replay.accepted, createdLt: "99002" };
  replay.tx(tw, repeated, [ack]);
  const replayEvents = (await projectOwnerLedger(replay.input)).events;
  assert.equal(
    replayEvents
      .flatMap((e) => e.movements)
      .filter((v) => v.purpose === "t3_mint").length,
    1,
  );
  assert(
    replayEvents
      .flatMap((e) => e.movements)
      .filter((v) => v.evidence.kind === "transaction_fee").length >
      events
        .flatMap((e) => e.movements)
        .filter((v) => v.evidence.kind === "transaction_fee").length,
  );
  const r = redeem(),
    redemptionProjection = await projectOwnerLedger(r.input),
    rs = redemptionProjection.events,
    redeemed = rs.find((e) => e.kind === "t3_redeem")!;
  assert.equal(redeemed.settlement?.status, "confirmed", JSON.stringify(rs));
  assert.equal(redeemed.settlement?.t3?.feeBreakdown, "verified");
  assert.equal(
    redeemed.settlement?.t3?.feeAmountsRaw?.[0],
    String(r.n - r.net),
  );
  assert.equal(
    redeemed.movements.find((v) => v.purpose === "t3_burn")?.amountRaw,
    String(r.n),
  );
  const credit = redeemed.movements.find((v) => v.purpose === "t3_payout")!;
  assert.equal(credit.amountRaw, String(r.net));
  assert.equal(credit.asset.owner, receiver);
  assert.equal(credit.asset.controller, owner);
  assert.equal(credit.destination, receiver);
  assert.equal(
    redeemed.movements.filter((v) => v.purpose === "protocol_fee").length,
    0,
    "withheld payout fee is not a second wallet debit",
  );
  const fundedRedemption = redeem(false, false, null, true);
  const fundedRedemptionEvents = (await projectOwnerLedger(fundedRedemption.input)).events;
  const fundedRedeemed = fundedRedemptionEvents.find((e) => e.kind === 't3_redeem')!;
  assert.equal(fundedRedeemed.settlement?.status, 'confirmed', JSON.stringify(fundedRedemptionEvents));
  assert.equal(fundedRedeemed.movements.find((v) => v.purpose === 't3_payout')?.amountRaw,
    String(fundedRedemption.net));
  const overpaid = redeem();
  const old = overpaid.execute.outMessages[0],
    bad = overpaid.msg(
      hub,
      owner,
      beginCell()
        .storeUint(w.T3_REDEEM_RECEIPT, 32)
        .storeUint(BigInt(query), 64)
        .storeAddress(A(owner))
        .storeCoins(overpaid.n)
        .storeCoins(overpaid.net + 1n)
        .storeCoins(0)
        .storeCoins(0)
        .storeUint(0, 8)
        .storeUint(0, 8)
        .storeMaybeRef(null)
        .endCell(),
    );
  overpaid.execute.outMessages[0] = bad;
  for (const tx of overpaid.input.chains.get(owner)!.transactions)
    if (tx.inMessage === old) tx.inMessage = bad;
  const mismatch = (await projectOwnerLedger(overpaid.input)).events.find(
    (e) => e.kind === "t3_redeem",
  )!;
  assert.equal(mismatch.settlement?.status, "incomplete");
  assert.equal(mismatch.settlement?.t3?.feeBreakdown, "unavailable");
  const wrongController = redeem();
  wrongController.input.wallets.get(custody[0])!.controller = other;
  assert.equal(
    (await projectOwnerLedger(wrongController.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "incomplete",
  );
  const replayBurn = redeem();
  const failedRetry = replayBurn.tx(tw, {
    ...replayBurn.request,
    createdLt: "98999",
  });
  failedRetry.success = false;
  failedRetry.status = "failed";
  const afterRetry = (await projectOwnerLedger(replayBurn.input)).events;
  assert.equal(
    afterRetry.find((e) => e.kind === "t3_redeem")?.settlement?.status,
    "confirmed",
  );
  assert.equal(
    afterRetry
      .flatMap((e) => e.movements)
      .filter((m) => m.purpose === "t3_burn").length,
    1,
  );
  const sliced = redeem(true);
  const slices = (await projectOwnerLedger(sliced.input)).events.find(
    (e) => e.kind === "t3_redeem",
  )!;
  assert.equal(slices.settlement?.status, "confirmed", JSON.stringify(slices));
  assert.equal(
    slices.movements.filter((m) => m.purpose === "t3_payout").length,
    2,
  );
  assert.equal(
    slices.movements.filter((m) => m.purpose === "t3_burn").length,
    1,
  );
  assert.deepEqual(slices.settlement?.t3?.deliveredRaw, [
    String(sliced.net),
    "0",
    "0",
  ]);
  const pendingSlice = redeem(true);
  pendingSlice.input.chains.get(receiver)!.transactions.pop();
  assert.equal(
    (await projectOwnerLedger(pendingSlice.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "incomplete",
  );
  const partial = redeem();
  partial.input.chains.get(custody[0])!.historyComplete = false;
  assert.equal(
    (await projectOwnerLedger(partial.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "incomplete",
  );
  const notDelivered = redeem();
  notDelivered.input.chains.get(receiver)!.transactions = [];
  assert.equal(
    (await projectOwnerLedger(notDelivered.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "incomplete",
  );
  const wrongIdentity = redeem();
  wrongIdentity.identity.payoutId = "4";
  assert.equal(
    (await projectOwnerLedger(wrongIdentity.input)).events.find(
      (e) => e.kind === "t3_redeem",
    )?.settlement?.status,
    "incomplete",
  );
  const bounced = redeem();
  bounced.burn.success = false;
  bounced.burn.status = "failed";
  const failed = (await projectOwnerLedger(bounced.input)).events;
  assert(
    !failed.flatMap((e) => e.movements).some((v) => v.purpose === "t3_burn"),
  );
  assert(
    failed
      .flatMap((e) => e.movements)
      .some((v) => v.evidence.kind === "transaction_fee"),
  );
  const noState = redeem();
  noState.input.stateAt = async () => null;
  const unpriced = (await projectOwnerLedger(noState.input)).events.find(
    (e) => e.kind === "t3_redeem",
  )!;
  assert.equal(unpriced.settlement?.status, "confirmed");
  assert(unpriced.issues.includes("t3_protocol_fee_breakdown_unavailable"));
  const fingerprint = projectionFingerprint(redemptionProjection, [], []),
    changed = structuredClone(redemptionProjection);
  changed.events.find(
    (e) => e.kind === "t3_redeem",
  )!.settlement!.t3!.identityEvidence!.observedAt = "2026-09-08T00:00:00.000Z";
  for (const e of changed.events)
    for (const m of e.movements)
      if (m.evidence.getter)
        m.evidence.getter.observedAt = "2026-09-08T00:00:00.000Z";
  assert.equal(projectionFingerprint(changed, [], []), fingerprint);
  for (const opcode of [0x4f50454e, 0x41444d47, 0x4d444946]) {
    const f = fixture();
    f.input.t3Hubs = undefined;
    const funding = f.transfer(
      owner,
      wallets[0],
      hub,
      vaults[0],
      query,
      amount,
      beginCell().storeUint(opcode, 32).storeUint(BigInt(query), 64).endCell(),
    );
    f.tx(owner, undefined, [funding.request]);
    f.tx(hub, funding.notification);
    const events = (await projectOwnerLedger(f.input)).events,
      event = events.find((e) =>
        e.movements.some(
          (m) => m.direction === "out" && m.asset.kind === "jetton",
        ),
      )!;
    assert.equal(event.settlement?.status, "incomplete");
    assert(event.issues.includes("perps_position_settlement_unverified"));
    assert.equal(
      event.movements.find(
        (m) => m.direction === "out" && m.asset.kind === "jetton",
      )?.amountRaw,
      String(amount),
    );
  }
  await recoveryTests();
  await database();
  // Explicitly generated current-ABI fixtures. Historical captured receipts,
  // including the missing-decimals fixture, remain immutable.
  if (process.env.T3_WEB_FIXTURES_DIR) {
    const directory = resolve(process.env.T3_WEB_FIXTURES_DIR);
    const refundCases = await Promise.all((['queued', 'dispatching', 'credited'] as const)
      .map(async stage => {
        const caseFixture = rejectedMintRefund(stage);
        return [stage, { events: (await projectOwnerLedger(caseFixture.input)).events,
          network: 'localnet', owner, hub, root, collateralRoot: roots[0],
          queryId: query, amountRaw: String(caseFixture.raw) }] as const;
      }));
    const fixtures = {
      "t3-mint.json": {
        events, network: "localnet", owner, hub, root,
        collateralRoot: roots[0], queryId: query, amountRaw: String(amount),
      },
      "t3-redemption.json": {
        network: "localnet", owner, hub, root, ownerWallet: tw, receiver,
        queryId: query, rootWireId: wire, payoutId: payout, amountRaw: String(r.n),
        reserveRoots: roots, reserveVaults: vaults, custodyWallets: custody,
        burnBodyBoc: r.request.body, events: rs,
      },
      ...Object.fromEntries(refundCases.map(([stage, fixture]) =>
        [`t3-mint-refund-${stage}.json`, fixture])),
    };
    await Promise.all(Object.entries(fixtures).map(([name, fixture]) =>
      writeFile(resolve(directory, name), `${JSON.stringify(fixture, null, 2)}\n`)));
  }
  console.log(
    "T3 exact ledger mint/redemption, custody, fees, replay and incomplete evidence tests passed",
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
