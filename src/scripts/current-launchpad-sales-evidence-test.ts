import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { IndexerService } from '../indexerService';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { readLaunchpadSalesRequest } from '../runtime/launchpadSalesEvidence';

async function main() {
  const manifest = runtimeManifestFixture(), factory = manifest.contracts.SaleFactory!.address;
  const request = { factory, limit: '50' };
  assert.deepEqual(readLaunchpadSalesRequest(request, manifest), { factory, limit: 50, cursor: null });
  assert.deepEqual(readLaunchpadSalesRequest({ ...request, cursorLt: '1', cursorHash: '1'.repeat(64) }, manifest).cursor, { lt: '1', hash: '1'.repeat(64) });
  for (const change of [{ extra: true }, { limit: 1 }, { limit: '0' }, { limit: '51' }, { limit: '01' }, { cursorLt: '1' }, { cursorHash: '1'.repeat(64) },
    { cursorLt: '0', cursorHash: '1'.repeat(64) }, { cursorLt: '18446744073709551616', cursorHash: '1'.repeat(64) }, { factory: [factory] }])
    assert.throws(() => readLaunchpadSalesRequest({ ...request, ...change }, manifest), ProductEvidenceError);
  assert.throws(() => readLaunchpadSalesRequest({ ...request, factory: runtimeAddress(999) }, manifest), (e: any) => e.code === 'release_mismatch');
  const bundle = buildRuntimeManifestBundle(manifest), app = Fastify(), url = '/api/indexer/v1/launchpad/sales'; let reads = 0, unavailable = false;
  registerRoutes(app, { network: 'testnet' }, {  } as IndexerService,
    undefined, undefined, undefined, undefined, bundle.contracts, bundle.metadata, { source: {} as any, orders: {
      page: async () => { throw Error(); }, launchpadSales: async (parsed, signal) => {
        assert(signal); reads++; if (unavailable) throw new ProductEvidenceError(503, 'upstream_unavailable');
        return { schema: 'tonswap-launchpad-sales-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
          asOf: { masterchainSeqno: 1, unixTime: 1800000000, blockRootHash: '1'.repeat(64) }, request: parsed,
          coverage: { complete: false, gaps: [{ code: 'original_page_unavailable', account: factory }] }, transactions: [], nextCursor: { lt: '1', hash: '1'.repeat(64) } };
      }
    } });
  try {
    const query = '?factory=' + factory + '&limit=50';
    for (let i = 0; i < 2; i++) { const r = await app.inject(url + query); assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-tonswap-release'], manifest.manifestHash);
      assert(r.json().nextCursor, 'an unavailable page cannot claim history end'); }
    for (const suffix of ['&extra=1', '&cursorLt=1', '&limit=2']) assert.equal((await app.inject(url + query + suffix)).statusCode, 400);
    assert.equal((await app.inject({ url: url + query, headers: { 'x-tonswap-release': 'f'.repeat(64) } })).statusCode, 409);
    unavailable = true; assert.equal((await app.inject(url + query)).statusCode, 503); assert.equal(reads, 3);
    assert.equal((await app.inject('/api/indexer/v1/service-info')).json().endpoints.launchpadSales, url);
    assert((buildOpenApi({ network: 'testnet' } as any) as any).paths[url]);
  } finally { await app.close(); }
  console.log('Launchpad sales strict cursor/page parser, API release/cache/error fences passed. Native page continuity qualification remains separate.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
