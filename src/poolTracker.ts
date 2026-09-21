import { Address } from '@ton/core';
import { RawTransaction } from './data/dataSource';

const isPlaceholder = (value: string) => value.startsWith('REPLACE_');

const normalizeAddress = (value: string) => {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return value.trim().toLowerCase();
  }
};

const FACTORY_CREATION_OPS = new Set([
  0x444c4350, // DLMM create pool
  0x4c500001, // launchpad get-or-create pool
]);
const OP_LAUNCHPAD_POOL_DEPLOY = 0x4c500008;
const OP_FACTORY_POOL_DEPLOYED = 0x4c50000a;
export class PoolTracker {
  private factories = new Set<string>();
  private pools = new Set<string>();
  private knownContracts = new Set<string>();

  constructor(registry?: Record<string, string>) {
    if (!registry) return;
    for (const [key, value] of Object.entries(registry)) {
      if (!value || isPlaceholder(value)) continue;
      const address = normalizeAddress(value);
      this.knownContracts.add(address);
      const label = key.toLowerCase();
      if (key === 'DlmmPoolFactory') {
        this.factories.add(address);
      } else if (label.includes('pool')) {
        this.pools.add(address);
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
    if (
      this.factories.size === 0 ||
      !tx.success ||
      (tx.status !== undefined && tx.status !== 'success')
    ) {
      return;
    }
    const inMsg = tx.inMessage;
    const isFactory =
      (inMsg?.destination && this.factories.has(normalizeAddress(inMsg.destination))) ||
      (inMsg?.source && this.factories.has(normalizeAddress(inMsg.source)));
    if (!isFactory) return;

    if (inMsg?.op === OP_FACTORY_POOL_DEPLOYED && inMsg.source) {
      const deployedPool = normalizeAddress(inMsg.source);
      if (!this.knownContracts.has(deployedPool)) this.pools.add(deployedPool);
      return;
    }
    if (inMsg?.op === undefined || !FACTORY_CREATION_OPS.has(inMsg.op)) return;

    const launchDeployments = tx.outMessages.filter(
      (outMsg) => outMsg.op === OP_LAUNCHPAD_POOL_DEPLOY && outMsg.destination
    );
    if (launchDeployments.length === 1) {
      const destination = normalizeAddress(launchDeployments[0]!.destination!);
      if (!this.knownContracts.has(destination)) this.pools.add(destination);
      return;
    }

    // Direct DLMM creation uses one empty-body deploy. Require it to be the
    // only unknown empty-body destination so unrelated contract deployments
    // can never be mistaken for pools.
    if (inMsg.op === 0x444c4350) {
      const directDeployments = tx.outMessages.filter(
        (outMsg) =>
          outMsg.op === undefined &&
          outMsg.destination &&
          !this.knownContracts.has(normalizeAddress(outMsg.destination))
      );
      if (directDeployments.length === 1) {
        this.pools.add(normalizeAddress(directDeployments[0]!.destination!));
      }
    }
  }
}
