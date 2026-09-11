import assert from "node:assert/strict";
import { Address, Cell, Dictionary, beginCell } from "@ton/core";
import { createHash } from "node:crypto";
import {
  projectOwnerLedger,
  type ProjectionInput,
  type LedgerChain,
} from "../ledger/project";
import type { RawMessage, RawTransaction } from "../data/dataSource";
import { loadOpcodes } from "../utils/opcodes";
import { INTERNAL, NOTIFY, TRANSFER, BURN, BURN_NOTIFY } from "../ledger/wire";
import * as w from "../ledger/t3Wire";
import { perpsWalletAddress } from "../ledger/perpsWire";
import { t3ReceiptKey } from "../ledger/t3RecoveryState";
import { parseLedgerT3RedemptionBinding } from "../config/ledgerT3";
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
  amount = 2n ** 80n + 31n;
function state(
  mintFee = 100,
  redeemFee = 100,
  supply = 1000n,
  balance = [1000n, 0n, 0n],
  bounce = Cell.EMPTY,
  enabled = 1,
) {
  const peg = beginCell()
    .storeUint(0, 8)
    .storeUint(0, 16)
    .storeUint(0, 8)
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
  s.storeRef(Cell.EMPTY)
    .storeRef(Cell.EMPTY)
    .storeUint(0, 208)
    .storeRef(
      beginCell().storeRef(peg.endCell()).storeRef(Cell.EMPTY).endCell(),
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
    ihrFeeRaw: "0",
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
function mint(basket = [amount, 0n, 0n]) {
  const f = fixture(),
    note = beginCell()
      .storeUint(w.DEPOSIT_NOTE, 32)
      .storeUint(1, 8)
      .storeUint(basket.filter((v) => v > 0n).length > 1 ? 0 : 1, 8)
      .storeUint(10000, 16)
      .storeAddress(A(owner))
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
  const minted = basket.reduce(
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
        .endCell(),
    );
    f.tx(owner, undefined, [originMessage]);
  }
  const origin = f.tx(hub, originMessage, [start]);
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
  const data = state();
  f.input.stateAt = async () => ({
    seqno: 10,
    state: {
      accountState: "active",
      codeBoc: code.toBoc().toString("base64"),
      dataBoc: data.toBoc().toString("base64"),
    } as any,
  });
  return {
    ...f,
    credit,
    hubSuccess,
    origin,
    minted,
    deposit,
    internal,
    accepted,
  };
}
function redeem(sliced = false, recovery = false) {
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
  const data = state(100, 100, n, [n, 0n, 0n]);
  f.input.stateAt = async () => ({
    seqno: 10,
    state: {
      accountState: "active",
      codeBoc: code.toBoc().toString("base64"),
      dataBoc: data.toBoc().toString("base64"),
    } as any,
  });
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
function recoveredRedeem() {
  const f = redeem(false, true);
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
  const walletState = (
    status: number,
    balance = status ? f.n : f.n * 2n,
    journalQuery = status ? BigInt(query) : 0n,
  ) =>
    beginCell()
      .storeCoins(balance)
      .storeAddress(A(owner))
      .storeAddress(A(root))
      .storeCoins(0)
      .storeCoins(0)
      .storeAddress(null)
      .storeUint(0, 96)
      .storeCoins(0)
      .storeRef(
        beginCell()
          .storeUint(status, 8)
          .storeUint(journalQuery, 64)
          .storeCoins(status ? f.n : 0n)
          .storeUint(status ? BigInt("0x" + requestHash) : 0n, 256)
          .storeAddress(status ? A(hub) : null),
      )
      .storeRef(Cell.EMPTY)
      .endCell();
  const hubState = (
    consumed: number | null,
    proofWire = wire,
    proofPayout = payout,
    enabled = 1,
  ) => {
    const entries = Dictionary.empty(
      Dictionary.Keys.BigUint(256),
      Dictionary.Values.Cell(),
    );
    const identities = Dictionary.empty(
      Dictionary.Keys.BigUint(64),
      Dictionary.Values.BigUint(256),
    );
    if (consumed !== null) {
      const key = BigInt("0x" + intentHash);
      entries.set(
        key,
        beginCell()
          .storeUint(BigInt(query), 64)
          .storeUint(BigInt(proofWire), 64)
          .storeAddress(A(owner))
          .storeAddress(A(owner))
          .storeCoins(f.n)
          .storeUint(0, 16)
          .storeUint(0, 8)
          .storeUint(0, 8)
          .storeUint(BigInt(proofPayout), 64)
          .storeUint(consumed, 8)
          .endCell(),
      );
      identities.set(BigInt(proofPayout), key);
    }
    const proofs = beginCell()
      .storeUint(BigInt(payout) + 1n, 64)
      .storeDict(entries)
      .storeDict(identities);
    const bounce = beginCell()
      .storeAddress(null)
      .storeUint(0, 64)
      .storeCoins(0)
      .storeUint(0, 64)
      .storeAddress(null)
      .storeUint(0, 32)
      .storeCoins(0)
      .storeUint(0, 64)
      .storeRef(Cell.EMPTY)
      .storeRef(proofs)
      .endCell();
    return state(
      100,
      100,
      consumed ? 0n : f.n,
      [consumed ? f.n - f.net : f.n, 0n, 0n],
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
    parseLedgerT3RedemptionBinding(JSON.stringify(f.binding), "localnet"),
    f.binding,
  );
  for (const value of [undefined, "", "  "])
    assert.equal(parseLedgerT3RedemptionBinding(value, "localnet"), undefined);
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
      parseLedgerT3RedemptionBinding(JSON.stringify(binding), "localnet"),
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
  for (const relation of ["equal", "reversed"] as const)
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
  assert(
    event.movements.some(
      (v) => v.direction === "fee" && v.asset.kind === "native",
    ),
  );
  const three = mint([amount, amount + 1n, amount + 2n]);
  const threeEvent = (await projectOwnerLedger(three.input)).events.find(
    (e) => e.kind === "t3_mint",
  )!;
  assert.equal(threeEvent.settlement?.status, "confirmed");
  assert.deepEqual(
    threeEvent.settlement?.t3?.basketRaw,
    [amount, amount + 1n, amount + 2n].map(String),
  );
  assert.deepEqual(threeEvent.settlement?.t3?.feeAmountsRaw, ["0", "0", "0"]);
  assert.equal(
    threeEvent.movements.filter((m) => m.purpose === "t3_collateral").length,
    3,
  );
  const missingLeg = mint([amount, amount + 1n, amount + 2n]);
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
  const noHistory = mint();
  noHistory.input.chains.get(root)!.historyComplete = false;
  assert.equal(
    (await projectOwnerLedger(noHistory.input)).events.find(
      (e) => e.kind === "t3_mint",
    )?.settlement?.status,
    "incomplete",
  );
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
  console.log(
    "T3 exact ledger mint/redemption, custody, fees, replay and incomplete evidence tests passed",
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
