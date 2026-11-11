import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import fastify from 'fastify';
import { buildOpenApi } from '../api/openapi';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';
import { runtimeMetadataFixture } from './fixtures/runtimeManifest';

const root = resolve(__dirname, '../..');
const retiredFiles = [
  'scripts/production-deployment-evidence.json',
  'scripts/generate-deployment-evidence-template.sh',
  'scripts/audit-deployment-evidence.sh',
  'scripts/test-deployment-evidence-audit.sh',
  'scripts/test-deployment-evidence-template.sh',
  'src/scripts/deployment-manifest-test.ts',
  'docs/ti-production.md',
  'Dockerfile',
  '.dockerignore',

  'src/config/ledgerBridge.ts',
  'src/config/ledgerPerps.ts',
  'src/config/ledgerOptions.ts',
  'src/config/ledgerLaunchpad.ts',
  'src/config/ledgerT3.ts',
  'src/config/ledgerMarkets.ts',
  'src/config/registry.ts',
  'src/scripts/refresh-registry.ts',
  'registry/mainnet.json',
  'registry/testnet.json',
  'registry/localnet.json',
  'src/ledger/sccp.ts',
  'src/ledger/sccpWire.ts',
  'src/utils/sccpEvidence.ts',
  'src/soraCheckpoint.ts',
  'src/scripts/ledger-sccp-test.ts',
  'src/scripts/sora-checkpoint-test.ts',
];
for (const relative of retiredFiles) {
  assert.equal(existsSync(join(root, relative)), false, `${relative} must remain retired`);
}

const activeRoots = [
  'src/api',
  'src/config',
  'src/data',
  'src/ledger',
  'src/index.ts',
  'src/indexerService.ts',
  'package.json',
  'README.md',
];
const forbidden = new RegExp([
  'sc' + 'cp',
  'cross' + 'chain',
  'cross' + '-chain',
  'bridge_' + 'burn',
  'bridge_' + 'mint',
  'LEDGER_' + 'SCCP',
  'SORA_TON_' + 'TRUSTED_CHECKPOINT',
  'cluster' + 'Guard',
  'cluster_' + 'guard',
  'cluster-' + 'guard',
  'cluster ' + 'guard',
  'clmm' + 'Factory',
  'clmm_' + 'factory',
  'clmm' + 'PoolHashHigh',
  'clmm' + 'PoolHashLow',
  'clmm_' + 'pool_hash_high',
  'clmm_' + 'pool_hash_low',
  'market' + 'Kind',
  'market_' + 'kind',
  'kind' + 'Config',
  'kind_' + 'config',
  'timer' + 'VolatilityBps',
  'timer_' + 'volatility_bps',
  'timer' + 'EmaVolatilityBps',
  'timer_' + 'ema_volatility_bps',
  'timer' + 'LastUpdateTs',
  'timer_' + 'last_update_ts',
  'timer' + 'WeightBps',
  'timer_' + 'weight_bps',
  'correlation' + 'WeightBps',
  'correlation_' + 'weight_bps',
].join('|'), 'i');

const visit = (relative: string): string[] => {
  const absolute = join(root, relative);
  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) return visit(child);
    return ['.ts', '.json', '.md'].includes(extname(entry.name)) ? [child] : [];
  });
};
for (const relative of activeRoots) {
  const absolute = join(root, relative);
  const files = extname(relative) ? [relative] : visit(relative);
  for (const file of files) {
    const match = forbidden.exec(readFileSync(join(root, file), 'utf8'));
    assert.equal(match, null, `${file} retains retired first-release surface: ${match?.[0] ?? ''}`);
  }
}

for (const relative of ['src/api', 'src/config', 'src/data']) {
  for (const file of visit(relative)) assert(!readFileSync(join(root, file), 'utf8').includes('ti.' + 'soramitsu.io'), `${file} must not name an unrelated deployment`);
}
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
assert.doesNotMatch(workflow, /Deployment evidence audit|Build production Docker image/);
assert.match(workflow, /npm ci/); assert.match(workflow, /npm audit --omit=dev/);

async function main() {
  const poisoned = process.env.LEDGER_SCCP_ASSETS_JSON;
  process.env.LEDGER_SCCP_ASSETS_JSON = '[{"master":"retired"}]';
  try {
    const config = loadConfig();
    assert.equal('ledgerSccpAssets' in config, false, 'retired environment input must be ignored');
    const metadata = runtimeMetadataFixture(config.network);
    const spec = buildOpenApi(config, metadata);
    assert.equal(Object.keys(spec.paths).some((path) => forbidden.test(path)), false);

    const app = fastify({ logger: false });
    registerRoutes(app, config, {} as never, undefined, undefined, undefined, undefined, undefined, metadata);
    await app.ready();
    for (const path of [
      '/api/indexer/v1/sccp/ton/burn-status',
      '/api/indexer/v1/sccp/ton/burn-proof-material',
    ]) {
      assert.equal((await app.inject(path)).statusCode, 404, `${path} must stay unpublished`);
    }
    const retired = [
      ['GET', '/api/indexer/v1/accounts/owner/balance'], ['GET', '/api/indexer/v1/accounts/owner/assets'],
      ['GET', '/api/indexer/v1/stream'], ['GET', '/api/indexer/v1/jettons/root/transfer/owner/payload'],
      ['GET', '/api/indexer/v1/perps/engine/snapshot'], ['GET', '/api/indexer/v1/options/factory/snapshot'],
      ['GET', '/api/indexer/v1/cover/manager/snapshot'], ['GET', '/api/indexer/v1/vol-index/volIndex/snapshot'],
      ['GET', '/api/indexer/v1/pools/pool/farms'], ['POST', '/api/indexer/v1/defi/snapshot'], ['POST', '/api/indexer/v1/runGetMethods'], ['GET', '/api/indexer/v1/accounts/owner/swaps'],
    ] as const;
    for (const [method, url] of retired) {
      const response = await app.inject({method, url}); assert.equal(response.statusCode, 404, url);
      assert.deepEqual(response.json(), {error: 'The requested resource was not found.', code: 'not_found'});
    }
    const info = (await app.inject('/api/indexer/v1/service-info')).json();
    for (const capability of ['account-balance', 'account-assets', 'run-get-methods']) assert(!info.capabilities.includes(capability));
    for (const endpoint of ['balance', 'assets', 'runGetMethods']) assert(!(endpoint in info.endpoints));
    for (const [method, url] of [
      ['POST','/api/indexer/v1/readFresh'],['POST','/api/indexer/v1/runGetMethod'],['GET','/api/indexer/v1/accounts/:addr/balances'],
      ['GET','/api/indexer/v1/stream/balances'],['GET','/api/indexer/v1/accounts/:addr/txs'],['GET','/api/indexer/v1/accounts/:addr/state'],
      ['GET','/api/indexer/v1/markets/:market/candles'],['GET','/api/indexer/v1/governance/:voting/snapshot'],
      ['POST','/api/indexer/v1/dlmm/pools/snapshot'],
      ['GET','/api/indexer/v1/service-info'],['GET','/api/indexer/v1/health'],['POST','/jsonRPC'],['POST','/api/v2/jsonRPC'],
    ] as const) assert(app.hasRoute({method, url}), `${method} ${url} must remain registered`);
    await app.close();
  } finally {
    if (poisoned === undefined) delete process.env.LEDGER_SCCP_ASSETS_JSON;
    else process.env.LEDGER_SCCP_ASSETS_JSON = poisoned;
  }
}

main()
  .then(() => console.log('First-release indexer surface excludes all retired runtime paths'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
