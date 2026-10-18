import assert from 'node:assert/strict';
import { Address, beginCell } from '@ton/core';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { readT3OperationRequest, T3EvidenceError, type CurrentT3Request } from '../runtime/t3OperationRequest';

export function operationRequestFixture(kind: 'mint' | 'redeem' = 'mint') {
  const manifest = runtimeManifestFixture(), owner = `0:${'7'.repeat(64)}`, wallet = `0:${'8'.repeat(64)}`, hub = manifest.contracts.T3Hub!.address;
  const intent = beginCell().storeUint(kind === 'mint' ? 0x54334d4e : 0x54335244, 32);
  if (kind === 'redeem') intent.storeBit(true).storeUint(1, 2).storeBit(false);
  const terms = intent.storeCoins(5n).storeAddress(Address.parse(owner)).endCell();
  const body = kind === 'mint' ? beginCell().storeUint(0x0f8a7ea5, 32).storeUint(42, 64).storeCoins(10n)
    .storeAddress(Address.parse(hub)).storeAddress(Address.parse(owner)).storeMaybeRef(null).storeCoins(100n).storeBit(true).storeRef(terms).endCell()
    : beginCell().storeUint(0x595f07bc, 32).storeUint(42, 64).storeCoins(10n).storeAddress(Address.parse(owner)).storeMaybeRef(terms).endCell();
  const common = { network: 'testnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, owner, hub, queryId: '42', amountRaw: '10',
    recipient: owner, minimumRaw: '5', bodyBoc: body.toBoc().toString('base64'), bodyHash: body.hash().toString('hex') };
  const request: CurrentT3Request = kind === 'mint' ? { ...common, kind, collateralRoot: manifest.tokens.find(t => t.symbol === 'USDT')!.root,
    input: 0, sourceWallet: wallet, valueNano: '1000', submittedAt: Date.now() }
    : { ...common, kind, wallet, single: true, outputToken: 1, createdAt: Date.now() };
  return { request, manifest, body, intent: terms };
}
function main() {
  for (const kind of ['mint', 'redeem'] as const) {
    const f = operationRequestFixture(kind), parsed = readT3OperationRequest(f.request, f.manifest);
    assert.deepEqual(parsed.request, f.request); assert(parsed.body.equals(f.body)); assert(parsed.intent.equals(f.intent));
    for (const changed of [null, [], { ...f.request, extra: 1 }, { ...f.request, queryId: '042' }, { ...f.request, amountRaw: '11' },
      { ...f.request, bodyHash: '0'.repeat(64) }, { ...f.request, bodyBoc: f.request.bodyBoc + '\n' },
      { ...f.request, owner: Address.parse(f.request.owner).toString() }, { ...f.request, recipient: `0:${'9'.repeat(64)}` },
      { ...f.request, queryId: (1n << 64n).toString() }, { ...f.request, minimumRaw: '0' }])
      assert.throws(() => readT3OperationRequest(changed, f.manifest), error => error instanceof T3EvidenceError && error.status === 400);
    for (const changed of [{ ...f.request, network: 'mainnet' }, { ...f.request, manifestHash: '0'.repeat(64) }, { ...f.request, releaseId: 'other' }])
      assert.throws(() => readT3OperationRequest(changed, f.manifest), error => error instanceof T3EvidenceError && error.status === 409);
  }
  const mint = operationRequestFixture();
  assert.throws(() => readT3OperationRequest({ ...mint.request, input: 2 }, mint.manifest), T3EvidenceError);
  const burn = operationRequestFixture('redeem');
  assert.throws(() => readT3OperationRequest({ ...burn.request, outputToken: 0 }, burn.manifest), T3EvidenceError);
  console.log('Exact current T3 mint/redeem request fields, original body binding, release identity and malformed terms passed.');
}
if (require.main === module) main();
