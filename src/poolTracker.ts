import { Address, Cell } from '@ton/core';
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
  0x44504f4c, // CLMM deploy pool
]);
const OP_LAUNCHPAD_POOL_DEPLOY = 0x4c500008;
const OP_FACTORY_POOL_DEPLOYED = 0x4c50000a;
const OP_CLMM_POOL_DEPLOYED = 0x50444c59;

const readAddressRefs = (cell: Cell, count: number): Address[] | null => {
  try {
    const slice = cell.beginParse();
    if (slice.remainingBits !== 0 || slice.remainingRefs !== count) return null;
    const addresses: Address[] = [];
    for (let index = 0; index < count; index += 1) {
      const addressSlice = slice.loadRef().beginParse();
      const address = addressSlice.loadAddressAny();
      if (
        !Address.isAddress(address) ||
        addressSlice.remainingBits !== 0 ||
        addressSlice.remainingRefs !== 0
      ) {
        return null;
      }
      addresses.push(address);
    }
    return addresses;
  } catch {
    return null;
  }
};

const decodeClmmPoolDeployed = (body?: string): string | null => {
  if (!body) return null;
  try {
    const slice = Cell.fromBase64(body).beginParse();
    if (slice.remainingBits !== 32 + 64 + 64 + 8 || slice.remainingRefs !== 3) return null;
    if (slice.loadUint(32) !== OP_CLMM_POOL_DEPLOYED) return null;
    slice.loadUintBig(64); // query id
    slice.loadUintBig(64); // pool id
    slice.loadUint(8); // invariant
    const primary = readAddressRefs(slice.loadRef(), 3);
    const tokens = readAddressRefs(slice.loadRef(), 2);
    const wallets = readAddressRefs(slice.loadRef(), 2);
    if (
      !primary ||
      !tokens ||
      !wallets ||
      slice.remainingBits !== 0
    ) {
      return null;
    }
    return primary[0]?.toRawString() ?? null;
  } catch {
    return null;
  }
};

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
      if (label.includes('poolfactory')) {
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

    const clmmPool = tx.outMessages
      .filter((outMsg) => outMsg.op === OP_CLMM_POOL_DEPLOYED)
      .map((outMsg) => decodeClmmPoolDeployed(outMsg.body))
      .find((address): address is string => Boolean(address));
    if (clmmPool) {
      if (!this.knownContracts.has(clmmPool)) this.pools.add(clmmPool);
      return;
    }

    const launchDeployments = tx.outMessages.filter(
      (outMsg) => outMsg.op === OP_LAUNCHPAD_POOL_DEPLOY && outMsg.destination
    );
    if (launchDeployments.length === 1) {
      const destination = normalizeAddress(launchDeployments[0]!.destination!);
      if (!this.knownContracts.has(destination)) this.pools.add(destination);
      return;
    }

    // Direct DLMM creation uses one empty-body deploy. Require it to be the
    // only unknown empty-body destination so CLMM's pool/collection/queue
    // deployment fan-out can never be mistaken for three pools.
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
