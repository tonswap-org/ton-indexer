import { RawTransaction } from './data/dataSource';

const isPlaceholder = (value: string) => value.startsWith('REPLACE_');

export class PoolTracker {
  private factories = new Set<string>();
  private pools = new Set<string>();

  constructor(registry?: Record<string, string>) {
    if (!registry) return;
    for (const [key, value] of Object.entries(registry)) {
      if (!value || isPlaceholder(value)) continue;
      const label = key.toLowerCase();
      if (label.includes('poolfactory')) {
        this.factories.add(value);
      } else if (label.includes('pool')) {
        this.pools.add(value);
      }
    }
  }

  observeTransactions(txs: RawTransaction[]) {
    for (const tx of txs) {
      this.observeTransaction(tx);
    }
  }

  getPoolCount() {
    return this.pools.size;
  }

  getFactoryCount() {
    return this.factories.size;
  }

  private observeTransaction(tx: RawTransaction) {
    if (this.factories.size === 0) return;
    const inMsg = tx.inMessage;
    const isFactory =
      (inMsg?.destination && this.factories.has(inMsg.destination)) ||
      (inMsg?.source && this.factories.has(inMsg.source));
    if (!isFactory) return;
    for (const outMsg of tx.outMessages) {
      if (outMsg.destination) this.pools.add(outMsg.destination);
    }
  }
}
