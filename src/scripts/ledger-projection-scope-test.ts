import assert from "node:assert/strict";
import { Address, beginCell } from "@ton/core";
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from "../ledger/project";
import type { LedgerAsset, LedgerProjection } from "../ledger/types";
import type { RawMessage, RawTransaction } from "../data/dataSource";
import { loadOpcodes } from "../utils/opcodes";

const addr = (n: number) => "0:" + n.toString(16).padStart(64, "0");
const owner = addr(1), otherOwner = addr(2), wallet = addr(3), receiver = addr(4), receiverWallet = addr(5), master = addr(6);
const hash = (n: number) => Buffer.alloc(32, n).toString("base64");
const chain = (account: string, role: LedgerChain["role"], transactions: RawTransaction[] = []): LedgerChain => ({
  account, role, generation: "scope-fixture-" + account, historyComplete: true,
  checkedAt: "2026-01-01T00:00:00Z", transactions,
});
const asset = (wallet: string, owner: string, controller?: string): LedgerAsset => ({
  kind: "jetton", id: "mainnet:jetton:" + master, master, wallet, owner,
  ...(controller ? { controller } : {}), decimals: 9, symbol: "TOKEN",
});
const input = (account = owner): ProjectionInput => ({
  network: "mainnet", owner: account, chains: new Map([[account, chain(account, "owner")]]),
  wallets: new Map(), pools: new Map(), opcodes: loadOpcodes(), stateAt: async () => null,
});
const nativeFlow = (source: string, destination: string): [RawTransaction, RawTransaction] => {
  const message: RawMessage = { source, destination, value: "1000", op: 0,
    body: beginCell().storeUint(0, 32).endCell().toBoc().toString("base64"),
    createdLt: "11", forwardFeeRaw: "0", extraFlagsRaw: "0" };
  return [
    { lt: "10", hash: hash(10), utime: 1735689600, success: true, status: "success",
      totalFeesRaw: "10", inMessage: {}, outMessages: [message] },
    { lt: "12", hash: hash(12), utime: 1735689601, success: true, status: "success",
      totalFeesRaw: "5", inMessage: message, outMessages: [] },
  ];
};
const fees = (projection: LedgerProjection) => projection.events.flatMap(event => event.movements)
  .filter(movement => movement.direction === "fee").reduce((sum, movement) => sum + BigInt(movement.amountRaw), 0n);
const overlap = (left: LedgerProjection, right: LedgerProjection) =>
  left.projectionScope.physicalAccounts.filter(account => right.projectionScope.physicalAccounts.includes(account));

async function main() {
  {
    const f = input();
    f.wallets.set(wallet, asset(wallet, owner));
    const projection = await projectOwnerLedger(f);
    assert.deepEqual(projection.projectionScope, { kind: "owner", owner, physicalAccounts: [owner, wallet] });
    assert.deepEqual(projection.events, []);
    assert(!f.chains.has(wallet), "quiet owned wallet without a loaded chain remains in the exact inclusion set");
  }
  {
    const f = input();
    const [, foreignTx] = nativeFlow(otherOwner, wallet);
    f.chains.set(wallet, chain(wallet, "owned_jetton_wallet", [foreignTx]));
    f.wallets.set(wallet, asset(wallet, otherOwner));
    const projection = await projectOwnerLedger(f);
    assert.deepEqual(projection.projectionScope.physicalAccounts, [owner]);
    assert.deepEqual(projection.events, [], "misleading discovery role does not admit a foreign wallet's cash or fee");
    assert.equal(f.chains.get(wallet)!.role, "owned_jetton_wallet", "source discovery evidence is not rewritten");
  }
  {
    const f = input();
    f.chains.set(receiver, chain(receiver, "controlled_contract"));
    f.wallets.set(receiverWallet, asset(receiverWallet, receiver, owner));
    const projection = await projectOwnerLedger(f);
    assert.deepEqual(projection.projectionScope.physicalAccounts, [owner, receiver, receiverWallet]);
    assert.deepEqual(projection.events, []);
  }
  {
    const f = input();
    f.wallets.set(receiverWallet, asset(receiverWallet, owner));
    f.wallets.set(wallet, asset(wallet, owner));
    f.chains.set(wallet, chain(wallet, "controlled_contract"));
    const projection = await projectOwnerLedger(f);
    assert.deepEqual(projection.projectionScope.physicalAccounts, [owner, wallet, receiverWallet]);
    assert.equal(new Set(projection.projectionScope.physicalAccounts).size, 3);
    projection.projectionScope.physicalAccounts.push(otherOwner);
    assert.deepEqual((await projectOwnerLedger(f)).projectionScope.physicalAccounts, [owner, wallet, receiverWallet],
      "returned scope does not mutate future projections or the source graph");
  }
  {
    const [ownerTx, walletTx] = nativeFlow(owner, wallet);
    const f = input();
    f.chains.set(owner, chain(owner, "owner", [ownerTx]));
    f.chains.set(wallet, chain(wallet, "owned_jetton_wallet", [walletTx]));
    f.wallets.set(wallet, asset(wallet, owner));
    const ownerProjection = await projectOwnerLedger(f);
    const g = input(wallet);
    g.chains.set(wallet, chain(wallet, "owner", [walletTx]));
    const walletProjection = await projectOwnerLedger(g);
    assert.equal(fees(ownerProjection), 15n);
    assert.equal(fees(walletProjection), 5n);
    assert.equal(fees(ownerProjection) + fees(walletProjection), 20n, "overlapping projections would repeat the physical custody fee");
    assert.deepEqual(overlap(ownerProjection, walletProjection), [wallet]);
    assert.deepEqual(ownerProjection.events.flatMap(event => event.movements).map(row => row.direction), ["fee", "fee"],
      "owner-internal funding is excluded without altering physical fees");
    const all = [...ownerProjection.events, ...walletProjection.events];
    const repeatedFee = all.flatMap(event => event.movements.filter(row => row.direction === "fee" && row.source === wallet));
    assert.equal(repeatedFee.length, 2);
    assert.equal(repeatedFee[0].id, repeatedFee[1].id);
    assert.deepEqual(repeatedFee[0].evidence, repeatedFee[1].evidence);
    const legIds = all.flatMap(event => event.movements.map(row => event.id + "/" + row.id));
    assert.equal(new Set(legIds).size, legIds.length, "different group anchors explain why ordinary leg-ID checks miss this overlap");
    assert(all.every(event => event.issues.length === 0));
  }
  {
    const [ownerTx, otherTx] = nativeFlow(owner, otherOwner);
    const f = input(), g = input(otherOwner);
    f.chains.set(owner, chain(owner, "owner", [ownerTx]));
    f.chains.set(otherOwner, chain(otherOwner, "counterparty", [otherTx]));
    g.chains.set(owner, chain(owner, "counterparty", [ownerTx]));
    g.chains.set(otherOwner, chain(otherOwner, "owner", [otherTx]));
    const a = await projectOwnerLedger(f), b = await projectOwnerLedger(g);
    assert.deepEqual(a.projectionScope.physicalAccounts, [owner]);
    assert.deepEqual(b.projectionScope.physicalAccounts, [otherOwner]);
    assert.deepEqual(overlap(a, b), []);
    assert.equal(fees(a) + fees(b), 15n);
    assert.deepEqual(a.events.flatMap(event => event.movements).filter(row => row.direction === "out").map(row => row.amountRaw), ["1000"]);
    assert.deepEqual(b.events.flatMap(event => event.movements).filter(row => row.direction === "in").map(row => row.amountRaw), ["1000"]);
  }
  {
    const f = input(Address.parse(owner).toString());
    await assert.rejects(projectOwnerLedger(f), /canonical raw TON/);
  }
  {
    const f = input();
    f.wallets.set(Address.parse(wallet).toString(), asset(wallet, owner));
    await assert.rejects(projectOwnerLedger(f), /canonical raw TON/);
  }
  console.log("Ledger projection scope: 8 fixtures passed (quiet/missing chain, misleading discovery role, controlled receiver, sorted independent scope, exact overlapping fee, disjoint counterparties, canonical owner and custody).");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
