import assert from 'node:assert/strict';
import { Address, beginCell,Cell } from '@ton/core';
import { currentT3BasketFixture } from './support/currentT3BasketFixture';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { readT3OperationRequest, T3EvidenceError, type CurrentT3Request } from '../runtime/t3OperationRequest';

export function operationRequestFixture(kind: 'mint' | 'pair' | 'swap' | 'redeem' = 'mint') {
  const manifest = runtimeManifestFixture(), owner = `0:${'7'.repeat(64)}`, wallet = `0:${'8'.repeat(64)}`, hub = manifest.contracts.T3Hub!.address;
  const intent = beginCell().storeUint(({mint:0x54334d4e,pair:0x5433504d,swap:0x54335357,redeem:0x54335244})[kind], 32);
  if (kind === 'redeem') intent.storeBit(true).storeUint(1, 2).storeBit(false);
  if (kind === 'swap') intent.storeUint(1, 2).storeBit(false);
  const terms = intent.storeCoins(5n).storeAddress(Address.parse(owner)).endCell();
  const body = kind !== 'redeem' ? beginCell().storeUint(0x0f8a7ea5, 32).storeUint(42, 64).storeCoins(10n)
    .storeAddress(Address.parse(hub)).storeAddress(Address.parse(owner)).storeMaybeRef(null).storeCoins(100n).storeBit(true).storeRef(terms).endCell()
    : beginCell().storeUint(0x595f07bc, 32).storeUint(42, 64).storeCoins(10n).storeAddress(Address.parse(owner)).storeMaybeRef(terms).endCell();
  const common = { network: 'testnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, owner, hub, queryId: '42', amountRaw: '10',
    recipient: owner, minimumRaw: '5', bodyBoc: body.toBoc().toString('base64'), bodyHash: body.hash().toString('hex') };
  const deposit={ ...common, collateralRoot: manifest.tokens.find(t => t.symbol === 'USDT')!.root,input:0 as const,sourceWallet:wallet,valueNano:'1000',submittedAt:Date.now()};
  const counterpartBody=beginCell().storeUint(0x0f8a7ea5,32).storeUint(43,64).storeCoins(11n).storeAddress(Address.parse(hub)).storeAddress(Address.parse(owner)).storeMaybeRef(null).storeCoins(100n).storeBit(true).storeRef(terms).endCell();
  const request:CurrentT3Request=kind==='redeem'?{...common,kind,wallet,single:true,outputToken:1,createdAt:Date.now()}:kind==='mint'?{...deposit,kind}:kind==='swap'?{...deposit,kind,outputToken:1,dispatch:null}:{...deposit,kind,dispatch:null,counterpart:{queryId:'43',amountRaw:'11',bodyBoc:counterpartBody.toBoc().toString('base64'),bodyHash:counterpartBody.hash().toString('hex'),collateralRoot:manifest.tokens.find(t=>t.symbol==='USDC')!.root,input:1,sourceWallet:`0:${'9'.repeat(64)}`,valueNano:'1000',dispatch:null}};
  return { request, manifest, body, intent: terms };
}
function main() {
  for (const kind of ['mint', 'pair', 'swap', 'redeem'] as const) {
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
  for(const {capture:c}of currentT3BasketFixture().cases()){
    const p=c.request;assert.deepEqual(readT3OperationRequest(p,c.manifest).request,p);
    const changes=[{...p,dispatch:undefined},{...p,dispatch:{lt:'0',hash:'1'.repeat(64)}},{...p,dispatch:{lt:'1',hash:'0'.repeat(64)}},{...p,dispatch:{...p.dispatch,extra:true}},{...p,minimumRaw:'0'},{...p,input:p.input===0?1:0}];
    if(p.kind==='pair')changes.push({...p,counterpart:{...p.counterpart,extra:true}},{...p,counterpart:{...p.counterpart,input:p.input}},{...p,counterpart:{...p.counterpart,amountRaw:'1'}},{...p,counterpart:{...p.counterpart,bodyHash:p.bodyHash}},{...p,counterpart:{...p.counterpart,valueNano:'0'}});
    else changes.push({...p,outputToken:p.input});
    for(const changed of changes)assert.throws(()=>readT3OperationRequest(changed,c.manifest),T3EvidenceError);
    const unresolved={...p,dispatch:null,...(p.kind==='pair'?{counterpart:{...p.counterpart,dispatch:null}}:{})};assert.deepEqual(readT3OperationRequest(unresolved,c.manifest).request,unresolved);
  }
  // Raw 120-bit amounts have up to 37 decimal digits; parser bounds are integer
  // protocol bounds, independent of whether a live account has enough assets.
  const large=(1n<<120n)-1n,m=mint.request,largeBody=beginCell().storeUint(0x0f8a7ea5,32).storeUint(42,64).storeCoins(large).storeAddress(Address.parse(m.hub)).storeAddress(Address.parse(m.owner)).storeMaybeRef(null).storeCoins(100n).storeBit(true).storeRef(mint.intent).endCell();
  assert.equal(readT3OperationRequest({...m,amountRaw:String(large),bodyBoc:largeBody.toBoc().toString('base64'),bodyHash:largeBody.hash().toString('hex')},mint.manifest).request.amountRaw,String(large));
  console.log('Exact current T3 mint/pair/swap/redeem request fields, original body binding, release identity and malformed terms passed.');
}
if (require.main === module) main();
