import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { buildDocsHtml } from '../api/docsHtml';
import { buildOpenApi } from '../api/openapi';
import { publicIndexerPath, publicIndexerUrl } from '../api/publicMount';
import type { IndexerService } from '../indexerService';
import { productionSmokeBaseUrl } from './production-smoke';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

const r1 = 'https://test.tonswap.org/api/indexer';
const r2 = 'https://test.tonswap.org/api/indexer-r2';
const metadataFor = (indexer: string) => {
  const runtime = runtimeManifestFixture({ services: { ...runtimeManifestFixture().services, indexer } });
  return { runtime, releaseId: runtime.releaseId, manifestHash: runtime.manifestHash, registryHash: '' };
};
const service = {
  getAdmissionStatus() { return { configured: false, ready: false }; },
  getHealth() { return { lastMasterSeqno: 42 }; },
} as IndexerService;

async function main() {
  assert.equal(publicIndexerPath(r1, '/api/indexer/v1/health'), '/api/indexer/v1/health');
  assert.equal(publicIndexerPath(r2, '/api/indexer/v1/health'), '/api/indexer-r2/v1/health');
  assert.equal(publicIndexerPath(`${r2}/`, '/api/indexer/v1/accounts/{addr}/txs'), '/api/indexer-r2/v1/accounts/{addr}/txs');
  assert.equal(publicIndexerPath('https://test.tonswap.org/api/indexer/r2', '/api/indexer/v1/health'), '/api/indexer/r2/v1/health');
  assert.equal(publicIndexerPath('https://test.tonswap.org/', '/api/indexer/v1/health'), '/v1/health');
  assert.equal(publicIndexerPath(undefined, '/api/indexer/v1/health'), '/api/indexer/v1/health');
  assert.throws(() => publicIndexerPath(r2, '/api/indexer-r2/v1/health'), /registered indexer route/);
  for (const invalid of ['https://user:secret@test.tonswap.org/api/indexer-r2', `${r2}?other=1`, `${r2}#other`, 'file:///api/indexer-r2']) {
    assert.throws(() => publicIndexerPath(invalid, '/api/indexer/v1/health'), /HTTP\(S\) URL/);
  }
  const query = new URLSearchParams({ market_address: `0:${'a'.repeat(64)}`, asset_symbol: 'T3/USDT & X', limit: '2' });
  const url = publicIndexerUrl(r2, '/api/indexer/v1/markets/spot%3AT3-USDT/candles', query);
  assert.equal(url.origin, 'https://test.tonswap.org');
  assert.equal(url.pathname, '/api/indexer-r2/v1/markets/spot%3AT3-USDT/candles');
  assert.deepEqual([...url.searchParams], [...query]);
  for (const indexer of [r1, r2]) {
    const expectedMount = new URL(indexer).pathname;
    assert.equal(productionSmokeBaseUrl(undefined, indexer).toString(), indexer, 'An omitted target must use the native authority, not an unrelated default host');
    for (const target of ['http://127.0.0.1:28788', `http://127.0.0.1:28788${expectedMount}`, `http://127.0.0.1:28788${expectedMount}/`]) {
      const base = productionSmokeBaseUrl(target, indexer);
      assert.equal(base.origin, 'http://127.0.0.1:28788');
      assert.equal(base.pathname, expectedMount);
      assert.equal(publicIndexerUrl(base.toString(), '/api/indexer/v1/health').pathname, `${expectedMount}/v1/health`);
    }
  }
  assert.throws(() => productionSmokeBaseUrl(r1, r2), /target path differs/);
  assert.throws(() => productionSmokeBaseUrl(`${r2}/api/indexer`, r2), /target path differs/);

  const current = metadataFor(r1);
  const spec = buildOpenApi({ network: 'testnet' }, current);
  const repeated = buildOpenApi({ network: 'testnet' }, current);
  assert.deepEqual(spec, repeated, 'Repeated generation cannot mutate shared path definitions or append duplicate headers');
  assert.deepEqual(spec.servers, [{ url: '/' }]);
  for (const [path, route] of Object.entries(spec.paths)) {
    assert(path.startsWith('/api/indexer/v1/'));
    const concrete = path.replace(/\{[^}]+\}/g, encodeURIComponent('example:value'));
    const composed = new URL(concrete, new URL(spec.servers[0].url, r1));
    assert.equal(composed.origin, 'https://test.tonswap.org');
    assert.equal(composed.pathname, concrete);
    assert.equal(composed.pathname.split('/api/indexer').length - 1, 1);
    for (const operation of Object.values(route) as any[]) {
      assert.equal(operation.parameters.filter((p: any) => p.name === 'x-tonswap-release').length, 1);
    }
  }
  const refs = JSON.stringify(spec.paths).matchAll(/"\$ref":"(#[^"]+)"/g);
  let refCount = 0;
  for (const [, ref] of refs) {
    const value = ref.slice(2).split('/').reduce<unknown>((node, part) =>
      (node as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    assert.notEqual(value, undefined, `Unresolved reference ${ref}`); refCount++;
  }
  assert(refCount > 20);
  const docs = buildDocsHtml('mount-test-nonce', r1);
  assert(docs.includes('href="/api/indexer/v1/openapi.json"'));
  assert(docs.includes('value="/api/indexer/v1/governance/{voting}/snapshot"'));
  for (const retired of ['/cover/', '/vol-index/', '/pools/{pool}/farms']) assert(!docs.includes(retired));
  assert(docs.includes('<script nonce="mount-test-nonce">'));
  for (const indexer of [r1, r2, `${r1}/`]) {
    const app = Fastify();
    try {
      registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, {}, metadataFor(indexer));
      const response = await app.inject('/api/indexer/v1/service-info'); assert.equal(response.statusCode, 200);
      const info = response.json();
      if (indexer === r1) {
        assert.equal(info.publicBaseUrl, r1); assert.equal(info.serviceId, 'test.tonswap.org/api/indexer');
        assert.equal(info.endpoints.openapi, '/api/indexer/v1/openapi.json');
        assert.equal(info.endpoints.balances, '/api/indexer/v1/accounts/{addr}/balances');
        assert.equal(info.endpoints.readFresh, '/api/indexer/v1/readFresh');
        assert.equal(response.headers['x-tonswap-release'], current.manifestHash);
      } else {
        assert.equal(info.publicBaseUrl, null); assert.equal(info.serviceId, null);
        assert.deepEqual(info.release, { releaseId: null, manifestHash: null });
        assert.equal(info.endpoints.readFresh, undefined, 'An invalid public mount cannot advertise current reads');
        assert.equal(response.headers['x-tonswap-release'], undefined);
      }
      const openapi = (await app.inject('/api/indexer/v1/openapi.json')).json();
      assert(Object.keys(openapi.paths).every(path => path.startsWith('/api/indexer/v1/')));
      assert.equal((await app.inject('/api/indexer-r2/v1/service-info')).statusCode, 404, 'No old mount alias is registered');
    } finally { await app.close(); }
  }
  process.stdout.write('Stable current public mount, exact release binding, component references and repeatable OpenAPI passed.\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
