import { Address, Cell, Slice } from '@ton/core';
import { RawTransaction } from './data/dataSource';
import { assertOriginalTransactionPage } from './data/transactionEvidence';

const isPlaceholder = (value: string) => value.startsWith('REPLACE_');

const normalizeAddress = (value: string) => {
  try {
    return Address.parse(value).toRawString();
  } catch {
    return null;
  }
};

const OP_FACTORY_POOL_DEPLOYED = 0x4c50000a;
const OP_DIRECT_POOL_DEPLOYED = 0x44504441;
const isPoolRole = (role: string) => role === 'DlmmPool' ||
  /^Market(?:0|[1-9][0-9]*)(?:Perps)?Pool$/.test(role) ||
  /^Spot(?:0|[1-9][0-9]*)Pool$/.test(role) ||
  /^Launchpad(?:Fixed|Bonding|Auction)(?:Perps)?Pool$/.test(role);

const addressPair = (cell: Cell): [Address, Address] => {
  // The current protocol uses exactly two standard internal addresses.
  if (cell.isExotic || cell.bits.length !== 534 || cell.refs.length !== 0) throw new Error('Invalid address pair');
  const slice = cell.beginParse();
  const first = slice.loadAddress(), second = slice.loadAddress();
  slice.endParse();
  return [first, second];
};

const deployedPool = (body: Slice, source: Address, factory: Address): Address | null => {
  const op = body.loadUint(32);
  if (op !== OP_DIRECT_POOL_DEPLOYED && op !== OP_FACTORY_POOL_DEPLOYED) return null;
  const query = body.loadUintBig(64);
  if (query === 0n) return null;
  if (op === OP_DIRECT_POOL_DEPLOYED) body.loadUintBig(256); // Native Factory authenticates the persisted config commitment.
  else { body.loadUintBig(64); body.loadInt(32); } // saleId, initial bin
  if (body.remainingBits !== 0 || body.remainingRefs !== 2) return null;
  const [tokenT, tokenX] = addressPair(body.loadRef());
  const [actor, other] = addressPair(body.loadRef());
  body.endParse();
  if (tokenT.equals(tokenX)) return null;
  if (op === OP_DIRECT_POOL_DEPLOYED && (!actor.equals(source) || !other.equals(factory))) return null;
  // For launch pools, actor/other are sale/vault. Their immutable identity and
  // the sender are checked by the registered Factory before accepting the ACK.
  return source;
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
      if (!address) continue;
      this.knownContracts.add(address);
      if (key === 'DlmmPoolFactory') {
        this.factories.add(address);
      } else if (isPoolRole(key)) {
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
    const factory = tx.inMessage?.destination && normalizeAddress(tx.inMessage.destination);
    if (!factory || !this.factories.has(factory)) return;
    try {
      // A create request or outgoing deploy only proves an attempt. Count the
      // Pool only after its typed ACK actually succeeds at the Factory. Original
      // cells bind the receiver and status; provider summaries cannot forge them.
      const original = assertOriginalTransactionPage([tx], Address.parse(factory), tx)[0]!;
      const message = original.inMessage;
      if (!original.success || original.status !== 'success' || !message?.source || !message.body || message.bounced) return;
      const cell = Cell.fromBase64(message.body);
      if (cell.isExotic) return;
      const pool = deployedPool(cell.beginParse(), Address.parse(message.source), Address.parse(factory));
      if (pool && !this.knownContracts.has(pool.toRawString())) this.pools.add(pool.toRawString());
    } catch {
      // Missing archives, malformed current messages and wrong-account evidence
      // do not expand the diagnostic inventory. They never authorize a market.
    }
  }
}
