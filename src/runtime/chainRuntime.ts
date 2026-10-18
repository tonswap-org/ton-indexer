import type { LiteEngine } from 'ton-lite-client';
import type { Config } from '../config';
import { loadLiteserverPool, type LiteserverPeer } from '../data/liteserverPool';
import { createLiteChainSource } from '../data/liteClientSource';
import type { Logger } from '../utils/logger';
import type { RuntimeMetrics } from '../runtimeMetrics';
import { createHeadFeed } from './headFeed';

export function createChainRuntime(config: Config, logger: Logger, metrics: RuntimeMetrics,
  options: { engineFactory?: (peer: LiteserverPeer) => LiteEngine } = {}) {
  const source = createLiteChainSource({ network: config.network, peers: loadLiteserverPool(config.liteserverPool), logger,
    engineFactory: options.engineFactory, observer: {
      query(peer, ok, ms) {
        const labels = { peer: String(peer), outcome: ok ? 'success' : 'failure' };
        metrics.count('chain_queries', 1, labels); metrics.observe('chain_query_ms', ms, labels);
      },
      head(head) { metrics.gauge('chain_head_seqno', head.seqno); metrics.gauge('chain_head_utime', head.utime); },
    } });
  let lastFailure: string | undefined;
  const heads = createHeadFeed(source, config.blockPollMs, error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastFailure) logger.warn('chain head unavailable', { reason: message });
    lastFailure = message;
  });
  return { source, heads, async stop() { heads.stop(); await source.close(); } };
}
