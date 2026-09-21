import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import fastify from 'fastify';
import { buildOpenApi } from '../api/openapi';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';

const root = resolve(__dirname, '../..');
const retiredFiles = [
  'src/config/ledgerBridge.ts',
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
  'registry',
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

async function main() {
  const poisoned = process.env.LEDGER_SCCP_ASSETS_JSON;
  process.env.LEDGER_SCCP_ASSETS_JSON = '[{"master":"retired"}]';
  try {
    const config = loadConfig();
    assert.equal('ledgerSccpAssets' in config, false, 'retired environment input must be ignored');
    const spec = buildOpenApi(config);
    assert.equal(Object.keys(spec.paths).some((path) => forbidden.test(path)), false);

    const app = fastify({ logger: false });
    registerRoutes(app, config, {} as never);
    await app.ready();
    for (const path of [
      '/api/indexer/v1/sccp/ton/burn-status',
      '/api/indexer/v1/sccp/ton/burn-proof-material',
    ]) {
      assert.equal((await app.inject(path)).statusCode, 404, `${path} must stay unpublished`);
    }
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
