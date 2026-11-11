import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import Fastify from 'fastify';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
import { readPerpsOperationRequest, type CurrentPerpsEvidenceRequest } from '../runtime/perpsOperationEvidence';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
const ops = { open: 0x50584f50, increase: 0x50584d44, addMargin: 0x5058414d, removeMargin: 0x5058524d, close: 0x5058434c, funding: 0x50584643 };
export function perpsRequestFixture(kind: keyof typeof ops, funded = ['open','addMargin'].includes(kind)) {
  const manifest = runtimeManifestFixture(), owner = runtimeAddress(751), engine = manifest.contracts.PerpsEngine!.address, marketId = manifest.perpsMarkets[0].marketId;
  const b = beginCell().storeUint(ops[kind], 32).storeUint(7, 64).storeUint(marketId, 32);
  if (kind !== 'open') b.storeUint(9, 64).storeUint(1800000300, 32);
  if (kind === 'open' || kind === 'increase' || kind === 'close') b.storeInt(kind === 'close' ? 0 : 1000, 128).storeCoins(1234);
  if (kind === 'open') b.storeUint(10000, 32).storeUint(1800000300, 32);
  if (kind === 'removeMargin') b.storeCoins(100);
  let body = b.endCell();
  if (funded) body = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(7, 64).storeCoins(1000).storeAddress(Address.parse(engine)).storeAddress(Address.parse(owner))
    .storeMaybeRef(null).storeCoins(100000000).storeBit(true).storeRef(body).endCell();
  const request: CurrentPerpsEvidenceRequest = { network: manifest.network.slice(4), releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    owner, engine, riskVault: manifest.contracts.RiskVault!.address, kind, marketId, queryId: '7', gen: kind === 'open' ? null : '9', depositRaw: funded ? '1000' : '0',
    sourceWallet: funded ? runtimeAddress(752) : null, bodyBoc: body.toBoc().toString('base64'), bodyHash: body.hash().toString('hex'), valueNano: '1000000000', createdAt: 1800000000000,
    dispatch: { lt: '1', hash: 'a'.repeat(64), valueNano: '1000000000' } };
  return { manifest, request };
}
async function main() {
  let cases = 0;
  for (const kind of Object.keys(ops) as Array<keyof typeof ops>) {
    const { manifest, request } = perpsRequestFixture(kind); assert.deepEqual(readPerpsOperationRequest(request, manifest).request, request); cases++;
    for (const change of [{ extra: true }, { queryId: '8' }, { marketId: 0 }, { gen: kind === 'open' ? '1' : null }, { depositRaw: '1' }, { kind: 'old-open' },
      { createdAt: 0 }, { dispatch: { ...request.dispatch, valueNano: '1' } }, { bodyHash: 'f'.repeat(64) }, { bodyBoc: request.bodyBoc + '\n' }]) {
      assert.throws(() => readPerpsOperationRequest({ ...request, ...change }, manifest), ProductEvidenceError); cases++;
    }
    const body = Cell.fromBase64(request.bodyBoc), trailing = beginCell().storeSlice(body.beginParse()).storeBit(false).endCell();
    assert.throws(() => readPerpsOperationRequest({ ...request, bodyBoc: trailing.toBoc().toString('base64'), bodyHash: trailing.hash().toString('hex') }, manifest)); cases++;
  }
  const fundedIncrease = perpsRequestFixture('increase', true); readPerpsOperationRequest(fundedIncrease.request, fundedIncrease.manifest);
  const noOpen = perpsRequestFixture('open', false); assert.throws(() => readPerpsOperationRequest(noOpen.request, noOpen.manifest));
  const badClose = perpsRequestFixture('close', true); assert.throws(() => readPerpsOperationRequest(badClose.request, badClose.manifest));
  const { manifest, request } = perpsRequestFixture('open'), bundle = buildRuntimeManifestBundle(manifest), app = Fastify(); let reads = 0, unavailable = false;
  const common = { releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, asOf: { masterchainSeqno: 1, unixTime: 1800000000, blockRootHash: '1'.repeat(64) },
    request: { kind: request.kind, owner: request.owner, bodyHash: request.bodyHash }, coverage: { complete: false, gaps: [{ code: 'original_unavailable', account: request.engine }] } };
  const read = (signal?: AbortSignal) => { assert(signal); reads++; if (unavailable) throw new ProductEvidenceError(503, 'upstream_unavailable'); };
  registerRoutes(app, { network: 'testnet' }, {  } as IndexerService,
    undefined, undefined, undefined, undefined, bundle.contracts, bundle.metadata, { source: {} as any, orders: { page: async () => { throw Error(); },
      perpsOperationEvidence: async (_p, signal) => { read(signal); return { schema: 'tonswap-perps-operation-evidence-v1', ...common, transactions: [] }; },
      perpsWalletClaimEvidence: async (_p, signal) => { read(signal); return { schema: 'tonswap-perps-wallet-claim-evidence-v1', ...common, wallets: [] }; }
    } });
  try {
    for (const [path, endpoint] of [['operation-evidence','perpsOperationEvidence'],['wallet-claim-evidence','perpsWalletClaimEvidence']]) {
      const url = '/api/indexer/v1/perps/' + path;
      for (let i = 0; i < 2; i++) { const r = await app.inject({ method: 'POST', url, payload: request }); assert.equal(r.statusCode, 200, r.body);
        assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-tonswap-release'], manifest.manifestHash); }
      assert.equal((await app.inject({ method: 'POST', url: url + '?extra=1', payload: request })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url, payload: { ...request, gen: '1' } })).statusCode, 400);
      assert.equal((await app.inject({ method: 'POST', url, payload: request, headers: { 'x-tonswap-release': 'f'.repeat(64) } })).statusCode, 409);
      assert.equal((await app.inject({ method: 'POST', url, payload: { ...request, bodyBoc: 'a'.repeat(192 * 1024) } })).statusCode, 413);
      unavailable = true; assert.equal((await app.inject({ method: 'POST', url, payload: request })).statusCode, 503); unavailable = false;
      assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints[endpoint], url); assert((buildOpenApi({ network: 'testnet' } as any) as any).paths[url]);
    }
    assert.equal(reads, 6);
  } finally { await app.close(); }
  console.log(`Current Perps ${cases + 3} native request vectors and both API release/cache/size/error fences passed; native collector qualification remains separate.`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
