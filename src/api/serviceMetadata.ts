import type { Network } from '../config';
import type { RegistryMetadata } from '../config/releaseManifest';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';

export type ServiceMetadataConfig = { network: Network; serviceId?: string; publicBaseUrl?: string };

/** Only exact current native bindings can advertise release-bound fresh reads. */
export function currentNativeRuntime(network: Network, metadata?: RegistryMetadata): RuntimeReleaseManifest | undefined {
  const runtime = metadata?.runtime;
  return runtime?.schema === 'tonswap-release-v1' && runtime.network === `ton:${network}`
    && metadata?.releaseId === runtime.releaseId && metadata.manifestHash === runtime.manifestHash ? runtime : undefined;
}

export function resolveServiceMetadata(config: ServiceMetadataConfig, metadata?: RegistryMetadata) {
  const runtime = currentNativeRuntime(config.network, metadata);
  const publicBaseUrl = runtime?.services.indexer ?? config.publicBaseUrl?.trim() ?? null;
  const url = publicBaseUrl ? new URL(publicBaseUrl) : null;
  if (runtime && !url) throw new Error('Native service metadata requires its current indexer URL.');
  const urlIdentity = url ? `${url.host}${url.pathname.replace(/\/$/, '')}` : null;
  return {
    // The native release names the exact indexer authority, including its mount.
    serviceId: runtime && urlIdentity ? urlIdentity : config.serviceId?.trim() || urlIdentity || `ton-indexer:${config.network}`,
    publicBaseUrl: publicBaseUrl || null,
    freshReads: runtime !== undefined,
  };
}
