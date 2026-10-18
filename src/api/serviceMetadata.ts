import type { Network } from '../config';
import type { RegistryMetadata } from '../config/releaseManifest';
import { validateReleaseManifest, type RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { FastifyInstance } from 'fastify';

export type ServiceMetadataConfig = { network: Network };

/** Only exact current native bindings can advertise release-bound fresh reads. */
export function currentNativeRuntime(network: Network, metadata?: RegistryMetadata): RuntimeReleaseManifest | undefined {
  const runtime = metadata?.runtime;
  return runtime && validateReleaseManifest(runtime).ok && runtime.schema === 'tonswap-release-v1' && runtime.network === `ton:${network}`
    && runtime.globalId === (network === 'mainnet' ? -239 : -3)
    && metadata?.releaseId === runtime.releaseId && metadata.manifestHash === runtime.manifestHash ? runtime : undefined;
}

export function resolveServiceMetadata(config: ServiceMetadataConfig, metadata?: RegistryMetadata) {
  const runtime = currentNativeRuntime(config.network, metadata);
  const publicBaseUrl = runtime?.services.indexer ?? null;
  const url = publicBaseUrl ? new URL(publicBaseUrl) : null;
  if (runtime && !url) throw new Error('Native service metadata requires its current indexer URL.');
  const urlIdentity = url ? `${url.host}${url.pathname.replace(/\/$/, '')}` : null;
  return {
    // The native release names the exact indexer authority, including its mount.
    serviceId: urlIdentity,
    publicBaseUrl: publicBaseUrl || null,
    freshReads: runtime !== undefined,
  };
}

export const RELEASE_IDENTITY_HEADER = 'x-tonswap-release';
/** A worker serves one manifest for its lifetime; the supervisor replaces it on change. */
export function installReleaseIdentity(app: FastifyInstance, network: Network, metadata?: RegistryMetadata): void {
  const runtime = currentNativeRuntime(network, metadata);
  const hash = runtime?.manifestHash;
  app.addHook('onRequest', async (request, reply) => {
    if (hash) reply.header(RELEASE_IDENTITY_HEADER, hash);
    const expected = request.headers[RELEASE_IDENTITY_HEADER];
    if (expected === undefined || request.method === 'OPTIONS') return;
    if (!hash) return reply.header('cache-control', 'no-store').header('retry-after', '2').code(503)
      .send({ error: 'The current release identity is unavailable.', code: 'upstream_unavailable' });
    if (typeof expected !== 'string' || expected !== hash) return reply.header('cache-control', 'no-store').code(409)
      .send({ error: 'The requested release does not match this indexer.', code: 'release_mismatch' });
  });
  // Covers validation failures, preflight responses and child route scopes.
  app.addHook('onSend', async (_request, reply, payload) => {
    if (hash) reply.header(RELEASE_IDENTITY_HEADER, hash);
    return payload;
  });
}
