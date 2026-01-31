import { Config } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { TonDataSource } from '../data/dataSource';
import { OpcodeSets } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { Logger } from '../utils/logger';
import { IndexerService } from '../indexerService';
import { PoolTracker } from '../poolTracker';

export class BlockFollower {
  private config: Config;
  private store: MemoryStore;
  private source: TonDataSource;
  private opcodes: OpcodeSets;
  private logger: Logger;
  private service: IndexerService;
  private poolTracker?: PoolTracker;
  private timer?: NodeJS.Timeout;
  private lastSeqno?: number;
  private inFlight = false;

  constructor(
    config: Config,
    store: MemoryStore,
    source: TonDataSource,
    opcodes: OpcodeSets,
    logger: Logger,
    service: IndexerService,
    poolTracker?: PoolTracker
  ) {
    this.config = config;
    this.store = store;
    this.source = source;
    this.opcodes = opcodes;
    this.logger = logger;
    this.service = service;
    this.poolTracker = poolTracker;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.config.blockPollMs);
    this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const master = await this.source.getMasterchainInfo();
      if (this.lastSeqno && master.seqno <= this.lastSeqno) return;
      this.lastSeqno = master.seqno;
      this.service.setMasterchainInfo(master.seqno, master.timestamp);

      const watchlist = this.store.listWatchlist();
      if (watchlist.length === 0) return;

      const batchSize = 10;
      for (let i = 0; i < watchlist.length; i += batchSize) {
        const batch = watchlist.slice(i, i + batchSize);
        await Promise.all(
          batch.map((entry) =>
            this.refreshAddress(entry.address, master.seqno).catch((error) => {
              this.logger.warn('watchlist refresh failed', {
                address: entry.address,
                error: (error as Error).message,
              });
            })
          )
        );
      }

      this.store.purgeStale();
    } catch (error) {
      this.logger.error('block follower error', { error: (error as Error).message });
    } finally {
      this.inFlight = false;
    }
  }

  private async refreshAddress(address: string, seqno: number) {
    await this.service.refreshAccountState(address);
    const entry = this.store.get(address);
    if (!entry?.balance?.lastTxLt || !entry.balance.lastTxHash) return;

    const latest = entry.txs[0];
    if (latest && latest.lt === entry.balance.lastTxLt && latest.hash === entry.balance.lastTxHash) {
      this.store.setLastUpdateSeqno(address, seqno);
      return;
    }

    const limit = this.config.pageSize * 2;
    const raw = await this.source.getTransactions(address, limit, entry.balance.lastTxLt, entry.balance.lastTxHash);
    this.poolTracker?.observeTransactions(raw);
    const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
    this.store.addTransactions(address, indexed);
    this.store.setLastUpdateSeqno(address, seqno);
  }
}
