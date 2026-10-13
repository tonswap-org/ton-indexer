import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell } from '@ton/core';
import type { RawMessage, RawTransaction } from '../data/dataSource';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from '../ledger/project';
import { INTERNAL, NOTIFY, TRANSFER } from '../ledger/wire';
import { DEPOSIT_NOTE } from '../ledger/t3Wire';
import { loadOpcodes } from '../utils/opcodes';
import { fixture as perpsFixture } from './ledger-perps-oracle-execution-test';
import { launchpadFixture } from './ledger-launchpad-test';

const flags = ['settlement_not_decoded', 'related_account_coverage_unverified'];
const address = (n: number) => new Address(0, Buffer.alloc(32, n)).toRawString();
// Synthetic transfer vectors isolate flag/freshness behavior; they do not stand
// in for the native perps and launchpad settlement traces used below.
function depositFixture(mint = true) {
  const owner = address(1), hub = address(2), root = address(3), reserve = address(4), wallet = address(5), vault = address(6), t3Wallet = address(7);
  const accounts = [owner, hub, root, reserve, wallet, vault, t3Wallet];
  const chains = new Map<string, LedgerChain>(accounts.map(account => [account, { account, role: account === owner ? 'owner' : account === wallet || account === t3Wallet ? 'owned_jetton_wallet' : 'counterparty',
    generation: 'synthetic', historyComplete: true, atBoundary: true, transactions: [] }]));
  const asset = (w: string, o: string, r: string) => ({ kind: 'jetton' as const, id: `testnet:jetton:${r}`, master: r, wallet: w, owner: o, decimals: 9 });
  let lt = 10;
  const payload = mint ? beginCell().storeUint(DEPOSIT_NOTE, 32).storeUint(1, 8).storeUint(0, 8).storeUint(0, 16)
    .storeAddress(Address.parse(owner)).storeRef(beginCell().storeAddress(null)).endCell() : Cell.EMPTY;
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
    t3Hubs: mint ? new Map([[hub, { address: hub, root, codeHash: '0'.repeat(64), reserveRoots: [reserve, address(8), address(9)], vaults: [vault, address(10), address(11)], redemptions: new Map() }]]) : undefined };
  return { input, owner, hub, root, t3Wallet, vault };
}
async function main() {
  // Isolate the known-message predicate with a synthetic summary of the
  // captured CLOSE rejection: remove the extra outgoing VM bounce. The native
  // fixture itself remains unchanged and is verified by its full owned suite.
  const knownClose = () => {
    const f = perpsFixture('failed-close');
    for (const tx of f.input.chains.get(f.f.engine)!.transactions)
      tx.outMessages = tx.outMessages.filter(message => !message.bounced);
    return f;
  };
  const close = knownClose();
  const closeEvent = (await projectOwnerLedger(close.input)).events.find(event => event.kind === 'perps_operation')!;
  assert.equal(closeEvent.settlement?.status, 'confirmed');
  assert.equal(closeEvent.settlement?.perps?.request.operation, 'close');
  assert(flags.every(flag => !closeEvent.issues.includes(flag)), 'a proven perps close loses both default flags');
  assert([...close.input.chains.values()].every(chain => !chain.historyComplete && chain.verifiedRange), 'real fixture retains verified ranges');
  const unknown = knownClose();
  const ownerTx = unknown.input.chains.get(unknown.f.owner)!.transactions.find(tx => tx.outMessages.some(msg => msg.destination && Address.parse(msg.destination).toRawString() === unknown.f.engine))!;
  assert(ownerTx);
  ownerTx.outMessages.push({ source: unknown.f.owner, destination: unknown.f.engine, value: '0', createdLt: '999999999999',
    op: 0xdeadbeef, body: beginCell().storeUint(0xdeadbeef, 32).endCell().toBoc().toString('base64') });
  const unknownEvent = (await projectOwnerLedger(unknown.input)).events.find(event => event.kind === 'perps_operation')!;
  assert.equal(unknownEvent.settlement?.status, 'confirmed');
  assert(flags.every(flag => unknownEvent.issues.includes(flag)), 'an unknown grouped message retains both default flags');

  const transfer = (await projectOwnerLedger(depositFixture(false).input)).events.find(event => event.movements.some(m => m.asset.kind === 'jetton'))!;
  assert(transfer); assert(flags.every(flag => !transfer.issues.includes(flag)), 'known ordinary token transfer retains existing flag behavior');
  for (const stale of ['hub', 'root', 't3Wallet', 'vault'] as const) {
    const f = depositFixture(); f.input.chains.get(f[stale])!.atBoundary = false;
    const pending = (await projectOwnerLedger(f.input)).events.find(event => event.kind === 't3_mint')!;
    assert(pending); assert.equal(pending.settlement?.status, 'incomplete');
    assert(pending.issues.includes('related_account_refresh_pending'), `${stale} pending is distinguished from an absent settlement`);
    assert(!pending.issues.includes('t3_mint_settlement_unconfirmed'));
  }
  const current = (await projectOwnerLedger(depositFixture().input)).events.find(event => event.kind === 't3_mint')!;
  assert(current.issues.includes('t3_mint_settlement_unconfirmed'));
  assert(!current.issues.includes('related_account_refresh_pending'));
  const sale = launchpadFixture();
  sale.input.chains.get(sale.accounts.sale)!.atBoundary = false;
  const refund = (await projectOwnerLedger(sale.input)).events.find(event => event.kind === 'launchpad_refund')!;
  assert(refund); assert.equal(refund.settlement?.status, 'incomplete');
  assert(refund.issues.includes('launchpad_refund_history_incomplete'), 'a behind sale cannot certify the refund absence guard');
  console.log('confirmed close/default flags, unknown-message guard, ordinary token transfer, four mint boundaries and stale sale refund passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
