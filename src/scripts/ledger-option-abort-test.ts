import assert from "node:assert/strict";
import { durableOptionAbort } from "./ledger-option-abort-store-test";
import { beginCell, Cell, Dictionary } from "@ton/core";
import { OPTION_NATIVE_REFUND } from "../ledger/optionLifecycleWire";
import { type RawTransaction } from "../data/dataSource";
import { projectOwnerLedger } from "../ledger/project";
import { readOptionVaultState } from "../ledger/optionLifecycleState";
import { TRANSFER, INTERNAL, NOTIFY, tokenWire } from "../ledger/wire";
import {
  optionPositionHash,
  optionSeriesBuy,
  OPTION_FACTORY_BUY,
  OPTION_BUY_SHOUT,
  OPTION_BUY_SPREAD,
} from "../ledger/options";
import {
  BUY,
  OPTION_OWNER_ABORT,
  OPTION_CANCEL,
  OPTION_CANCEL_ACK,
  OPTION_VAULT_ABORT,
  OPTION_VAULT_ABORT_ACK,
  optionDepositReceiptHash,
  optionAbortReceiptHash,
  optionAbortRefundHash,
} from "../ledger/optionAbortWire";
import {
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
  notional,
  premium,
  collateral,
  payout,
  boc,
  position,
  factoryData,
  productData,
  entry,
  vaultData,
  fixture,
  cash,
} from "./ledger-option-lifecycle-test";

function abortFixture(
  custody = false,
  kind: 1 | 2 = 1,
  vaultPaid = true,
  factoryPaid = true,
  commitStatus: "committed" | "failed" | "unobserved" = "committed",
  existingBucket?: { locked: bigint; premium: bigint },
  interleavedDeposit = false,
) {
  const f = fixture(),
    amount = collateral + premium + 37n,
    p = position({
      flags: 0n,
      custodyWire: 55n,
      excess: 17n,
      walletFunding: 360000000n,
    }),
    principal = collateral + premium,
    productCode = kind === 1 ? shoutCode : spreadCode,
    initialVault = {
      tracked: (existingBucket?.locked ?? 0n) + (existingBucket?.premium ?? 0n),
      totalLocked: existingBucket?.locked ?? 0n,
      totalPremium: existingBucket?.premium ?? 0n,
      ...(existingBucket ? {
        bucketLocked: existingBucket.locked,
        bucketPremium: existingBucket.premium,
      } : {}),
    },
    abortedVault = {
      ...initialVault,
      tracked: initialVault.tracked + principal,
      ...(commitStatus === "committed" ? {
        bucketLocked: initialVault.totalLocked,
        bucketPremium: initialVault.totalPremium,
      } : {}),
    };
  f.input.optionFactories!.get(factory)!.qualification = {
    ...f.input.optionFactories!.get(factory)!.qualification!,
  };
  f.input.optionFactories!.get(factory)!.series.get("7")!.kind = kind;
  f.tx(factory, undefined, [], { code: factoryCode, data: factoryData(null) });
  f.tx(series, undefined, [], {
    code: productCode,
    data: productData(kind, false, 0n, owner, "absent"),
  });
  f.tx(vault, undefined, [], {
    code: vaultCode,
    data: vaultData(null, false, initialVault),
  });
  const payload = beginCell()
    .storeUint(OPTION_FACTORY_BUY, 32)
    .storeUint(7, 64)
    .storeAddress(A(owner))
    .storeCoins(notional)
    .storeCoins(premium + 20n)
    .storeUint(10000, 32)
    .endCell();
  const request = f.msg(
    owner,
    ownerWallet,
    beginCell()
      .storeUint(TRANSFER, 32)
      .storeUint(1234, 64)
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
      .storeUint(1234, 64)
      .storeCoins(amount)
      .storeAddress(A(owner))
      .storeAddress(A(owner))
      .storeCoins(1)
      .storeRef(payload)
      .endCell(),
  );
  const notify = f.msg(
    factoryWallet,
    factory,
    beginCell()
      .storeUint(NOTIFY, 32)
      .storeUint(1234, 64)
      .storeCoins(amount)
      .storeAddress(A(owner))
      .storeAddress(A(ownerWallet))
      .storeCoins(1)
      .storeRef(payload)
      .endCell(),
  );
  const assigned = f.msg(
    factory,
    series,
    beginCell()
      .storeUint(kind === 1 ? OPTION_BUY_SHOUT : OPTION_BUY_SPREAD, 32)
      .storeUint(55, 64)
      .storeAddress(A(owner))
      .storeUint(3, 64)
      .storeCoins(notional)
      .storeCoins(premium)
      .storeCoins(collateral)
      .endCell(),
  );
  f.tx(owner, undefined, [request]);
  f.tx(ownerWallet, request, [internal]);
  f.tx(factoryWallet, internal, [notify]);
  const origin = f.tx(factory, notify, [assigned], {
    code: factoryCode,
    data: factoryData(p),
  });
  const reserveAck = f.msg(
    series,
    factory,
    beginCell()
      .storeUint(0x4f424143, 32)
      .storeUint(0, 64)
      .storeUint(3, 64)
      .storeUint(1, 8)
      .storeUint(55, 64)
      .endCell(),
  );
  const reservation = f.tx(series, assigned, custody ? [reserveAck] : [], {
    code: productCode,
    data: productData(kind, false, 0n, owner, custody ? "reserved" : "absent"),
  });
  if (!custody) {
    reservation.success = false;
    reservation.status = "failed";
  }
  let before = p,
    custodyCash: ReturnType<typeof cash> | undefined;
  const receiptHash = optionDepositReceiptHash(
    "7",
    "3",
    "55",
    collateral.toString(),
    premium.toString(),
    vaultWallet,
  );
  if (custody) {
    const dispatch = f.tx(factory, reserveAck, [], {
      code: factoryCode,
      data: factoryData(
        { ...p, flags: 3n, walletFunding: 220000000n },
        [],
        (7n << 64n) | 3n,
      ),
    });
    before = { ...p, flags: 5n, walletFunding: 180000000n };
    custodyCash = cash(
      f,
      factory,
      dispatch,
      vault,
      principal,
      55n,
      factoryData(
        { ...p, flags: 2051n, walletFunding: 180000000n },
        [],
        (7n << 64n) | 3n,
      ),
      factoryData(before),
    );
    const commit = f.msg(
      factory,
      vault,
      beginCell()
        .storeUint(0x4f42434d, 32)
        .storeUint(7, 64)
        .storeUint(3, 64)
        .storeUint(55, 64)
        .storeCoins(collateral)
        .storeCoins(premium)
        .storeAddress(A(vaultWallet))
        .endCell(),
    );
    custodyCash.terminal.outMessages.push(commit);
    if (commitStatus !== "unobserved") {
      const commitTx = f.tx(vault, commit, [], {
        code: vaultCode,
        data:
          commitStatus === "failed"
            ? vaultData(null, false, initialVault)
            : vaultData(null, false, {
                tracked: initialVault.tracked + principal,
                depositReceipt: BigInt("0x" + receiptHash),
                bucketLocked: collateral + initialVault.totalLocked,
                bucketPremium: premium + initialVault.totalPremium,
                totalLocked: collateral + initialVault.totalLocked,
                totalPremium: premium + initialVault.totalPremium,
              }),
      });
      if (commitStatus === "failed") {
        commitTx.success = false;
        commitTx.status = "failed";
      }
    }
    if (interleavedDeposit) {
      // apply_token_deposit allows the configured treasury to seed unrelated
      // physical custody. Its receipt changes tracked balance on the shared
      // vault between this position's commit attempt and owner abort.
      const extra = 111n, treasuryWallet = wallet(other),
        request = f.msg(other, treasuryWallet, beginCell()
          .storeUint(TRANSFER, 32).storeUint(8888, 64).storeCoins(extra)
          .storeAddress(A(vault)).storeAddress(A(other)).storeRef(Cell.EMPTY)
          .storeCoins(0).storeRef(Cell.EMPTY).endCell()),
        internal = f.msg(treasuryWallet, vaultWallet, beginCell()
          .storeUint(INTERNAL, 32).storeUint(8888, 64).storeCoins(extra)
          .storeAddress(A(other)).storeAddress(A(other)).storeCoins(0)
          .storeRef(Cell.EMPTY).endCell()),
        notification = f.msg(vaultWallet, vault, beginCell()
          .storeUint(NOTIFY, 32).storeUint(8888, 64).storeCoins(extra)
          .storeAddress(A(other)).storeAddress(A(treasuryWallet)).storeCoins(0)
          .storeRef(Cell.EMPTY).endCell()),
        previous = f.input.chains.get(vault)!.transactions.at(-1)!,
        data = f.states.get(`${vault}:${previous.lt}`)!.data.beginParse(),
        refs = [data.loadRef(), data.loadRef(), data.loadRef(), data.loadRef()],
        amounts = [data.loadCoins(), data.loadCoins(), data.loadCoins(), data.loadCoins()];
      f.tx(other, undefined, [request]);
      f.tx(treasuryWallet, request, [internal]);
      f.tx(vaultWallet, internal, [notification]);
      f.tx(vault, notification, [], { code: vaultCode, data: beginCell()
        .storeRef(refs[0]).storeRef(refs[1]).storeRef(refs[2]).storeRef(refs[3])
        .storeCoins(amounts[0] + extra).storeCoins(amounts[1])
        .storeCoins(amounts[2]).storeCoins(amounts[3]).endCell() });
      abortedVault.tracked += extra;
    }
  }
  const abortRequest = f.msg(
    owner,
    factory,
    beginCell()
      .storeUint(OPTION_OWNER_ABORT, 32)
      .storeUint(7, 64)
      .storeUint(3, 64)
      .endCell(),
  );
  f.tx(owner, undefined, [abortRequest]);
  const abort = f.tx(factory, abortRequest, [], {
    code: factoryCode,
    data: factoryData({ ...before, flags: before.flags | BUY.ABORTING }),
  });
  let cancelStart = abort,
    baseFlags = before.flags | BUY.ABORTING,
    vaultDispatch: RawTransaction | undefined,
    vaultPayment: ReturnType<typeof cash> | undefined;
  if (custody) {
    const vaultAbort = f.msg(
      factory,
      vault,
      beginCell()
        .storeUint(OPTION_VAULT_ABORT, 32)
        .storeUint(7, 64)
        .storeUint(3, 64)
        .storeUint(55, 64)
        .storeCoins(collateral)
        .storeCoins(premium)
        .storeAddress(A(owner))
        .storeAddress(A(vaultWallet))
        .endCell(),
    );
    abort.outMessages.push(vaultAbort);
    const hash = optionAbortRefundHash(
        "7",
        "3",
        "55",
        principal.toString(),
        owner,
        receiptHash,
      ),
      abortedReceipt = BigInt("0x" + optionAbortReceiptHash(receiptHash));
    const e = entry({
      kind: 3,
      accounting: 0,
      requestId: 55n,
      status: vaultPaid ? 2 : 1,
      wire: 91n,
      amount: principal,
      premium: 0n,
      requestHash: hash,
    });
    const vaultAck = f.msg(
      vault,
      factory,
      beginCell()
        .storeUint(OPTION_VAULT_ABORT_ACK, 32)
        .storeUint(7, 64)
        .storeUint(3, 64)
        .storeUint(2, 8)
        .storeUint(55, 64)
        .endCell(),
    );
    const dispatch = f.tx(vault, vaultAbort, [vaultAck], {
      code: vaultCode,
      data: vaultData(e, false, {
        ...abortedVault,
        depositReceipt: abortedReceipt,
      }),
    });
    vaultDispatch = dispatch;
    if (vaultPaid)
      vaultPayment = cash(
        f,
        vault,
        dispatch,
        owner,
        principal,
        91n,
        vaultData({ ...e, status: 3 }, false, {
          ...abortedVault,
          depositReceipt: abortedReceipt,
        }),
        vaultData({ ...e, status: 4, accounting: 1 }, true, {
          ...abortedVault,
          depositReceipt: abortedReceipt,
        }),
      );
    baseFlags |= BUY.VAULT_ABORTED;
    cancelStart = f.tx(factory, vaultAck, [], {
      code: factoryCode,
      data: factoryData({ ...before, flags: baseFlags }),
    });
  }
  const positionHash = optionPositionHash("7", optionSeriesBuy(assigned)!);
  const cancel = f.msg(
    factory,
    series,
    beginCell()
      .storeUint(OPTION_CANCEL, 32)
      .storeUint(7, 64)
      .storeUint(3, 64)
      .storeUint(55, 64)
      .storeUint(BigInt("0x" + positionHash), 256)
      .endCell(),
  );
  cancelStart.outMessages.push(cancel);
  const cancelAck = f.msg(
    series,
    factory,
    beginCell()
      .storeUint(OPTION_CANCEL_ACK, 32)
      .storeUint(7, 64)
      .storeUint(3, 64)
      .storeUint(0, 8)
      .storeUint(55, 64)
      .endCell(),
  );
  f.tx(series, cancel, [cancelAck], {
    code: productCode,
    data: productData(kind, true, 0n, owner, "absent"),
  });
  const flags = baseFlags | BUY.CANCELLED,
    factoryAmount = custody ? 37n : amount,
    returnPosition = {
      ...before,
      flags: flags | BUY.REFUND_IN_FLIGHT,
      settled: true,
      refundWire: 92n,
      walletFunding: before.walletFunding - 140000000n,
    };
  const finalCancel = f.tx(factory, cancelAck, [], {
    code: factoryCode,
    data: factoryData(returnPosition, [], (7n << 64n) | 3n),
  });
  const factoryPayment = factoryPaid
    ? cash(
        f,
        factory,
        finalCancel,
        owner,
        factoryAmount,
        92n,
        factoryData(
          {
            ...returnPosition,
            flags: returnPosition.flags | BUY.REFUND_FINALIZING,
            walletFunding: returnPosition.walletFunding - 40000000n,
          },
          [],
          (7n << 64n) | 3n,
        ),
        factoryData({
          ...returnPosition,
          flags: flags | BUY.REFUNDED,
          walletFunding: 0n,
        }),
      )
    : undefined;
  return {
    ...f,
    amount,
    principal,
    p,
    before,
    baseFlags,
    request,
    payload,
    assigned,
    cancel,
    cancelAck,
    origin,
    reservation,
    abortRequest,
    abort,
    custodyCash,
    vaultDispatch,
    vaultPayment,
    factoryPayment,
    finalCancel,
    returnPosition,
  };
}
const abortedEvent = async (f: ReturnType<typeof abortFixture>) =>
  (await projectOwnerLedger(f.input)).events.find(
    (e) => e.settlement?.optionLifecycle?.refund?.kind === "aborted_buy",
  );
async function adverseCases() {
  type F = ReturnType<typeof abortFixture>;
  const cancelled = (f: F) =>
    f.input.chains
      .get(series)!
      .transactions.find((t) => t.inMessage === f.cancel)!;
  const commit = (f: F) =>
    f.input.chains
      .get(vault)!
      .transactions.find(
        (t) =>
          t.inMessage?.body &&
          Cell.fromBase64(t.inMessage.body).beginParse().preloadUint(32) ===
            0x4f42434d,
      )!;
  const cases: Array<[string, (f: F) => void]> = [
    [
      "foreign owner abort",
      (f) => {
        f.abortRequest.source = other;
      },
    ],
    [
      "wrong factory code qualification",
      (f) => {
        f.input.optionFactories!.get(factory)!.qualification!.factoryCodeHash =
          "f".repeat(64);
      },
    ],
    [
      "wrong original factory custody wallet identity",
      (f) => {
        f.input.wallets.get(factoryWallet)!.owner = other;
      },
    ],
    [
      "missing original allocation archive",
      (f) => {
        f.states.delete(`${factory}:${f.origin.lt}`);
      },
    ],
    [
      "missing custody commit archive",
      (f) => {
        f.states.delete(`${vault}:${commit(f).lt}`);
      },
    ],
    [
      "partial factory wallet history",
      (f) => {
        f.input.chains.get(factoryWallet)!.historyComplete = false;
      },
    ],
    [
      "partial original product history",
      (f) => {
        f.input.chains.get(series)!.historyComplete = false;
      },
    ],
    [
      "partial vault wallet history",
      (f) => {
        f.input.chains.get(vaultWallet)!.historyComplete = false;
      },
    ],
    [
      "wrong vault wallet root",
      (f) => {
        f.input.wallets.get(vaultWallet)!.master = other;
      },
    ],
    [
      "wrong product cancel hash",
      (f) => {
        f.cancel.body = boc(
          beginCell()
            .storeUint(OPTION_CANCEL, 32)
            .storeUint(7, 64)
            .storeUint(3, 64)
            .storeUint(55, 64)
            .storeUint(1, 256)
            .endCell(),
        );
      },
    ],
    [
      "foreign product cancel ACK",
      (f) => {
        f.cancelAck.source = other;
      },
    ],
    [
      "unretired active product",
      (f) => {
        f.states.set(`${series}:${cancelled(f).lt}`, {
          code: shoutCode,
          data: productData(1, false),
        });
      },
    ],
    [
      "wrong original custody finalization key",
      (f) => {
        const t = f.input.chains
          .get(factory)!
          .transactions.find((t) =>
            t.outMessages.some(
              (m) =>
                Cell.fromBase64(m.body!).beginParse().preloadUint(32) ===
                0x4a53464e,
            ),
          )!;
        f.states.set(`${factory}:${t.lt}`, {
          code: factoryCode,
          data: factoryData(
            { ...f.p, flags: 2051n, walletFunding: 180000000n },
            [],
            999n,
          ),
        });
      },
    ],
    [
      "wrong cancellation owner",
      (f) => {
        f.states.set(`${factory}:${f.finalCancel.lt}`, {
          code: factoryCode,
          data: factoryData(
            { ...f.returnPosition, owner: other },
            [],
            (7n << 64n) | 3n,
          ),
        });
      },
    ],
    [
      "negative factory cash finalizer",
      (f) => {
        f.factoryPayment!.finalized.bounced = true;
      },
    ],
    [
      "missing factory cash terminal",
      (f) => {
        f.input.chains.get(factory)!.transactions = f.input.chains
          .get(factory)!
          .transactions.filter((t) => t !== f.factoryPayment!.terminal);
      },
    ],
    [
      "foreign vault return destination",
      (f) => {
        f.vaultPayment!.transfer.destination = wallet(other);
      },
    ],
    [
      "wrong vault return amount",
      (f) => {
        f.vaultPayment!.transfer.body = boc(
          beginCell()
            .storeUint(0x4a534954, 32)
            .storeUint(91, 64)
            .storeCoins(f.principal + 1n)
            .storeAddress(A(vault))
            .storeAddress(A(vaultWallet))
            .storeCoins(1)
            .storeRef(Cell.EMPTY)
            .endCell(),
        );
      },
    ],
    [
      "invalid vault final journal",
      (f) => {
        f.states.set(`${vault}:${f.vaultPayment!.terminal.lt}`, {
          code: vaultCode,
          data: vaultData(
            entry({
              kind: 3,
              requestId: 55n,
              status: 4,
              wire: 91n,
              amount: f.principal,
              premium: 0n,
              requestHash: "1".repeat(64),
            }),
            true,
            { tracked: f.principal },
          ),
        });
      },
    ],
    [
      "refund flag without actual wallet return",
      (f) => {
        f.factoryPayment!.sourceTx.outMessages = [];
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = abortFixture(true);
    mutate(f);
    const e = await abortedEvent(f);
    assert(e?.settlement?.status !== "confirmed", name);
    assert(e?.settlement?.optionLifecycle?.payout.status !== "completed", name);
  }
  const pendingReservation = abortFixture();
  pendingReservation.reservation.status = "pending";
  assert.equal(
    await abortedEvent(pendingReservation),
    undefined,
    "a pending reservation is not a proved failed reservation",
  );
  for (const [vaultPaid, factoryPaid] of [
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    const f = abortFixture(true, 1, vaultPaid, factoryPaid),
      e = await abortedEvent(f);
    assert(e);
    assert.equal(e.settlement?.status, "incomplete");
    assert.equal(e.settlement?.optionLifecycle?.payout.status, "pending");
    const u = e.settlement!.optionLifecycle!.refund!.unwind!;
    assert.equal(u.vaultReturn.status, vaultPaid ? "completed" : "pending");
    assert.equal(u.factoryReturn.status, factoryPaid ? "completed" : "pending");
    assert.equal(
      e.movements
        .filter((m) => m.purpose === "option_refund")
        .reduce((sum, m) => sum + BigInt(m.amountRaw), 0n),
      (vaultPaid ? f.principal : 0n) + (factoryPaid ? 37n : 0n),
      "only actual individual returns become cash",
    );
  }
  const replay = abortFixture(true),
    before = await abortedEvent(replay);
  assert(before);
  const repeated = replay.msg(
    owner,
    factory,
    Cell.fromBase64(replay.abortRequest.body!),
  );
  replay.tx(owner, undefined, [repeated]);
  replay.tx(factory, repeated, [], {
    code: factoryCode,
    data: replay.states.get(`${factory}:${replay.factoryPayment!.terminal.lt}`)!
      .data,
  });
  const after = await abortedEvent(replay);
  assert.equal(after?.id, before.id);
  assert.equal(
    after?.movements.filter((m) => m.purpose === "option_refund").length,
    2,
    "replayed OBAR does not duplicate principal",
  );
  assert.deepEqual(
    (await projectOwnerLedger(replay.input)).events,
    (await projectOwnerLedger(replay.input)).events,
    "reindexing is deterministic",
  );
  const native = abortFixture(),
    returned = native.returnPosition.walletFunding - 40000000n,
    body = beginCell()
      .storeUint(OPTION_NATIVE_REFUND, 32)
      .storeUint(OPTION_OWNER_ABORT, 32)
      .storeUint(3, 64)
      .storeCoins(returned)
      .endCell(),
    message = native.msg(factory, owner, body);
  message.value = returned.toString();
  native.factoryPayment!.terminal.outMessages.push(message);
  const received = native.tx(owner, message);
  const e = await abortedEvent(native);
  assert(e);
  assert(
    e.settlement?.evidence.some(
      (t) => t.lt === received.lt && t.account === owner,
    ),
  );
  assert(
    e.movements.some(
      (m) =>
        m.asset.kind === "native" &&
        m.direction === "in" &&
        m.amountRaw === returned.toString(),
    ),
    "actual native budget refund retained",
  );
  assert.equal(
    e.movements
      .filter(
        (m) => m.direction === "fee" && m.evidence.kind === "transaction_fee",
      )
      .reduce((sum, m) => sum + BigInt(m.amountRaw), 0n),
    BigInt(
      e.settlement!.optionLifecycle!.localNetworkFees.filter(
        (f) => f.includedInOwnerFeeMovements,
      ).length,
    ) * 7n,
    "raw owner transaction fees counted once; counterparty fees stay metadata",
  );
}
async function vaultAccountingCases() {
  for (const status of ["committed", "failed", "unobserved"] as const)
    for (const kind of [1, 2] as const)
      for (const existing of [undefined, { locked: 987654321n, premium: 321n }])
        for (const [vaultPaid, factoryPaid] of [[true, true], [true, false], [false, true], [false, false]]) {
          const f = abortFixture(true, kind, vaultPaid, factoryPaid, status, existing),
            e = await abortedEvent(f);
          assert(e, `${status} ${kind} refund must remain visible`);
          const u = e.settlement!.optionLifecycle!.refund!.unwind!, boundary = u.vaultAbort!;
          assert.equal(u.commit?.status, status);
          assert.equal(e.settlement?.status, vaultPaid && factoryPaid ? "confirmed" : "incomplete");
          assert.equal(boundary.receiptBeforeHash, status === "committed" ? boundary.receiptHash : null);
          assert.equal(boundary.receiptAfterHash, boundary.abortHash);
          assert.equal(BigInt(boundary.trackedBalanceAfterRaw) - BigInt(boundary.trackedBalanceBeforeRaw), status === "committed" ? 0n : f.principal);
          if (status !== "committed") {
            assert.deepEqual(boundary.beforeBucket, boundary.afterBucket);
            assert.equal(boundary.beforeBucket?.lockedRaw ?? null, existing?.locked.toString() ?? null);
          }
          assert.equal(e.movements.filter(m => m.purpose === "option_refund").reduce((sum, m) => sum + BigInt(m.amountRaw), 0n),
            (vaultPaid ? f.principal : 0n) + (factoryPaid ? 37n : 0n));
        }
  // Mutate the exact historical abort transaction's root, preserving its journal
  // and message graph. A correct tombstone alone cannot excuse bad accounting.
  for (const status of ["committed", "failed", "unobserved"] as const)
    for (const field of ["tracked", "locked", "premium", "bucket"] as const) {
      const f = abortFixture(true, 1, true, true, status), tx = f.vaultDispatch!,
        stored = f.states.get(`${vault}:${tx.lt}`)!, s = stored.data.beginParse(),
        refs = [s.loadRef(), s.loadRef(), s.loadRef(), s.loadRef()],
        amounts = [s.loadCoins(), s.loadCoins(), s.loadCoins(), s.loadCoins()];
      if (field === "bucket") {
        const changed = vaultData(null, false, { bucketLocked: status === "committed" ? 1n : 0n }).beginParse();
        changed.loadRef(); changed.loadRef(); refs[2] = changed.loadRef();
      } else amounts[field === "tracked" ? 0 : field === "locked" ? 2 : 3] += 1n;
      f.states.set(`${vault}:${tx.lt}`, { code: stored.code, data: beginCell()
        .storeRef(refs[0]).storeRef(refs[1]).storeRef(refs[2]).storeRef(refs[3])
        .storeCoins(amounts[0]).storeCoins(amounts[1]).storeCoins(amounts[2]).storeCoins(amounts[3]).endCell() });
      const e = await abortedEvent(f);
      assert(e);
      assert.equal(e.settlement?.status, "incomplete", `${status}: wrong ${field}`);
      assert(e.issues.includes(status === "committed" ? "option_abort_vault_bucket_unverified" : "option_abort_orphan_custody_accounting_unverified"));
      assert.equal(e.settlement?.optionLifecycle?.refund?.unwind?.vaultAbort, undefined);
    }
  // The explicit boundary fields are read from the archived cells, including
  // nonzero unrelated deposits, instead of being filled from expected values.
  const f = abortFixture(true, 1, true, true, "failed", { locked: 987654321n, premium: 321n }),
    e = await abortedEvent(f), tx = f.vaultDispatch!,
    state = readOptionVaultState(boc(f.states.get(`${vault}:${tx.lt}`)!.data));
  assert.equal(e!.settlement!.optionLifecycle!.refund!.unwind!.vaultAbort!.trackedBalanceAfterRaw, state.trackedBalanceRaw);
}
async function vaultJournalCases() {
  type JournalField = "accounting" | "riskClaim" | "riskStatus" | "riskDelivered";
  const mutateEntry = (cell: Cell, field: JournalField, accounting: number) => {
    if (field === "riskDelivered") {
      assert.equal(cell.refs.length, 2);
      const hashes = cell.refs[1]!, cursor = hashes.beginParse();
      cursor.loadUintBig(256);
      cursor.loadUintBig(256);
      cursor.loadCoins();
      const changed = beginCell().storeBits(hashes.bits.substring(0, 512))
        .storeCoins(1n).storeSlice(cursor).endCell();
      return beginCell().storeBits(cell.bits).storeRef(cell.refs[0]!)
        .storeRef(changed).endCell();
    }
    const cursor = cell.beginParse();
    cursor.loadUint(8);
    cursor.loadUintBig(64);
    cursor.loadUintBig(64);
    cursor.loadUint(8);
    cursor.loadCoins();
    cursor.loadUintBig(64);
    cursor.loadIntBig(64);
    cursor.loadCoins();
    cursor.loadCoins();
    cursor.loadCoins();
    if (field !== "accounting") cursor.loadUint(8);
    if (field === "riskStatus") cursor.loadUintBig(64);
    const offset = cell.bits.length - cursor.remainingBits,
      width = field === "riskClaim" ? 64 : 8;
    cursor.loadUintBig(width);
    return beginCell().storeBits(cell.bits.substring(0, offset))
      .storeUint(field === "accounting" ? accounting : 1, width)
      .storeSlice(cursor).endCell();
  };
  let negatives = 0;
  for (const status of ["committed", "failed", "unobserved"] as const)
    for (const stage of ["dispatch", "delivered", "final"] as const)
      for (const field of ["accounting", "riskClaim", "riskStatus", "riskDelivered"] as const) {
        const label = `${status}/${stage}/${field}`,
          f = abortFixture(true, 1, true, true, status),
          payment = f.vaultPayment!,
          lt = stage === "dispatch" ? f.vaultDispatch!.lt
            : stage === "delivered" ? payment.terminal.prevTransactionLt! : payment.terminal.lt,
          stored = f.states.get(`${vault}:${lt}`)!,
          original = readOptionVaultState(boc(stored.data)),
          graph = JSON.stringify([...f.input.chains]),
          rootSlice = stored.data.beginParse(),
          refs = [rootSlice.loadRef(), rootSlice.loadRef(), rootSlice.loadRef(), rootSlice.loadRef()],
          journalSlice = refs[3]!.beginParse(),
          entries = journalSlice.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        assert.equal(entries.size, 1, label);
        const key = entries.keys()[0]!, before = [...original.entries.values()][0]!;
        assert.equal(before.accountingApplied, stage === "final" ? 1 : 0, `${label}: faithful baseline`);
        assert.equal(before.riskClaimId, "0");
        assert.equal(before.riskStatus, 0);
        assert.equal(before.riskDeliveredRaw, "0");
        entries.set(key, mutateEntry(entries.get(key)!, field, stage === "final" ? 0 : 1));
        refs[3] = beginCell().storeDict(entries).storeSlice(journalSlice).endCell();
        const changed = beginCell().storeRef(refs[0]!).storeRef(refs[1]!)
          .storeRef(refs[2]!).storeRef(refs[3]!).storeSlice(rootSlice).endCell();
        f.states.set(`${vault}:${lt}`, { code: stored.code, data: changed });
        // Only one archived journal field changes. The physical transfer,
        // destination credit and complete control-message graph stay intact.
        const after = [...readOptionVaultState(boc(changed)).entries.values()][0]!,
          property = field === "accounting" ? "accountingApplied" : field === "riskClaim"
            ? "riskClaimId" : field === "riskStatus" ? "riskStatus" : "riskDeliveredRaw";
        assert.notEqual(after[property], before[property], label);
        assert.deepEqual({ ...after, [property]: before[property] }, before, label);
        assert.equal(JSON.stringify([...f.input.chains]), graph, label);
        const e = await abortedEvent(f);
        assert(e, label);
        const u = e.settlement!.optionLifecycle!.refund!.unwind!;
        assert.equal(e.settlement!.status, "incomplete", label);
        assert.equal(u.vaultReturn.status, "pending", label);
        assert.equal(u.vaultReturn.amountRaw, f.principal.toString(), label);
        assert.equal(u.vaultReturn.evidence.length, 0, label);
        assert.equal(u.factoryReturn.status, "completed", `${label}: healthy independent return retained`);
        const refunds = e.movements.filter(m => m.purpose === "option_refund");
        assert.equal(refunds.length, 1, label);
        assert.equal(refunds[0]!.source, factory, label);
        assert.equal(refunds[0]!.amountRaw, "37", label);
        negatives++;
      }
  let interleaved = 0;
  for (const status of ["committed", "failed", "unobserved"] as const) {
    const f = abortFixture(true, 1, true, true, status, undefined, true),
      e = await abortedEvent(f);
    assert(e, status);
    assert.equal(e.settlement!.status, "confirmed", status);
    const u = e.settlement!.optionLifecycle!.refund!.unwind!, boundary = u.vaultAbort!,
      deposit = f.input.chains.get(vault)!.transactions.find(t => tokenWire(t.inMessage)?.queryId === "8888")!;
    assert(deposit, `${status}: actual unrelated treasury notification present`);
    const notification = tokenWire(deposit.inMessage)!;
    assert.equal(notification.op, NOTIFY);
    assert.equal(notification.owner, other);
    assert.equal(notification.amountRaw, "111");
    const depositBefore = f.states.get(`${vault}:${deposit.prevTransactionLt}`)!.data,
      depositAfter = f.states.get(`${vault}:${deposit.lt}`)!.data,
      before = readOptionVaultState(boc(depositBefore)), after = readOptionVaultState(boc(depositAfter));
    assert.equal(BigInt(after.trackedBalanceRaw) - BigInt(before.trackedBalanceRaw), 111n, status);
    assert.equal(u.commit!.status, status);
    if (status === "unobserved") assert.equal(u.commit!.stateEvidence, undefined);
    else assert.equal(u.commit!.stateEvidence!.stateAfterHash, depositBefore.hash().toString("hex"), status);
    assert.notEqual(depositBefore.hash().toString("hex"), boundary.stateEvidence.stateBeforeHash, status);
    assert.equal(boundary.stateEvidence.stateBeforeHash, depositAfter.hash().toString("hex"), status);
    assert.equal(boundary.trackedBalanceBeforeRaw, after.trackedBalanceRaw, status);
    assert.equal(boundary.receiptBeforeHash, status === "committed" ? boundary.receiptHash : null, status);
    assert.equal(boundary.receiptAfterHash, boundary.abortHash, status);
    assert.equal(BigInt(boundary.trackedBalanceAfterRaw) - BigInt(boundary.trackedBalanceBeforeRaw),
      status === "committed" ? 0n : f.principal, status);
    assert.equal(u.factoryReturn.status, "completed", status);
    assert.equal(u.vaultReturn.status, "completed", status);
    assert.equal(u.vaultReturn.amountRaw, f.principal.toString(), status);
    assert.equal(e.movements.filter(m => m.purpose === "option_refund")
      .reduce((sum, m) => sum + BigInt(m.amountRaw), 0n), f.amount, `${status}: unrelated 111 never becomes owner refund`);
    assert.equal(readOptionVaultState(boc(f.states.get(`${vault}:${f.vaultPayment!.terminal.lt}`)!.data)).trackedBalanceRaw,
      "111", `${status}: unrelated treasury custody remains after exact owner refund`);
    interleaved++;
  }
  console.log(`${negatives} exact archived-journal negatives and ${interleaved} interleaved-deposit positives passed`);
}
async function main() {
  for (const kind of [1, 2] as const)
    for (const custody of [false, true]) {
      const f = abortFixture(custody, kind),
        events = (await projectOwnerLedger(f.input)).events,
        e = events.find(
          (e) => e.settlement?.optionLifecycle?.refund?.kind === "aborted_buy",
        );
      assert.equal(e?.settlement?.status, "confirmed", JSON.stringify(events));
      assert.equal(e.settlement.optionLifecycle?.outcome, "refunded");
      assert.equal(
        e.settlement.optionLifecycle?.refund?.unwind?.custody.status,
        custody ? "proven" : "not_transferred",
      );
      assert.equal(
        e.movements.filter((m) => m.purpose === "option_refund").length,
        custody ? 2 : 1,
      );
      assert.equal(
        e.movements
          .filter((m) => m.asset.kind === "jetton")
          .reduce(
            (s, m) =>
              s + BigInt(m.amountRaw) * (m.direction === "in" ? 1n : -1n),
            0n,
          ),
        0n,
        "all gross funding is actually returned exactly once",
      );
      assert(
        !events.some((e) => e.kind === "option_buy"),
        "a proved refunded original request is not left as a perpetual pending buy",
      );
      assert(
        !events
          .flatMap((e) => e.movements)
          .some((m) => m.asset.kind === "option_position"),
        "reserved positions never become acquired/retired ACTIVE rights",
      );
    }
  await adverseCases();
  await vaultAccountingCases();
  await vaultJournalCases();
  for (const status of ["committed", "failed", "unobserved"] as const) {
    const f = abortFixture(true, 1, true, true, status);
    await durableOptionAbort(f, f.finalCancel.lt, 1);
  }
  console.log(
    "option abort original funding, factory/vault custody return and exact conservation tests passed",
  );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
export { abortFixture };
