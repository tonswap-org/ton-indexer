import { fixtureChainSource } from './support/chainFixture';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, TupleItem, beginCell } from '@ton/core';
import { LedgerGraphBuilder } from '../ledger/graph';
import { PostgresLedgerStore } from '../ledger/store';
import { LedgerAsset } from '../ledger/types';

import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { MINT_INTERNAL, mintInternal, receiverAddress, t3State } from '../ledger/t3Wire';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/t3-testnet-mint-discovery-20260912.json'), 'utf8'));
const original = decodeOriginalTransaction(Cell.fromBase64(fixture.transactionBoc), Address.parse(fixture.wallet));
assert.equal(original.hash, fixture.transactionHash);
assert.equal(original.lt, '96074524000011');
assert.equal(original.inMessage?.op, MINT_INTERNAL);
assert.equal(mintInternal(original.inMessage)?.amountRaw, '199388353090');

const stack = (rows: any[]): TupleItem[] => rows.map(([kind, value]) => kind === 'num'
  ? { type: 'int', value: BigInt(value) }
  : { type: kind, cell: Cell.fromBase64(value.bytes) });
const historicalRoutes = stack(fixture.routes.stack), vaults = stack(fixture.vaults.stack);
// The captured old getter is immutable evidence, not the current ABI. The
// synthetic current getter includes the mandatory wallet code at slot two.
const routes: TupleItem[] = [historicalRoutes[0], historicalRoutes[1],
  { type: 'cell', cell: beginCell().storeUint(0x4a545731, 32).endCell() }, ...historicalRoutes.slice(2)];
const readAddress = (value: TupleItem) => 'cell' in value ? value.cell.beginParse().loadAddress().toRawString() : '';
const reserveRoots = [3, 8, 13].map(index => readAddress(routes[index]));
const reserveVaults = vaults.map(readAddress);
const receiver = receiverAddress((routes[1] as { type: 'cell'; cell: Cell }).cell, fixture.hub, fixture.owner);
const asset = (wallet: string, master: string, owner: string): LedgerAsset => ({
  kind: 'jetton', id: `testnet:jetton:${master}`, wallet, master, owner,
});
const identities = new Map<string, LedgerAsset>([
  [fixture.wallet, asset(fixture.wallet, fixture.root, fixture.owner)],
  ...reserveVaults.map((wallet, index) => [wallet, asset(wallet, reserveRoots[index], fixture.hub)] as const),
]);

// Preserve the captured historical bytes. A separate synthetic current-layout
// state exercises discovery while the original obsolete state must fail closed.
const oldState = Cell.fromBase64(fixture.hubState.data_boc), payload = oldState.refs[0];
const referral = beginCell().storeUint(0, 32).storeCoins(0).storeUint(1, 64).storeUint(0, 64).storeUint(0, 64)
  .storeRef(Cell.EMPTY).storeRef(beginCell().storeUint(0, 64).storeUint(0, 64).storeDict(null).storeDict(null)).storeDict(null).endCell();
const historicalBounce = payload.refs[3];
const bounce = beginCell().storeAddress(null).storeUint(0, 32).storeUint(0, 32).storeCoins(0).storeInt(0, 64)
  .storeRef(historicalBounce.refs[0]).storeRef(historicalBounce.refs[1]).storeRef(referral).endCell();
const historicalRuntime = payload.refs[2];
const currentPeg = beginCell().storeSlice(historicalRuntime.refs[0].beginParse())
  .storeUint(0, 16).endCell(); // Historical capture omitted the third haircut.
const runtime = beginCell().storeRef(Cell.EMPTY).storeRef(Cell.EMPTY)
  .storeRef(currentPeg).storeRef(historicalRuntime.refs[1]).endCell();
const currentPayload = beginCell().storeBits(payload.bits).storeRef(payload.refs[0]).storeRef(payload.refs[1]).storeRef(runtime).storeRef(bounce).endCell();
const currentState = beginCell().storeUint(0x54335354, 32).storeRef(currentPayload).endCell();
assert.doesNotThrow(() => t3State(currentState.toBoc().toString('base64')));

async function inspect(failRoutes: boolean, current = true, receiverFailure: 'unavailable' | 'identity' | 'getter' = 'unavailable', routeLayout: 'current' | 'old' | 'bad-wallet' = 'current') {
  const reads: string[] = [];
  const store = {
    account: async (_network: string, account: string) => ({ current_generation: account, syncing: false }),
    rawHistory: async (generation: string) => generation === fixture.wallet ? [{ raw: original }] : [],
    pool: { query: async () => ({ rows: [{ complete: true }] }) },
  } as unknown as PostgresLedgerStore;
  const source = fixtureChainSource({
    getAccountState: async (address: string) => {
      reads.push(address);
      if (address === receiver) {
        if (receiverFailure === 'unavailable') throw new Error('Unrelated receiver source read unavailable');
        return { accountState: 'active', balance: '0', codeBoc: (routes[1] as { type: 'cell'; cell: Cell }).cell.toBoc().toString('base64') };
      }
      if (address === fixture.hub) return { accountState: 'active', balance: fixture.hubState.balance_raw,
        codeBoc: fixture.hubState.code_boc, dataBoc: current ? currentState.toBoc().toString("base64") : fixture.hubState.data_boc };
      return { accountState: 'uninitialized', balance: '0' };
    },
    walletBalance: async (owner: string, master: string) => owner === fixture.owner && master === fixture.root
      ? { wallet: fixture.wallet, balance: '1099388353090' } : null,
    runGetMethod: async (address: string, method: string) => {
      if (address === receiver && method === 'receiver_identity' && receiverFailure === 'getter')
        throw new Error('Unrelated receiver getter unavailable');
      if (address === fixture.hub && method === 'vault_routes') return failRoutes ? null : { exitCode: 0,
        stack: routeLayout === 'old' ? historicalRoutes : routeLayout === 'bad-wallet'
          ? routes.map((item, index) => index === 2 ? { type: 'null' as const } : item) : routes };
      if (address === fixture.hub && method === 'vault_addresses') return { exitCode: 0, stack: vaults };
      if (address === fixture.root && method === 'root_emitter') return { exitCode: 0, stack: [{ type: 'slice', cell: beginCell().storeAddress(Address.parse(fixture.hub)).endCell() }] };
      return null;
    },
  });
  const graph = await new LedgerGraphBuilder('testnet', source, store, [], undefined,
    async wallet => identities.get(wallet) ?? null, async () => true, 256, undefined, fixture.hub, fixture.root)
    .build(fixture.owner, fixture.owner, '2026-09-13T00:00:00.000Z');
  return { graph, reads };
}

async function main() {
  assert.equal((await inspect(false, false)).graph.t3Hubs.size, 0, 'Historical hub layout without referrals is unsupported');
  for (const routeLayout of ['old', 'bad-wallet'] as const) {
    const rejected = (await inspect(false, true, 'unavailable', routeLayout)).graph;
    assert.equal(rejected.t3Hubs.size, 0, 'Missing or invalid current wallet code cannot qualify the hub');
    assert.ok(rejected.issues.includes('t3_hub_identity_or_custody_unresolved'));
  }
  const { graph, reads } = await inspect(false);
  assert.ok(reads.includes(receiver));
  assert.ok(graph.t3Hubs.has(fixture.hub),
    `An unrelated receiver outage must not hide the mint hub: ${JSON.stringify(graph.issues)}`);
  assert.ok(graph.chains.has(fixture.root));
  assert.ok(graph.chains.has(fixture.hub));
  assert.ok(graph.issues.includes('t3_receiver_state_unavailable'));
  assert.equal(graph.t3Hubs.get(fixture.hub)?.receiver, undefined, 'An unavailable receiver cannot prove redemption custody');
  for (const failure of ['identity', 'getter'] as const) {
    const unrelatedReceiver = (await inspect(false, true, failure)).graph;
    assert.ok(unrelatedReceiver.t3Hubs.has(fixture.hub),
      `Receiver ${failure} failure must not hide the independently verified mint hub`);
    assert.equal(unrelatedReceiver.t3Hubs.get(fixture.hub)?.receiver, undefined,
      'An unverified receiver must never establish redemption custody');
    assert.ok(unrelatedReceiver.issues.includes('t3_receiver_identity_or_custody_unresolved'));
  }
  const unavailable = (await inspect(true)).graph;
  assert.equal(unavailable.t3Hubs.size, 0);
  assert.ok(unavailable.issues.includes('t3_hub_identity_or_custody_unresolved'), 'Known mint activity cannot disappear silently when required getters fail');
  console.log('T3 discovery passed: frozen mint decoded, obsolete hub/getter layouts rejected, synthetic current18-field routes and referral layout discovered, unrelated receiver failure isolated. Discovery only, not historical delivery qualification.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
