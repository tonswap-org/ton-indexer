import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cell } from "@ton/core";
import { LedgerGraphBuilder } from "../ledger/graph";
import { projectOwnerLedger } from "../ledger/project";
import type { LedgerAsset } from "../ledger/types";
import type { AccountStateResponse, RawTransaction, TonDataSource } from "../data/dataSource";
import type { LedgerLaunchpadCodeHashes } from "../config/ledgerLaunchpad";
import type { PostgresLedgerStore } from "../ledger/store";
import { canonicalLedgerHash } from "../ledger/normalize";
import { loadOpcodes } from "../utils/opcodes";
import { readFixedSaleState } from "../ledger/launchpadState";
import { readBondingSaleState } from "../ledger/launchpadBondingState";
import { readAuctionSaleState } from "../ledger/launchpadAuctionState";

type Fixture = {
  accounts: { sale: string; owner: string; paymentRoot: string; paymentSaleWallet: string; ownerPaymentWallet: string };
  transactions: { phase: string; account: string; raw: RawTransaction }[];
  boundaries: { account: string; transactionLt: string; transactionHash: string; before: AccountStateResponse; after: AccountStateResponse }[];
};
const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/launchpad-fixed-refund.json"), "utf8")) as Fixture;
const modelFixtures = {
  fixed: fixture,
  bonding: JSON.parse(readFileSync(resolve(__dirname, "fixtures/launchpad-bonding-contributions.json"), "utf8")) as Fixture,
  auction: JSON.parse(readFileSync(resolve(__dirname, "fixtures/launchpad-auction-bids.json"), "utf8")) as Fixture,
};
const codeHash = (f: Fixture) => Cell.fromBase64(f.boundaries.filter(b => b.account === f.accounts.sale).at(-1)!.after.codeBoc!).hash().toString("hex");
function prepare(fixture: Fixture, model: keyof typeof modelFixtures) {
const current = new Map<string, AccountStateResponse>();
for (const boundary of fixture.boundaries)
  if (!current.has(boundary.account) || BigInt(current.get(boundary.account)!.lastTxLt ?? "0") < BigInt(boundary.after.lastTxLt ?? "0"))
    current.set(boundary.account, boundary.after);
const saleState = current.get(fixture.accounts.sale)!;
const fixedCodeHash = Cell.fromBase64(saleState.codeBoc!).hash().toString("hex");
const paymentState = model === "fixed" ? readFixedSaleState(saleState.dataBoc!) : model === "bonding" ? readBondingSaleState(saleState.dataBoc!) : readAuctionSaleState(saleState.dataBoc!);
const hashes: LedgerLaunchpadCodeHashes = { fixedCodeHash: codeHash(modelFixtures.fixed), bondingCodeHash: codeHash(modelFixtures.bonding), auctionCodeHash: codeHash(modelFixtures.auction), walletCodeHash: paymentState.paymentRouting.walletCodeHash };
const assets = new Map<string, LedgerAsset>();
for (const [wallet, state] of current) {
  if (!state.codeBoc || !state.dataBoc || Cell.fromBase64(state.codeBoc).hash().toString("hex") !== hashes.walletCodeHash) continue;
  const data = Cell.fromBase64(state.dataBoc).beginParse(); data.loadCoins();
  const owner = data.loadAddress().toRawString(), master = data.loadAddress().toRawString();
  assets.set(wallet, { kind: "jetton", id: `mainnet:jetton:${master}`, owner, master, wallet, decimals: 9 });
}
const histories = new Map<string, RawTransaction[]>();
for (const row of fixture.transactions) histories.set(row.account, [...(histories.get(row.account) ?? []), row.raw]);
const archive = new Map<string, { seqno: number; state: AccountStateResponse }>();
for (const [index, boundary] of fixture.boundaries.entries())
  for (const state of [boundary.before, boundary.after])
    if (state.lastTxLt && state.lastTxHash) archive.set(`${boundary.account}:${state.lastTxLt}:${canonicalLedgerHash(state.lastTxHash)}`, { seqno: index + 1, state });

return { fixture, current, saleState, paymentState, hashes, assets, histories, archive };
}
const defaultContext = prepare(fixture, "fixed");
const { paymentState, hashes } = defaultContext;

async function build(options: {
  hashes?: LedgerLaunchpadCodeHashes | null; ownerTransactions?: RawTransaction[];
  identityMismatch?: boolean; missingCode?: boolean; incompletePaymentHistory?: boolean; maxAccounts?: number;
} = {}, context = defaultContext) {
  const { fixture, current, saleState, hashes, assets, histories, archive } = context;
  const crawled: string[] = [], getters: string[] = [], currentReads: string[] = [];
  const store = {
    account: async (_network: string, account: string) => ({ current_generation: account, checked_at: "2026-01-01T00:00:00.000Z", syncing: false }),
    rawHistory: async (generation: string) => (generation === fixture.accounts.owner && options.ownerTransactions !== undefined
      ? options.ownerTransactions : histories.get(generation) ?? []).map(raw => ({ raw })),
    pool: { query: async (sql: string, values: string[]) => {
      if (sql.startsWith("SELECT complete")) return { rows: [{ complete: true, head_observed_at: "2026-01-01T00:00:00.000Z" }] };
      if (sql.startsWith("SELECT snapshot")) {
        const snapshot = archive.get(`${values[1]}:${values[2]}:${values[3]}`);
        return { rows: snapshot ? [{ snapshot }] : [] };
      }
      throw Error(`Unexpected graph storage call: ${sql}`);
    } },
  } as unknown as PostgresLedgerStore;
  const source = {
    getAccountState: async (account: string) => {
      currentReads.push(account);
      if (options.missingCode && account === fixture.accounts.sale) return { ...saleState, codeBoc: null };
      return current.get(account) ?? { balance: "0", accountState: "uninitialized", lastTxLt: "0" };
    },
    getJettonBalance: async (owner: string, master: string) => {
      const asset = [...assets.values()].find(asset => asset.owner === owner && asset.master === master);
      return asset ? { wallet: asset.wallet } : null;
    },
    runGetMethod: async (_account: string, method: string) => { getters.push(method); throw Error(`Unexpected getter: ${method}`); },
  } as unknown as TonDataSource;
  const builder = new LedgerGraphBuilder("mainnet", source, store, [fixture.accounts.paymentRoot], undefined,
    async wallet => {
      const asset = assets.get(wallet);
      return options.identityMismatch && wallet === fixture.accounts.paymentSaleWallet && asset
        ? { ...asset, owner: fixture.accounts.owner } : asset ?? null;
    },
    async account => { crawled.push(account); return !(options.incompletePaymentHistory && account === fixture.accounts.paymentSaleWallet); },
    options.maxAccounts ?? 256, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    options.hashes === null ? undefined : options.hashes ?? hashes, [fixture.accounts.sale]);
  const graph = await builder.build(fixture.accounts.owner, fixture.accounts.owner, "2026-01-01T00:00:00.000Z");
  return { graph, crawled, getters, currentReads };
}

async function main() {
  const complete = await build();
  const sale = complete.graph.launchpadSales.get(fixture.accounts.sale);
  assert(sale, "qualified current code and independently resolved payment wallet discover the fixed sale");
  assert.equal(sale.factory, paymentState.registry.factory, "recorded coordinator identity does not imply official registry authority");
  assert.equal(sale.paymentWallet, fixture.accounts.paymentSaleWallet);
  assert(complete.crawled.includes(fixture.accounts.sale));
  assert(complete.crawled.includes(fixture.accounts.paymentSaleWallet));
  assert(complete.graph.chains.get(fixture.accounts.paymentSaleWallet)?.historyComplete);
  assert(!complete.getters.includes("pool_state"), "CNTR and CLAM never enter DLMM discovery");
  const projection = await projectOwnerLedger({ network: "mainnet", owner: fixture.accounts.owner, opcodes: loadOpcodes(), ...complete.graph });
  assert(projection.events.some(event => event.settlement?.protocol === "launchpad" && event.settlement.status === "confirmed"),
    "graph-discovered histories and archived transaction states reach the real refund projector");
  for (const options of [{ hashes: null }, { hashes: { ...hashes, fixedCodeHash: "f".repeat(64) } },
    { hashes: { ...hashes, walletCodeHash: "e".repeat(64) } }, { missingCode: true }, { identityMismatch: true }]) {
    const result = await build(options);
    assert.equal(result.graph.launchpadSales.size, 0, "missing or conflicting qualification never admits a sale");
    assert(result.graph.launchpadControllers.includes(fixture.accounts.sale), "known product boundary survives failed qualification");
    const unresolved = await projectOwnerLedger({ network: "mainnet", owner: fixture.accounts.owner, opcodes: loadOpcodes(), ...result.graph });
    assert(unresolved.events.some(event => event.issues.includes("launchpad_claim_settlement_unverified")),
      "a recognized claim retains its retry boundary before code or archive qualification is available");
    assert(!unresolved.events.some(event => event.settlement?.protocol === "launchpad" && event.settlement.status === "confirmed"));
  }
  const receiverOnly = await build({ ownerTransactions: [] });
  assert(receiverOnly.graph.launchpadSales.has(fixture.accounts.sale), "empty refund discovers sale from independently resolved source-wallet owner");
  const partial = await build({ incompletePaymentHistory: true });
  assert.equal(partial.graph.chains.get(fixture.accounts.paymentSaleWallet)?.historyComplete, false);
  const provisional = await projectOwnerLedger({ network: "mainnet", owner: fixture.accounts.owner, opcodes: loadOpcodes(), ...partial.graph });
  assert(!provisional.events.some(event => event.settlement?.protocol === "launchpad" && event.settlement.status === "confirmed"));
  assert(partial.graph.issues.includes("related_account_history_incomplete"));
  const bounded = await build({ maxAccounts: 1 });
  assert(bounded.graph.issues.includes("related_account_limit_reached"));
  assert(bounded.currentReads.length <= 1, "Launchpad current-code discovery obeys the configured account bound");
  for (const model of ["bonding", "auction"] as const) {
    const context = prepare(modelFixtures[model], model), owner = context.fixture.accounts.owner, saleAddress = context.fixture.accounts.sale;
    const result = await build({}, context), qualified = result.graph.launchpadSales.get(saleAddress);
    assert(qualified, `${model}: the actual current model code and state are qualified`);
    assert.equal(qualified.model, model); assert.equal(qualified.saleCodeHash, context.hashes[`${model}CodeHash`]);
    assert.equal(qualified.paymentWallet, context.fixture.accounts.paymentSaleWallet);
    assert(result.graph.chains.get(qualified.paymentWallet)?.historyComplete);
    assert(!result.getters.includes("pool_state"), `${model}: no DLMM fallback`);
    const events = (await projectOwnerLedger({ network: "mainnet", owner, opcodes: loadOpcodes(), ...result.graph })).events;
    const accepted = events.filter(event => event.kind === "launchpad_participation" && event.settlement?.status === "confirmed");
    assert.equal(accepted.length, model === "bonding" ? 3 : 2, `${model}: every exact accepted owner request reaches projector once`);
    const otherModel = model === "bonding" ? "auction" : "bonding";
    for (const wrong of [
      { ...context.hashes, [`${model}CodeHash`]: "f".repeat(64) },
      { ...context.hashes, [`${model}CodeHash`]: "f".repeat(64), [`${otherModel}CodeHash`]: context.hashes[`${model}CodeHash`] },
      { ...context.hashes, [`${otherModel}CodeHash`]: context.hashes[`${model}CodeHash`] },
    ]) {
      const bad = await build({ hashes: wrong }, context);
      assert.equal(bad.graph.launchpadSales.size, 0, `${model}: missing, mislabeled or ambiguous current code never falls back to another format`);
      const rejected = (await projectOwnerLedger({ network: "mainnet", owner, opcodes: loadOpcodes(), ...bad.graph })).events;
      assert(!rejected.some(event => event.kind === "launchpad_participation" && event.settlement?.status === "confirmed"));
    }
    const partial = await build({ incompletePaymentHistory: true }, context);
    const incomplete = (await projectOwnerLedger({ network: "mainnet", owner, opcodes: loadOpcodes(), ...partial.graph })).events;
    assert(!incomplete.some(event => event.kind === "launchpad_participation" && event.settlement?.status === "confirmed"), `${model}: partial payment history cannot confirm original intent`);
  }
  console.log("Launchpad graph: qualification, code/routing conflicts, archive-to-projector settlement, receiver-only discovery, partial history, discovery bounds and real bonding/auction qualification with no model fallback passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
