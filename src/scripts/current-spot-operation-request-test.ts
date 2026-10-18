import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import { orderTermsToCell, type OrderTerms } from '../orders/state';
import {
  readSpotOperationRequest, SpotEvidenceError, type CurrentDirectSpotRequest, type CurrentRouteSpotRequest, type CurrentOrderCreateSpotRequest, type CurrentOrderSettlementSpotRequest,
} from '../runtime/spotOperationRequest';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';

type SwapFields = { op: number; minimum: bigint; deadline: number; recipient: Address; refundTo: Address;
  notify: boolean; forward: bigint; refundForward: bigint; user: Cell | null };
function payloadCell(fields: Partial<SwapFields> = {}) {
  const f: SwapFields = { op: 0x53575033, minimum: 5n, deadline: 1_900_000_000,
    recipient: Address.parse(runtimeAddress(700)), refundTo: Address.parse(runtimeAddress(700)),
    notify: false, forward: 0n, refundForward: 0n, user: null, ...fields };
  return beginCell().storeUint(f.op, 32).storeCoins(f.minimum).storeUint(f.deadline, 32)
    .storeAddress(f.recipient).storeAddress(f.refundTo).storeBit(f.notify).storeCoins(f.forward)
    .storeCoins(f.refundForward).storeMaybeRef(f.user).endCell();
}
type TransferFields = { op: number; queryId: bigint; amount: bigint; destination: Address; response: Address | null;
  custom: Cell | null; forward: bigint; payload: Cell };
function transferCell(fields: TransferFields) {
  return beginCell().storeUint(fields.op, 32).storeUint(fields.queryId, 64).storeCoins(fields.amount)
    .storeAddress(fields.destination).storeAddress(fields.response).storeMaybeRef(fields.custom)
    .storeCoins(fields.forward).storeBit(true).storeRef(fields.payload).endCell();
}
function encoded(cell: Cell) { return { bodyBoc: cell.toBoc().toString('base64'), bodyHash: cell.hash().toString('hex') }; }
function encodedTerms(cell: Cell) { return { termsBoc: cell.toBoc().toString('base64'), termsHash: cell.hash().toString('hex') }; }
function plainTerms(terms: OrderTerms) {
  return { ...terms, inputMaster: terms.inputMaster.toRawString(), pool: terms.pool.toRawString(),
    recipient: terms.recipient.toRawString(), executor: terms.executor?.toRawString() ?? null };
}

/** Synthetic request identity only; this test does not qualify current chain code. */
export function directSpotOperationRequestFixture(reverse = false) {
  const manifest = runtimeManifestFixture(), market = manifest.spotMarkets[0];
  const owner = runtimeAddress(700), t3 = manifest.tokens.find(t => t.symbol === 'T3')!;
  const paired = manifest.tokens.find(t => t.symbol === market.symbol)!;
  const fields: TransferFields = { op: 0x0f8a7ea5, queryId: 42n, amount: 10n, destination: Address.parse(market.pool),
    response: Address.parse(owner), custom: null, forward: 100n, payload: payloadCell() };
  const body = transferCell(fields);
  const request: CurrentDirectSpotRequest = { kind: 'direct', network: 'testnet', releaseId: manifest.releaseId,
    manifestHash: manifest.manifestHash, owner, pool: market.pool, payRoot: reverse ? paired.root : t3.root,
    receiveRoot: reverse ? t3.root : paired.root, sourceWallet: runtimeAddress(701), valueNano: '1000', ...encoded(body) };
  return { request, manifest, market, body, fields };
}

export function routeSpotOperationRequestFixture(reverse = false) {
  const manifest = runtimeManifestFixture(), [market, market2] = reverse ? [manifest.spotMarkets[1], manifest.spotMarkets[0]] : manifest.spotMarkets;
  const owner = runtimeAddress(700), coordinator = manifest.contracts.SwapCoordinator!.address;
  const finalPayload = payloadCell({ minimum: 7n });
  const continuation = beginCell().storeUint(0x52435433, 32).storeAddress(Address.parse(market2.pool)).storeRef(finalPayload).endCell();
  const payload = payloadCell({ recipient: Address.parse(coordinator), forward: 100n, user: continuation });
  const fields: TransferFields = { op: 0x0f8a7ea5, queryId: 42n, amount: 10n, destination: Address.parse(market.pool),
    response: Address.parse(owner), custom: null, forward: 500n, payload };
  const body = transferCell(fields);
  const request: CurrentRouteSpotRequest = { kind: 'route', network: 'testnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    owner, pool: market.pool, pool2: market2.pool, coordinator, sourceWallet: runtimeAddress(701),
    payRoot: manifest.tokens.find(t => t.symbol === market.symbol)!.root, receiveRoot: manifest.tokens.find(t => t.symbol === market2.symbol)!.root,
    valueNano: '1000', dispatch: { lt: '100', hash: 'a'.repeat(64) }, ...encoded(body) };
  return { request, manifest, market, market2, body, fields, finalPayload, continuation };
}

export function orderCreateSpotOperationRequestFixture(reverse = false) {
  const direct = directSpotOperationRequestFixture(reverse), { manifest, request: d, market } = direct;
  const terms: OrderTerms = { inputMaster: Address.parse(d.payRoot), pool: Address.parse(d.pool), sellIndex: reverse ? 1 : 0,
    recipient: Address.parse(d.owner), amountIn: 100n, minOutTotal: 5n, slices: 1, interval: 0,
    startAt: 1_900_000_000, expiresAt: 1_900_000_600, tipPerSlice: 20_000_000n, forwardGas: 400_000,
    walletGas: market.walletGasX, walletGram: BigInt(market.walletGramX), executor: null, budget: { ...market.walletBudgetX } };
  const termsCell = orderTermsToCell(terms);
  const request: CurrentOrderCreateSpotRequest = { kind: 'order-create', network: d.network, releaseId: d.releaseId,
    manifestHash: d.manifestHash, owner: d.owner, factory: manifest.contracts.SpotOrderFactory!.address,
    order: runtimeAddress(702), nonce: '0', pool: d.pool, inputRoot: d.payRoot, ...encodedTerms(termsCell) };
  return { request, manifest, market, terms, termsCell };
}

export function orderSettlementSpotOperationRequestFixture(funded = true) {
  const created = orderCreateSpotOperationRequestFixture(), owner = created.request.owner;
  const body = transferCell({ op: 0x0f8a7ea5, queryId: 43n, amount: created.terms.amountIn, destination: Address.parse(created.request.order),
    response: Address.parse(owner), custom: null, forward: 0n, payload: Cell.EMPTY });
  const request: CurrentOrderSettlementSpotRequest = { ...created.request, kind: 'order-settlement', funding: funded ? {
    sourceWallet: runtimeAddress(701), valueNano: '1000', ...encoded(body), lt: '10', hash: 'a'.repeat(64),
  } : null };
  return { ...created, request, body };
}

function main() {
  let rejected = 0;
  const bad = (value: unknown, manifest = runtimeManifestFixture(), status = 400) => {
    assert.throws(() => readSpotOperationRequest(value, manifest), error => error instanceof SpotEvidenceError
      && error.status === status && error.code === (status === 409 ? 'release_mismatch' : 'bad_request'));
    rejected++;
  };
  for (const reverse of [false, true]) {
    const f = routeSpotOperationRequestFixture(reverse), parsed = readSpotOperationRequest(f.request, f.manifest);
    assert('finalPayload' in parsed); assert.deepEqual(parsed.request, f.request); assert(parsed.finalPayload.equals(f.finalPayload));
    assert.equal(parsed.minimumRaw, '5'); assert.equal(parsed.finalMinimumRaw, '7'); assert.equal(parsed.amountRaw, '10');
    assert.equal(parsed.payToken.root, f.request.payRoot); assert.equal(parsed.receiveToken.root, f.request.receiveRoot);
    for (const key of Object.keys(f.request)) { const value = { ...f.request } as Record<string, unknown>; delete value[key]; bad(value, f.manifest); }
    for (const patch of [{ extra: 1 }, { pool2: f.request.pool }, { pool2: runtimeAddress(999) }, { payRoot: f.request.receiveRoot },
      { receiveRoot: parsed.intermediateToken.root }, { owner: f.request.coordinator }, { bodyHash: '0'.repeat(64) }, { bodyBoc: f.request.bodyBoc + '\n' },
      { dispatch: null }, { dispatch: { lt: '0', hash: 'a'.repeat(64) } }, { dispatch: { lt: '01', hash: 'a'.repeat(64) } },
      { dispatch: { lt: (1n << 64n).toString(), hash: 'a'.repeat(64) } }, { dispatch: { lt: '100', hash: 'A'.repeat(64) } },
      { dispatch: { ...f.request.dispatch, valueNano: '1000' } }]) bad({ ...f.request, ...patch }, f.manifest);
    for (const patch of [{ network: 'mainnet' }, { releaseId: 'other' }, { manifestHash: '0'.repeat(64) }, { coordinator: runtimeAddress(999) }])
      bad({ ...f.request, ...patch }, f.manifest, 409);
    const fromOuter = (payload: Cell) => ({ ...f.request, ...encoded(transferCell({ ...f.fields, payload })) });
    const fromFinal = (payload: Cell) => fromOuter(payloadCell({ recipient: Address.parse(f.request.coordinator), forward: 100n,
      user: beginCell().storeUint(0x52435433, 32).storeAddress(Address.parse(f.request.pool2)).storeRef(payload).endCell() }));
    for (const patch of [{ minimum: 0n }, { recipient: Address.parse(f.request.owner) }, { refundTo: Address.parse(f.request.coordinator) },
      { notify: true }, { forward: 0n }, { refundForward: 1n }, { user: null }])
      bad(fromOuter(payloadCell({ recipient: Address.parse(f.request.coordinator), forward: 100n, user: f.continuation, ...patch })), f.manifest);
    for (const patch of [{ minimum: 0n }, { deadline: 1_900_000_001 }, { recipient: Address.parse(f.request.coordinator) },
      { refundTo: Address.parse(f.request.pool) }, { notify: true }, { forward: 1n }, { refundForward: 1n }, { user: Cell.EMPTY }])
      bad(fromFinal(payloadCell(patch)), f.manifest);
    for (const continuation of [Cell.EMPTY, beginCell().storeUint(0x52435433, 32).storeAddress(Address.parse(f.request.pool)).storeRef(f.finalPayload).endCell(),
      beginCell().storeSlice(f.continuation.beginParse()).storeBit(false).endCell(), beginCell().storeSlice(f.continuation.beginParse()).storeRef(Cell.EMPTY).endCell()])
      bad(fromOuter(payloadCell({ recipient: Address.parse(f.request.coordinator), forward: 100n, user: continuation })), f.manifest);
    bad(fromFinal(beginCell().storeSlice(f.finalPayload.beginParse()).storeBit(false).endCell()), f.manifest);
    for (const patch of [{ amount: 0n }, { destination: Address.parse(f.request.pool2) }, { response: null }, { custom: Cell.EMPTY }, { forward: 0n }])
      bad({ ...f.request, ...encoded(transferCell({ ...f.fields, ...patch })) }, f.manifest);
  }
  for (const reverse of [false, true]) {
    const f = directSpotOperationRequestFixture(reverse), p = readSpotOperationRequest(f.request, f.manifest);
    assert('body' in p); assert.deepEqual(p.request, f.request); assert.notEqual(p.request, f.request);
    assert(p.body.equals(f.body)); assert(p.payload.equals(f.fields.payload)); assert.equal(p.market, f.market);
    assert.equal(p.payToken.root, f.request.payRoot); assert.equal(p.receiveToken.root, f.request.receiveRoot);
    assert.equal(p.queryId, '42'); assert.equal(p.amountRaw, '10'); assert.equal(p.minimumRaw, '5'); assert.equal(p.deadline, 1_900_000_000);
    for (const idx of [false, true]) for (const crc32 of [false, true])
      readSpotOperationRequest({ ...f.request, bodyBoc: f.body.toBoc({ idx, crc32 }).toString('base64') }, f.manifest);
    readSpotOperationRequest({ ...f.request, valueNano: ((1n << 120n) - 1n).toString() }, f.manifest);
    const maximumBody = transferCell({ ...f.fields, queryId: (1n << 64n) - 1n, amount: (1n << 120n) - 1n,
      payload: payloadCell({ minimum: (1n << 120n) - 1n, deadline: 0xffffffff }) });
    const maximum = readSpotOperationRequest({ ...f.request, ...encoded(maximumBody) }, f.manifest);
    assert('body' in maximum); assert.equal(maximum.queryId, ((1n << 64n) - 1n).toString());
    assert.equal(maximum.amountRaw, ((1n << 120n) - 1n).toString()); assert.equal(maximum.deadline, 0xffffffff);
    const multipleRoots = Buffer.from('b5ee9c72010102020004000100000000', 'hex');
    assert.equal(Cell.fromBoc(multipleRoots).length, 2);
    bad({ ...f.request, bodyBoc: multipleRoots.toString('base64'), bodyHash: Cell.EMPTY.hash().toString('hex') }, f.manifest);
    for (const key of Object.keys(f.request)) { const missing = { ...f.request } as Record<string, unknown>; delete missing[key]; bad(missing); }
    for (const value of [null, [], {}, { ...f.request, extra: true }, { ...f.request, kind: 'swap' },
      { ...f.request, owner: Address.parse(f.request.owner).toString() }, { ...f.request, owner: `-1:${'7'.repeat(64)}` },
      { ...f.request, sourceWallet: `0:${'A'.repeat(64)}` }, { ...f.request, sourceWallet: 'not-an-address' },
      { ...f.request, payRoot: f.request.receiveRoot }, { ...f.request, receiveRoot: f.request.payRoot },
      { ...f.request, payRoot: f.manifest.tokens.find(t => t.symbol === 'KUSD')!.root },
      { ...f.request, pool: f.manifest.spotMarkets[1].pool }, { ...f.request, pool: runtimeAddress(900) },
      { ...f.request, valueNano: '0' }, { ...f.request, valueNano: '-1' }, { ...f.request, valueNano: '01' },
      { ...f.request, valueNano: 1000 }, { ...f.request, valueNano: '1e3' }, { ...f.request, valueNano: (1n << 120n).toString() },
      { ...f.request, bodyHash: '0'.repeat(64) }, { ...f.request, bodyHash: f.request.bodyHash.toUpperCase() },
      { ...f.request, bodyBoc: f.request.bodyBoc + '\n' }, { ...f.request, bodyBoc: '' },
      { ...f.request, bodyBoc: Buffer.concat([f.body.toBoc({ crc32: false }), Buffer.from([0])]).toString('base64') },
      { ...f.request, bodyBoc: 'A'.repeat(128 * 1024 + 1) }]) bad(value, f.manifest);
    for (const changed of [{ network: 'ton:testnet' }, { network: 'localnet' }, { releaseId: 'other' }, { manifestHash: '0'.repeat(64) }])
      bad({ ...f.request, ...changed, bodyBoc: 'not-a-boc' }, f.manifest, 409);
    for (const changed of [{ op: 0x7362d09c }, { amount: 0n }, { destination: Address.parse(f.request.owner) },
      { response: null }, { response: Address.parse(runtimeAddress(999)) }, { custom: Cell.EMPTY }, { forward: 0n }])
      bad({ ...f.request, ...encoded(transferCell({ ...f.fields, ...changed })) }, f.manifest);
    for (const changed of [{ op: 0x53575032 }, { minimum: 0n }, { deadline: 0 },
      { recipient: Address.parse(runtimeAddress(999)) }, { refundTo: Address.parse(runtimeAddress(999)) },
      { recipient: new Address(-1, Buffer.alloc(32, 7)) }, { notify: true }, { forward: 1n }, { refundForward: 1n }, { user: Cell.EMPTY }])
      bad({ ...f.request, ...encoded(transferCell({ ...f.fields, payload: payloadCell(changed) })) }, f.manifest);
    for (const payload of [beginCell().storeSlice(f.fields.payload.beginParse()).storeBit(false).endCell(),
      beginCell().storeSlice(f.fields.payload.beginParse()).storeRef(Cell.EMPTY).endCell()])
      bad({ ...f.request, ...encoded(transferCell({ ...f.fields, payload })) }, f.manifest);
    for (const body of [beginCell().storeSlice(f.body.beginParse()).storeBit(false).endCell(),
      beginCell().storeSlice(f.body.beginParse()).storeRef(Cell.EMPTY).endCell()]) bad({ ...f.request, ...encoded(body) }, f.manifest);
    const exotic = new Cell({ exotic: true, bits: beginCell().storeUint(2, 8).storeBuffer(Buffer.alloc(32, 1)).endCell().bits });
    bad({ ...f.request, ...encoded(exotic) }, f.manifest);
    bad({ ...f.request, ...encoded(transferCell({ ...f.fields, payload: exotic })) }, f.manifest);
    // The full scalar SWP3 payload cannot fit inline after two standard transfer
    // addresses. The Either-left decoder must still reject a truncated payload.
    const inline = beginCell().storeUint(f.fields.op, 32).storeUint(42, 64).storeCoins(10n)
      .storeAddress(f.fields.destination).storeAddress(f.fields.response).storeMaybeRef(null).storeCoins(100n)
      .storeBit(false).storeUint(0x53575033, 32).storeCoins(5n).storeUint(1_900_000_000, 32).endCell();
    bad({ ...f.request, ...encoded(inline) }, f.manifest);
  }

  for (const reverse of [false, true]) {
    const f = orderCreateSpotOperationRequestFixture(reverse), p = readSpotOperationRequest(f.request, f.manifest);
    assert('terms' in p); assert.deepEqual(p.request, f.request); assert(p.termsCell.equals(f.termsCell));
    assert.deepEqual(plainTerms(p.terms), plainTerms(f.terms)); assert.equal(p.inputToken.root, f.request.inputRoot); assert.equal(p.market, f.market);
    readSpotOperationRequest({ ...f.request, nonce: ((1n << 64n) - 1n).toString() }, f.manifest);
    const twap = orderTermsToCell({ ...f.terms, slices: 3, interval: 120 });
    readSpotOperationRequest({ ...f.request, ...encodedTerms(twap) }, f.manifest);
    for (const key of Object.keys(f.request)) { const missing = { ...f.request } as Record<string, unknown>; delete missing[key]; bad(missing); }
    for (const value of [{ ...f.request, extra: 1 }, { ...f.request, nonce: '-1' }, { ...f.request, nonce: '00' },
      { ...f.request, nonce: 0 }, { ...f.request, nonce: (1n << 64n).toString() },
      { ...f.request, order: Address.parse(f.request.order).toString() }, { ...f.request, owner: runtimeAddress(901) },
      { ...f.request, pool: f.manifest.spotMarkets[1].pool }, { ...f.request, inputRoot: runtimeAddress(902) },
      { ...f.request, termsHash: '0'.repeat(64) }, { ...f.request, termsBoc: f.request.termsBoc + '\n' }]) bad(value, f.manifest);
    for (const changed of [{ network: 'mainnet' }, { releaseId: 'other' }, { manifestHash: '0'.repeat(64) }, { factory: runtimeAddress(903) }])
      bad({ ...f.request, ...changed }, f.manifest, 409);
    for (const changes of [{ pool: Address.parse(f.manifest.spotMarkets[1].pool) }, { inputMaster: Address.parse(runtimeAddress(904)) },
      { recipient: Address.parse(runtimeAddress(905)) }, { sellIndex: (reverse ? 0 : 1) as 0 | 1 }])
      bad({ ...f.request, ...encodedTerms(orderTermsToCell({ ...f.terms, ...changes })) }, f.manifest);
    const trailing = beginCell().storeSlice(f.termsCell.beginParse()).storeBit(false).endCell();
    bad({ ...f.request, ...encodedTerms(trailing) }, f.manifest);
    const root = f.termsCell.beginParse(); root.loadAddress(); root.loadAddress(); root.loadBit(); root.loadAddress();
    const nums = root.loadRef(), malformedNumbers = beginCell().storeSlice(nums.beginParse()).storeBit(false).endCell();
    const malformed = beginCell().storeAddress(f.terms.inputMaster).storeAddress(f.terms.pool).storeBit(reverse)
      .storeAddress(f.terms.recipient).storeRef(malformedNumbers).endCell();
    bad({ ...f.request, ...encodedTerms(malformed) }, f.manifest);
    const n = nums.beginParse();
    n.loadCoins(); n.loadCoins(); n.loadUint(8); n.loadUint(32); n.loadUint(32); n.loadUint(32);
    n.loadCoins(); n.loadUint(32); n.loadUint(32); n.loadCoins(); n.loadMaybeAddress();
    const budget = n.loadRef(), malformedBudget = beginCell().storeSlice(budget.beginParse()).storeRef(Cell.EMPTY).endCell();
    const rebuiltNums = beginCell().storeBits(nums.bits).storeRef(malformedBudget).endCell();
    const malformedChild = beginCell().storeBits(f.termsCell.bits).storeRef(rebuiltNums).endCell();
    bad({ ...f.request, ...encodedTerms(malformedChild) }, f.manifest);
  }
  for (const funded of [false, true]) {
    const f = orderSettlementSpotOperationRequestFixture(funded), parsed = readSpotOperationRequest(f.request, f.manifest);
    assert('fundingBody' in parsed); assert.deepEqual(parsed.request, f.request);
    assert.equal(parsed.fundingBody?.hash().toString('hex') ?? null, f.request.funding?.bodyHash ?? null);
    bad({ ...f.request, funding: undefined }, f.manifest); bad({ ...f.request, extra: 1 }, f.manifest);
    if (!f.request.funding) continue;
    for (const changes of [{ sourceWallet: 'bad' }, { valueNano: '0' }, { lt: '0' }, { lt: '01' }, { lt: (1n << 64n).toString() },
      { hash: 'A'.repeat(64) }, { hash: 'a'.repeat(63) }, { bodyHash: '0'.repeat(64) }, { extra: 1 }])
      bad({ ...f.request, funding: { ...f.request.funding, ...changes } }, f.manifest);
    for (const changes of [{ amount: f.terms.amountIn + 1n }, { forward: 1n }, { payload: beginCell().storeBit(false).endCell() },
      { destination: Address.parse(f.request.pool) }, { response: null }, { custom: Cell.EMPTY }]) {
      const body = transferCell({ op: 0x0f8a7ea5, queryId: 43n, amount: f.terms.amountIn, destination: Address.parse(f.request.order),
        response: Address.parse(f.request.owner), custom: null, forward: 0n, payload: Cell.EMPTY, ...changes });
      bad({ ...f.request, funding: { ...f.request.funding, ...encoded(body) } }, f.manifest);
    }
  }
  console.log(`Current Spot direct/route/order-create/order-settlement parser passed both market directions, original wire binding, strict release/terms checks and ${rejected} invalid requests.`);
}
if (require.main === module) main();
