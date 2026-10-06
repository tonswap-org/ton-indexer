import type { FastifyInstance } from 'fastify';
import type { RegistryMetadata } from '../config/releaseManifest';
import { currentNativeRuntime, resolveServiceMetadata, type ServiceMetadataConfig } from '../api/serviceMetadata';
import { runningLedgerBuild, type AuthenticatedLedgerBuild } from './buildIdentity';
import { assertLedgerDatabaseReady } from './schemaReadiness';
import type { LedgerSqlPool } from './store';

export function registerLedgerReadinessRoute(app: FastifyInstance, options: {
  config: ServiceMetadataConfig;
  metadata: RegistryMetadata;
  pool?: LedgerSqlPool;
  build?: AuthenticatedLedgerBuild;
}) {
  const build = options.build ?? runningLedgerBuild;
  app.get('/api/indexer/v1/ledger/readiness', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const runtime = currentNativeRuntime(options.config.network, options.metadata);
      if (!runtime || options.config.network !== 'testnet' || runtime.globalId !== -3 || !options.pool || !build)
        throw Error('Native durable ledger identity is unavailable');
      build.assertCurrent();
      const database = await assertLedgerDatabaseReady(options.pool, runtime.manifestHash, build.catalog);
      build.assertCurrent();
      const service = resolveServiceMetadata(options.config, options.metadata);
      return { schema: 'tonswap-native-ledger-readiness-v1', ecosystem: 'ton', network: 'testnet', chainId: 'ton:testnet',
        serviceId: service.serviceId, publicBaseUrl: service.publicBaseUrl,
        release: { releaseId: runtime.releaseId, manifestHash: runtime.manifestHash },
        build: { sha256: build.identity.sha256, sqlSha256: build.identity.sqlSha256 }, database, checkedAt: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ code: 'ledger_not_ready', error: 'The current native durable ledger build or database is not ready.' });
    }
  });
}
