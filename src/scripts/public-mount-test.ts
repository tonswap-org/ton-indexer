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

  const r1Spec = buildOpenApi({ network: 'testnet' }, metadataFor(r1));
  const r2Spec = buildOpenApi({ network: 'testnet' }, metadataFor(r2));
  const r2Paths = r2Spec.paths as Record<string, unknown>;
  assert.deepEqual(r1Spec.servers, [{ url: '/' }]);
  assert.deepEqual(r2Spec.servers, [{ url: '/' }]);
  assert.equal(Object.keys(r1Spec.paths).length, Object.keys(r2Paths).length);
  for (const [path, operation] of Object.entries(r1Spec.paths)) {
    const expected = path.replace(/^\/api\/indexer\//, '/api/indexer-r2/');
    assert.notEqual(expected, path);
    assert.deepEqual(r2Paths[expected], operation, `Moving ${path} must preserve its method/schema/security references`);
    assert.equal(path in r2Paths, false, 'The document must not advertise an R1 alias');
    // OpenAPI path templates are not URLs: URL encodes literal braces. Substitute
    // a concrete encoded parameter before checking the public URL composition.
    const concrete = expected.replace(/\{[^}]+\}/g, encodeURIComponent('example:value'));
    const composed = new URL(concrete, new URL(r2Spec.servers[0].url, r2));
    assert.equal(composed.origin, 'https://test.tonswap.org');
    assert.equal(composed.pathname, concrete, 'OpenAPI server and concrete path compose exactly once');
    assert.equal(composed.pathname.split('/api/indexer-r2').length - 1, 1, 'The public mount occurs exactly once');
  }
  // Every local schema/security reference must still resolve after path remapping.
  const refs = JSON.stringify(r2Paths).matchAll(/"\$ref":"(#[^"]+)"/g);
  let refCount = 0;
  for (const [, ref] of refs) {
    const value = ref.slice(2).split('/').reduce<unknown>((node, part) =>
      (node as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')], r2Spec);
    assert.notEqual(value, undefined, `Unresolved original reference ${ref}`);
    refCount++;
  }
  assert.ok(refCount > 20, 'Exercise the actual API and ledger component references');
  const docs = buildDocsHtml('mount-test-nonce', r2);
  assert.ok(docs.includes('href="/api/indexer-r2/v1/openapi.json"'));
  assert.ok(docs.includes('value="/api/indexer-r2/v1/cover/{manager}/snapshot"'));
  assert.ok(docs.includes('<script nonce="mount-test-nonce">'));
  assert.equal(docs.includes('/api/indexer/v1'), false);

  for (const [indexer, mount] of [[r1, '/api/indexer'], [r2, '/api/indexer-r2'], [`${r2}/`, '/api/indexer-r2']] as const) {
    const app = Fastify();
    try {
      registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, {}, metadataFor(indexer));
      const response = await app.inject({ method: 'GET', url: '/api/indexer/v1/service-info' });
      assert.equal(response.statusCode, 200);
      const info = response.json();
      assert.equal(info.publicBaseUrl, indexer);
      assert.equal(info.serviceId, `test.tonswap.org${mount}`);
      assert.equal(info.endpoints.openapi, `${mount}/v1/openapi.json`);
      assert.equal(info.endpoints.balances, `${mount}/v1/accounts/{addr}/balances`);
      assert.equal(info.endpoints.readFresh, `${mount}/v1/readFresh`);
      assert.equal(info.endpoints.marketCandles, `${mount}/v1/markets/{market}/candles`);
      assert.ok(Object.values(info.endpoints).every(path => typeof path === 'string' && path.startsWith(`${mount}/v1/`)));
      const specResponse = await app.inject({ method: 'GET', url: '/api/indexer/v1/openapi.json' });
      assert.equal(specResponse.statusCode, 200);
      const spec = specResponse.json();
      assert.ok(spec.paths[info.endpoints.readFresh]);
      assert.ok(spec.paths[info.endpoints.balances]);
      const docsResponse = await app.inject({ method: 'GET', url: '/api/indexer/v1/docs' });
      assert.equal(docsResponse.statusCode, 200);
      assert.ok(docsResponse.body.includes(`href="${mount}/v1/openapi.json"`));
      if (mount === '/api/indexer-r2') {
        assert.equal((await app.inject({ method: 'GET', url: '/api/indexer-r2/v1/service-info' })).statusCode, 404,
          'The public proxy rewrites to the canonical backend; the worker must not register a second release route');
      }
    } finally {
      await app.close();
    }
  }
  process.stdout.write('public API mount behavior ok (synthetic offline fixtures; no deployed release qualification)\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
