import { Address, Cell, loadTransaction, Slice, type Transaction } from '@ton/core';
import { validJettonWalletProfile, type JettonWalletBudget } from './config/runtimeManifest';
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

const OP_POOL_READY = 0x50524459;
const OP_POOL_LISTED = 0x504c5333;
const isPoolRole = (role: string) => role === 'DlmmPool' ||
  /^Market(?:0|[1-9][0-9]*)(?:Perps)?Pool$/.test(role) ||
  /^Spot(?:0|[1-9][0-9]*)Pool$/.test(role) ||
  /^Launchpad(?:Fixed|Bonding|Auction)(?:Perps)?Pool$/.test(role);

const budgetWidths = [['senderGas',32],['walletBounceGas',32],['burnWalletGas',32],['smallPayloadCells',16],['largeWalletGas',32],['largeSenderGas',32],['rentSeconds',32],['rentBits',32],['rentCells',16],['initBits',32],['initCells',16],['initCopies',8],['transferBits',16],['transferCells',8],['transferCopies',8]] as const;
const validPoolId = (cell: Cell) => {
  if (cell.isExotic) return false;
  const s=cell.beginParse(),root=s.loadAddress(),spacing=s.loadUint(16),fee=s.loadUint(32),decimals=s.loadUint(8),gas=s.loadUint(32),gram=s.loadCoins(),budget=s.loadRef();s.endParse();
  if (root.workChain!==0 || spacing<1 || spacing>10000 || fee>100000 || decimals>18 || budget.isExotic) return false;
  const p=budget.beginParse(),profile={} as JettonWalletBudget;for(const [key,width] of budgetWidths)profile[key]=p.loadUint(width);profile.creditProtection=p.loadBit();p.endParse();
  return validJettonWalletProfile(gas,gram.toString(),profile);
};
const deployedPool = (body: Slice, source: Address, factory: Address, transaction: Transaction): Address | null => {
  if (source.workChain!==0 || source.equals(factory) || body.loadUint(32)!==OP_POOL_READY) return null;
  const id=body.loadRef(),notify=body.loadMaybeAddress();body.endParse();
  if (notify && notify.workChain!==0 || !validPoolId(id)) return null;
  // Current Factory can ignore an unauthentic/underfunded READY with exit0.
  // Its original PoolListed output proves the native acceptance branch ran.
  const listings=transaction.outMessages.values().filter(message => message.info.type==='external-out' && !message.body.isExotic
    && message.body.bits.length>=32 && message.body.beginParse().preloadUint(32)===OP_POOL_LISTED);
  if (listings.length!==1) return null;
  const listing=listings[0],p=listing.body.beginParse();p.loadUint(32);const pool=p.loadAddress(),listedId=p.loadRef();p.endParse();
  if (listing.info.type!=='external-out' || !listing.info.src.equals(factory) || !pool.equals(source) || !listedId.equals(id)) return null;
  return pool;
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
      // Pool only after READY emits its accepted listing at the Factory. Original
      // cells bind the receiver and status; provider summaries cannot forge them.
      const original = assertOriginalTransactionPage([tx], Address.parse(factory), tx)[0]!;
      const message = original.inMessage;
      if (!original.success || original.status !== 'success' || !message?.source || !message.body || message.bounced) return;
      const cell = Cell.fromBase64(message.body);
      if (cell.isExotic) return;
      const originalCell=Cell.fromBase64(original.rawBoc!),slice=originalCell.beginParse(),transaction=loadTransaction(slice);slice.endParse();
      const d=transaction.description;
      if(d.type!=='generic'||d.aborted||d.destroyed||d.computePhase.type!=='vm'||!d.computePhase.success||![0,1].includes(d.computePhase.exitCode)
        ||!d.actionPhase?.valid||!d.actionPhase.success||d.actionPhase.resultCode!==0)return;
      const pool = deployedPool(cell.beginParse(), Address.parse(message.source), Address.parse(factory), transaction);
      if (pool && !this.knownContracts.has(pool.toRawString())) this.pools.add(pool.toRawString());
    } catch {
      // Missing archives, malformed current messages and wrong-account evidence
      // do not expand the diagnostic inventory. They never authorize a market.
    }
  }
}
