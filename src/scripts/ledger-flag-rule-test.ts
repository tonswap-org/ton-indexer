import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell } from '@ton/core';
import type { RawMessage, RawTransaction } from '../data/dataSource';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from '../ledger/project';
import { INTERNAL, NOTIFY, TRANSFER } from '../ledger/wire';
import { T3_MINT } from '../ledger/currentT3Wire';
import { loadOpcodes } from '../utils/opcodes';
import { currentT3MintFixture } from './support/currentT3Fixture';
import { launchpadFixture } from './ledger-launchpad-test';

const flags = ['settlement_not_decoded', 'related_account_coverage_unverified'];
const address = (n: number) => new Address(0, Buffer.alloc(32, n)).toRawString();
// Synthetic transfer vectors isolate flag/freshness behavior; they do not stand
// in for the native T3 and launchpad settlement traces used below.
function depositFixture(mint = true) {
  const owner = address(1), hub = address(2), root = address(3), reserve = address(4), wallet = address(5), vault = address(6), t3Wallet = address(7);
  const accounts = [owner, hub, root, reserve, wallet, vault, t3Wallet];
  const chains = new Map<string, LedgerChain>(accounts.map(account => [account, { account, role: account === owner ? 'owner' : account === wallet || account === t3Wallet ? 'owned_jetton_wallet' : 'counterparty',
    generation: 'synthetic', historyComplete: true, atBoundary: true, transactions: [] }]));
  const asset = (w: string, o: string, r: string) => ({ kind: 'jetton' as const, id: `testnet:jetton:${r}`, master: r, wallet: w, owner: o, decimals: 9 });
  let lt = 10;
  const payload = mint ? beginCell().storeUint(T3_MINT,32).storeCoins(0).storeAddress(Address.parse(owner)).endCell() : Cell.EMPTY;
  const msg = (source: string, destination: string, body: Cell): RawMessage => ({ source, destination, body: body.toBoc().toString('base64'),
    op: body.beginParse().preloadUint(32), createdLt: String(++lt), value: '100', bounced: false });
  const request = msg(owner, wallet, beginCell().storeUint(TRANSFER, 32).storeUint(1, 64).storeCoins(10)
    .storeAddress(Address.parse(hub)).storeAddress(Address.parse(owner)).storeRef(Cell.EMPTY).storeCoins(1).storeRef(payload).endCell());
  const internal = msg(wallet, vault, beginCell().storeUint(INTERNAL, 32).storeUint(1, 64).storeCoins(10)
    .storeAddress(Address.parse(owner)).storeAddress(Address.parse(owner)).storeCoins(1).storeRef(payload).endCell());
  const notification = msg(vault, hub, beginCell().storeUint(NOTIFY, 32).storeUint(1, 64).storeCoins(10)
    .storeAddress(Address.parse(owner)).storeAddress(Address.parse(wallet)).storeCoins(1).storeRef(payload).endCell());
  function add(account: string, inMessage: RawMessage | undefined, outMessages: RawMessage[]) {
    const raw: RawTransaction = { lt: String(++lt), hash: createHash('sha256').update(String(lt)).digest('base64'), prevTransactionLt: '0',
      prevTransactionHash: Buffer.alloc(32).toString('base64'), utime: 1700000000 + lt, status: 'success', success: true, totalFeesRaw: '1', inMessage, outMessages };
    chains.get(account)!.transactions.push(raw);
  }
  add(owner, undefined, [request]); add(wallet, request, [internal]); add(vault, internal, [notification]); add(hub, notification, []);
  const input: ProjectionInput = { network: 'testnet', owner, chains, wallets: new Map([[wallet, asset(wallet, owner, reserve)], [vault, asset(vault, hub, reserve)], [t3Wallet, asset(t3Wallet, owner, root)]]),
    pools: new Map(), opcodes: loadOpcodes(), stateAt: async () => null,
    t3Hubs: undefined };

  return { input, owner, hub, root, t3Wallet, vault };
}
async function main() {
  // The shared flag predicate is product-independent. Exercise it with current
  // native T3 custody evidence, without loading an obsolete Perps source closure.
  const known = currentT3MintFixture();
  const minted = (await projectOwnerLedger(known.input)).events.find(event => event.kind === 't3_mint' && event.settlement?.t3?.stage === 'minted')!;
  assert.equal(minted.settlement?.status, 'confirmed');
  assert(flags.every(flag => !minted.issues.includes(flag)), 'a proven current T3 mint loses both default flags');
  // A verified historical range supports the same positive evidence without
  // claiming that an account's history reaches genesis or the current boundary.
  for (const chain of known.input.chains.values()) {
    chain.historyComplete = false;
    chain.verifiedRange = { fromUtime: Math.min(...chain.transactions.map(tx => tx.utime)), toUtime: Math.max(...chain.transactions.map(tx => tx.utime)) + 1 };
  }
  const ranged = (await projectOwnerLedger(known.input)).events.find(event => event.id === minted.id)!;
  assert.equal(ranged.settlement?.status, 'confirmed');
  assert(flags.every(flag => !ranged.issues.includes(flag)), 'a proven operation in a verified range loses both default flags');
  const unknown = currentT3MintFixture();
  const request = minted.settlement!.t3!.receipt!.request;
  const ownerTx = unknown.input.chains.get(unknown.input.owner)!.transactions.find(tx => tx.outMessages.some(msg => msg.destination && Address.parse(msg.destination).toRawString() === request.sourceWallet && msg.body && Cell.fromBase64(msg.body).hash().toString('hex') === request.bodyHash))!;
  assert(ownerTx);
  ownerTx.outMessages.push({ source: unknown.input.owner, destination: unknown.hub, value: '0', createdLt: '999999999999',
    op: 0xdeadbeef, body: beginCell().storeUint(0xdeadbeef, 32).endCell().toBoc().toString('base64') });
  const unknownEvent = (await projectOwnerLedger(unknown.input)).events.find(event => event.id === minted.id)!;
  assert.equal(unknownEvent.settlement?.status, 'confirmed');
  assert(flags.every(flag => unknownEvent.issues.includes(flag)), 'an unknown grouped message retains both default flags');

  const transfer = (await projectOwnerLedger(depositFixture(false).input)).events.find(event => event.movements.some(m => m.asset.kind === 'jetton'))!;
  assert(transfer); assert(flags.every(flag => !transfer.issues.includes(flag)), 'known ordinary token transfer retains existing flag behavior');
  const current = (await projectOwnerLedger(depositFixture().input)).events.find(event => event.movements.some(m=>m.asset.kind==='jetton'))!;
  assert(current.issues.includes('t3_identity_or_settlement_unverified'), 'fresh T3 intent without qualified hub receipt remains unresolved');
  assert.notEqual(current.settlement?.status,'confirmed', 'unqualified request cannot become a mint credit');
  const sale = launchpadFixture();
  sale.input.chains.get(sale.accounts.sale)!.atBoundary = false;
  const refund = (await projectOwnerLedger(sale.input)).events.find(event => event.kind === 'launchpad_refund')!;
  assert(refund); assert.equal(refund.settlement?.status, 'incomplete');
  assert(refund.issues.includes('launchpad_refund_history_incomplete'), 'a behind sale cannot certify the refund absence guard');
  console.log('current native mint/default flags, verified range, unknown-message guard, ordinary token transfer, fresh T3 unqualified-intent boundary and stale sale refund passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
