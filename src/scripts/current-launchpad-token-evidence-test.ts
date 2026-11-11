import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, beginCell, Cell, contractAddress, storeStateInit } from '@ton/core';
import Fastify from 'fastify';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { readLaunchpadTokenRequest } from '../runtime/launchpadTokenEvidence';

const boc = (c: Cell) => c.toBoc().toString('base64'), hash = (c: Cell) => c.hash().toString('hex');
export function creatorTokenParserFixture() {
  const manifest = runtimeManifestFixture(), owner = Address.parse(runtimeAddress(941));
  const code = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/current-capture-build/artifacts/JettonV21Minter.boc')))[0];
  assert.equal(hash(code), manifest.templates.JettonV21Minter);
  const init = { code, data: beginCell().storeCoins(0).storeAddress(owner).storeAddress(null).storeRef(beginCell().storeUint(0, 8).storeBit(false).endCell()).endCell() };
  const stateInit = beginCell().store(storeStateInit(init)).endCell(), root = contractAddress(0, init);
  const walletCode = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/current-capture-build/artifacts/JettonV21Wallet.boc')))[0];
  const walletHash = beginCell().store(storeStateInit({ splitDepth: 8, code: walletCode, data: beginCell().storeCoins(0).storeAddress(owner).storeAddress(root).endCell() })).endCell().hash();
  walletHash[0] = owner.hash[0];
  const transfer = beginCell().storeUint(0x178d4519, 32).storeUint(7, 64).storeCoins(1234).storeAddress(null).storeAddress(owner).storeCoins(0).storeBit(false).endCell();
  const body = beginCell().storeUint(0x642b7d07, 32).storeUint(7, 64).storeAddress(owner).storeCoins(100000000).storeRef(transfer).endCell();
  return { manifest, request: { network: manifest.network.slice(4), releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    owner: owner.toRawString(), root: root.toRawString(), wallet: new Address(0, walletHash).toRawString(), masterCodeHash: manifest.templates.JettonV21Minter,
    walletCodeHash: manifest.templates.JettonV21Wallet, amountRaw: '1234', queryId: '7', bodyBoc: boc(body), bodyHash: hash(body), stateInitBoc: boc(stateInit),
    stateInitHash: hash(stateInit), valueNano: '1000000000', createdAt: 1800000000000, dispatch: { lt: '1', hash: 'a'.repeat(64), valueNano: '1000000000' } } };
}
async function main() {
  const { manifest, request } = creatorTokenParserFixture(); assert.deepEqual(readLaunchpadTokenRequest(request, manifest).request, request);
  for (const change of [{ extra: true }, { amountRaw: '1235' }, { amountRaw: '0' }, { queryId: '8' }, { root: runtimeAddress(942) }, { owner: runtimeAddress(943) },
    { createdAt: 0 }, { dispatch: { ...request.dispatch, valueNano: '1' } }, { dispatch: { ...request.dispatch, extra: true } }, { stateInitHash: '0'.repeat(64) },
    { bodyHash: '0'.repeat(64) }, { bodyBoc: request.bodyBoc + '\n' }, { wallet: '0:' + '0'.repeat(64) }])
    assert.throws(() => readLaunchpadTokenRequest({ ...request, ...change }, manifest), ProductEvidenceError);
  for (const key of ['network','releaseId','manifestHash','masterCodeHash','walletCodeHash'])
    assert.throws(() => readLaunchpadTokenRequest({ ...request, [key]: 'wrong' }, manifest), (error: any) => error.status === 409);
  const bundle = buildRuntimeManifestBundle(manifest), app = Fastify(), url = '/api/indexer/v1/launchpad/token-evidence'; let reads = 0, unavailable = false;
  registerRoutes(app, { network: 'testnet' }, {  } as IndexerService,
    undefined, undefined, undefined, undefined, bundle.contracts, bundle.metadata, { source: {} as any, orders: {
      page: async () => { throw Error(); }, launchpadTokenEvidence: async (parsed, signal) => {
        assert(signal); reads++; if (unavailable) throw new ProductEvidenceError(503, 'upstream_unavailable');
        return { schema: 'tonswap-launchpad-token-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
          asOf: { masterchainSeqno: 1, unixTime: 1800000000, blockRootHash: '1'.repeat(64) }, request: { owner: parsed.request.owner, bodyHash: parsed.request.bodyHash },
          coverage: { complete: false, gaps: [{ code: 'original_unavailable', account: parsed.request.root }] }, transactions: [] };
      }
    } });
  try {
    for (let i = 0; i < 2; i++) { const r = await app.inject({ method: 'POST', url, payload: request }); assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-tonswap-release'], manifest.manifestHash); }
    assert.equal((await app.inject({ method: 'POST', url: url + '?other=1', payload: request })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...request, extra: true } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, payload: request, headers: { 'x-tonswap-release': 'f'.repeat(64) } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url, payload: { ...request, stateInitBoc: 'a'.repeat(192 * 1024) } })).statusCode, 413);
    unavailable = true; assert.equal((await app.inject({ method: 'POST', url, payload: request })).statusCode, 503); assert.equal(reads, 3);
    assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints.launchpadTokenEvidence, url);
    assert((buildOpenApi({ network: 'testnet' } as any) as any).paths[url]);
  } finally { await app.close(); }
  console.log('Creator-token exact StateInit/code-pair/mint parser and API release/cache/size/error fences passed; native delivery qualification remains separate.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
