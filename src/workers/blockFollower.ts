import { Config } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { RawTransaction, TonDataSource } from '../data/dataSource';
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
    const previousEntry = this.store.get(address);
    const previousLatest = previousEntry?.txs[0];
    await this.service.refreshAccountState(address);
    const entry = this.store.get(address);
    if (!entry?.balance?.lastTxLt || !entry.balance.lastTxHash) return;

    if (
      previousLatest &&
      previousLatest.lt === entry.balance.lastTxLt &&
      previousLatest.hash === entry.balance.lastTxHash
    ) {
      this.store.setLastUpdateSeqno(address, seqno);
      return;
    }

    const batchSize = Math.max(1, this.config.pageSize * this.config.backfillPageBatch);
    const maxBatches = Math.max(
      1,
      Math.ceil(this.config.backfillMaxPagesPerAddress / this.config.backfillPageBatch)
    );
    const raw: RawTransaction[] = [];
    const seen = new Set<string>();
    let cursorLt = entry.balance.lastTxLt;
    let cursorHash = entry.balance.lastTxHash;
    let reachedPreviousLatest = !previousLatest;

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const batch = await this.source.getTransactions(address, batchSize, cursorLt, cursorHash);
      if (batch.length === 0) break;

      let added = 0;
      for (const tx of batch) {
        const key = `${tx.lt}:${tx.hash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push(tx);
        added += 1;
        if (previousLatest && tx.lt === previousLatest.lt && tx.hash === previousLatest.hash) {
          reachedPreviousLatest = true;
        }
      }

      const oldest = batch[batch.length - 1];
      if (!oldest || batch.length < batchSize || reachedPreviousLatest) break;
      if (oldest.lt === cursorLt && oldest.hash === cursorHash) break;
      if (added === 0) break;
      cursorLt = oldest.lt;
      cursorHash = oldest.hash;
    }

    if (raw.length > 0) {
      this.poolTracker?.observeTransactions(raw);
      const indexed = raw.map((tx) => classifyTransaction(address, tx, this.opcodes));
      this.store.addTransactions(address, indexed);
    }
    if (previousLatest && !reachedPreviousLatest) {
      this.store.markHistoryIncomplete(address);
      this.logger.warn('watchlist catch-up capped before previous latest transaction', {
        address,
        fetched: raw.length,
        previousLt: previousLatest.lt
      });
    }
    this.store.setLastUpdateSeqno(address, seqno);
  }
}
