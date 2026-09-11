import type { LedgerSccpBinding } from "../config/ledgerBridge";
import { randomUUID } from "node:crypto";
import type { TonDataSource } from "../data/dataSource";
import {
  transactionPageIsLinkedInclusiveSegment,
  transactionPageReachesHistoryStart,
} from "../data/dataSource";
import type { Network } from "../models";
import type { OpcodeSets } from "../utils/opcodes";
import type { Logger } from "../utils/logger";
import { PostgresLedgerStore, projectionFingerprint, validProjectionScope } from "./store";
import {
  canonicalLedgerAddress,
  canonicalLedgerHash,
  normalizeLedgerEvent,
} from "./normalize";
import type { LedgerAsset, LedgerQuery } from "./types";
import { LedgerGraphBuilder } from "./graph";
import { projectOwnerLedger } from "./project";

/** Persists and validates account chains without consulting MemoryStore or its retention cap. */
export class LedgerService {
  private pending = new Set<string>();
  private running = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private identityCache = new Map<
    string,
    { expiresAt: number; promise: Promise<LedgerAsset | null> }
  >();

  constructor(
    readonly network: Network,
    readonly store: PostgresLedgerStore,
    private source: TonDataSource,
    private opcodes: OpcodeSets,
    private logger: Logger,
    private concurrency = 2,
    private options: {
      jettonRoots?: string[];
      dlmmRegistry?: string;
      optionFactory?: string;
      optionVault?: string;
      optionCodeHashes?: import("../config/ledgerOptions").LedgerOptionsCodeHashes;
      launchpadCodeHashes?: import("../config/ledgerLaunchpad").LedgerLaunchpadCodeHashes;
      launchpadControllers?: string[];
      t3RedemptionBinding?: import("../config/ledgerT3").LedgerT3RedemptionBinding;
      t3Hub?: string;
      t3Root?: string;
      perpsEngine?: string;
      perpsEngineCodeHash?: string;
      sccpAssets?: LedgerSccpBinding[];
      maxWatchedAccounts?: number;
      maxPagesPerSync?: number;
      maxRelatedAccounts?: number;
    } = {},
  ) {}

  start() {
    this.stopped = false;
    this.timer = setInterval(
      () =>
        void this.resume().catch(() =>
          this.logger.warn("ledger resume unavailable"),
        ),
      30_000,
    );
    this.timer.unref();
    void this.resume().catch(() =>
      this.logger.warn("ledger resume unavailable"),
    );
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.pending.clear();
    await Promise.allSettled(this.running.values());
  }

  private async resume() {
    const rows = (
      await this.store.pool.query(
        `SELECT a.account FROM ledger_watch_accounts w JOIN ledger_accounts a USING(network,account) WHERE a.network=$1
      ORDER BY a.attempted_at ASC NULLS FIRST LIMIT 100`,
        [this.network],
      )
    ).rows;
    for (const row of rows)
      if (!this.running.has(row.account)) this.pending.add(row.account);
    this.drain();
  }

  async requestSync(address: string) {
    const account = canonicalLedgerAddress(address);
    let admitted = false;
    await this.store.withAccountLock(
      this.network,
      "watch-admission",
      async () => {
        const existing =
          (
            await this.store.pool.query(
              "SELECT 1 FROM ledger_watch_accounts WHERE network=$1 AND account=$2",
              [this.network, account],
            )
          ).rows.length > 0;
        const count = Number(
          (
            await this.store.pool.query(
              "SELECT count(*)::text AS count FROM ledger_watch_accounts WHERE network=$1",
              [this.network],
            )
          ).rows[0].count,
        );
        if (!existing && count >= (this.options.maxWatchedAccounts ?? 1000))
          return;
        await this.store.pool.query(
          "INSERT INTO ledger_accounts(network,account) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [this.network, account],
        );
        await this.store.pool.query(
          "INSERT INTO ledger_watch_accounts(network,account) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [this.network, account],
        );
        admitted = true;
      },
    );
    if (!admitted) return false;
    const state = await this.store.account(this.network, account);
    // Freshness is independent of whether the account cache still exists.
    if (
      state?.synced_at &&
      Date.now() - new Date(state.synced_at).getTime() < 15_000 &&
      !state.error_code
    )
      return true;
    if (!this.running.has(account)) this.pending.add(account);
    this.drain();
    return true;
  }

  private drain() {
    if (this.stopped) return;
    while (this.running.size < this.concurrency && this.pending.size) {
      const account = this.pending.values().next().value as string;
      this.pending.delete(account);
      const work = this.syncAccount(account)
        .catch(() =>
          this.logger.warn("ledger synchronization failed", { account }),
        )
        .finally(() => {
          this.running.delete(account);
          this.drain();
        });
      this.running.set(account, work);
    }
  }

  async page(address: string, query: LedgerQuery = {}) {
    const account = canonicalLedgerAddress(address);
    // Cursor requests keep reading the same immutable run and never restart it.
    const admitted = query.cursor ? true : await this.requestSync(account);
    const page = await this.store.page(this.network, account, query);
    if (!admitted) {
      page.coverage.historyComplete = false;
      page.coverage.decodingComplete = false;
      page.coverage.issues.push("watch_capacity_reached");
    }
    if (this.pending.has(account) || this.running.has(account))
      page.coverage.syncing = true;
    return page;
  }

  async syncAccount(
    address: string,
    project = true,
    budget = { pages: this.options.maxPagesPerSync ?? 20 },
  ) {
    const account = canonicalLedgerAddress(address);
    return this.store.withAccountLock(this.network, account, async () => {
      try {
        const observedAt = new Date().toISOString();
        const state = await this.source.getAccountState(account);
        if (Boolean(state.lastTxLt) !== Boolean(state.lastTxHash))
          throw new Error("head_unavailable");
        const head =
          state.lastTxLt && state.lastTxHash
            ? {
                lt: state.lastTxLt,
                hash: canonicalLedgerHash(state.lastTxHash),
              }
            : undefined;
        const previous = await this.store.account(this.network, account);
        if (
          !project &&
          previous?.complete &&
          (head?.lt ?? null) === previous.head_lt &&
          (head?.hash ?? null) === previous.head_hash
        ) {
          await this.store.pool.query(
            "UPDATE ledger_accounts SET attempted_at=now(),synced_at=now(),checked_at=$3,syncing=false,error_code=NULL WHERE network=$1 AND account=$2",
            [this.network, account, observedAt],
          );
          return;
        }
        const build = async (generation: string, ownerCheckedAt?: string) => {
          const builder = new LedgerGraphBuilder(
            this.network,
            this.source,
            this.store,
            this.options.jettonRoots ?? [],
            this.options.dlmmRegistry,
            (wallet) => this.resolveJetton(wallet),
            (related) => this.syncAccount(related, false, budget),
            this.options.maxRelatedAccounts ?? 256,
            this.options.optionFactory,
            this.options.sccpAssets ?? [],
            this.options.t3Hub,
            this.options.t3Root,
            this.options.perpsEngine,
            this.options.perpsEngineCodeHash,
            this.options.optionVault,
            this.options.optionCodeHashes,
            this.options.t3RedemptionBinding,
            this.options.launchpadCodeHashes,
            this.options.launchpadControllers,
          );
          const graph = await builder.build(
            account,
            generation,
            ownerCheckedAt,
          );
          const projection = await projectOwnerLedger({
            network: this.network,
            owner: account,
            opcodes: this.opcodes,
            ...graph,
          });
          return {
            graph,
            projection,
            related: [...graph.chains.values()].map(
              ({ transactions, checkedAt, ...chain }) => chain,
            ),
          };
        };
        let prepared: Awaited<ReturnType<typeof build>> | undefined;
        if (
          project &&
          previous?.complete &&
          (head?.lt ?? null) === previous.head_lt &&
          (head?.hash ?? null) === previous.head_hash
        ) {
          prepared = await build(previous.current_generation, observedAt);
          const old = (
            await this.store.pool.query(
              "SELECT fingerprint,projection_scope FROM ledger_projection_coverage WHERE generation=$1",
              [previous.current_generation],
            )
          ).rows[0];
          if (
            validProjectionScope(old?.projection_scope, account) &&
            JSON.stringify(old.projection_scope.physicalAccounts) === JSON.stringify(prepared.projection.projectionScope.physicalAccounts) &&
            old.fingerprint ===
            projectionFingerprint(
              prepared.projection,
              prepared.related,
              prepared.graph.issues,
            )
          ) {
            await this.store.pool.query(
              "UPDATE ledger_accounts SET attempted_at=now(),synced_at=now(),checked_at=$3,syncing=false,error_code=NULL WHERE network=$1 AND account=$2",
              [this.network, account, prepared.graph.checkedAt ?? observedAt],
            );
            return;
          }
        }
        const unfinished = previous?.latest_generation
          ? (
              await this.store.pool.query(
                "SELECT generation,next_lt::text,next_hash,source_complete FROM ledger_runs WHERE generation=$1 AND complete=false",
                [previous.latest_generation],
              )
            ).rows[0]
          : null;
        const generation = unfinished?.generation ?? randomUUID();
        if (!unfinished)
          await this.store.begin(
            this.network,
            account,
            generation,
            head,
            observedAt,
          );
        else
          await this.store.pool.query(
            "UPDATE ledger_accounts SET attempted_at=now(),syncing=true,error_code=NULL WHERE network=$1 AND account=$2",
            [this.network, account],
          );
        const finish = async () => {
          await this.store.pool.query(
            "UPDATE ledger_runs SET source_complete=true,next_lt=NULL,next_hash=NULL WHERE generation=$1",
            [generation],
          );
          let checkedAt: string | null = null;
          if (project) {
            const result = prepared ?? (await build(generation));
            checkedAt = result.graph.checkedAt;
            const related = result.related.map((chain) =>
              chain.role === "owner" ? { ...chain, generation } : chain,
            );
            await this.store.project(
              generation,
              result.projection,
              related,
              result.graph.issues,
            );
          }
          await this.store.complete(
            this.network,
            account,
            generation,
            checkedAt,
          );
        };
        if (unfinished?.source_complete) {
          await finish();
          return;
        }
        if (!head && !unfinished) {
          await finish();
          return;
        }
        if (
          !unfinished &&
          previous?.complete &&
          head?.lt === previous.head_lt &&
          head?.hash === previous.head_hash &&
          (await this.store.copyKnownTail(
            generation,
            previous.current_generation,
            head!.lt,
            head!.hash,
          ))
        ) {
          await finish();
          return;
        }
        let cursor = unfinished
          ? { lt: unfinished.next_lt, hash: unfinished.next_hash }
          : head!;
        const seen = new Set<string>();
        while (!this.stopped) {
          if (budget.pages <= 0) {
            await this.store.failed(
              this.network,
              account,
              "backfill_capacity_deferred",
            );
            return;
          }
          budget.pages--;
          const key = `${cursor.lt}:${cursor.hash}`;
          if (seen.has(key)) throw new Error("history_cursor_stalled");
          seen.add(key);
          const raw = await this.source.getTransactions(
            account,
            100,
            cursor.lt,
            cursor.hash,
          );
          if (
            !raw.length ||
            raw.length > 100 ||
            !transactionPageIsLinkedInclusiveSegment(
              raw,
              cursor,
              raw[raw.length - 1],
            )
          )
            throw new Error("history_chain_unverified");
          const events = [];
          for (const tx of raw)
            events.push(
              await normalizeLedgerEvent(
                this.network,
                account,
                tx,
                this.opcodes,
                (wallet) => this.resolveJetton(wallet),
              ),
            );
          await this.store.append(generation, events, raw);
          const tail = raw[raw.length - 1];
          if (
            transactionPageReachesHistoryStart(raw, cursor) ||
            (previous?.current_generation &&
              (await this.store.copyKnownTail(
                generation,
                previous.current_generation,
                tail.lt,
                canonicalLedgerHash(tail.hash),
              )))
          ) {
            await this.store.pool.query(
              "UPDATE ledger_runs SET source_complete=true,next_lt=NULL,next_hash=NULL WHERE generation=$1",
              [generation],
            );
            await finish();
            return;
          }
          if (!tail.prevTransactionLt || !tail.prevTransactionHash)
            throw new Error("history_predecessor_unavailable");
          cursor = {
            lt: tail.prevTransactionLt,
            hash: canonicalLedgerHash(tail.prevTransactionHash),
          };
          await this.store.pool.query(
            "UPDATE ledger_runs SET next_lt=$2,next_hash=$3 WHERE generation=$1",
            [generation, cursor.lt, cursor.hash],
          );
        }
        throw new Error("history_sync_interrupted");
      } catch (error) {
        const known = [
          "head_unavailable",
          "history_cursor_stalled",
          "history_chain_unverified",
          "history_predecessor_unavailable",
          "history_sync_interrupted",
        ];
        const code =
          error instanceof Error && known.includes(error.message)
            ? error.message
            : "history_source_unavailable";
        await this.store.failed(this.network, account, code);
        throw error;
      }
    });
  }

  private resolveJetton(wallet: string): Promise<LedgerAsset | null> {
    if (this.identityCache.size > 1000) this.identityCache.clear();
    let entry = this.identityCache.get(wallet);
    if (!entry || entry.expiresAt <= Date.now()) {
      entry = {
        expiresAt: Date.now() + 30_000,
        promise: this.loadJettonIdentity(wallet).catch(() => null),
      };
      this.identityCache.set(wallet, entry);
    }
    return entry.promise;
  }

  private async loadJettonIdentity(
    wallet: string,
  ): Promise<LedgerAsset | null> {
    const result = await this.source.runGetMethod(wallet, "get_wallet_data");
    if (!result || result.exitCode !== 0 || result.stack.length !== 4)
      return null;
    const [balance, ownerItem, rootItem] = result.stack;
    if (
      balance.type !== "int" ||
      balance.value < 0n ||
      !["cell", "slice", "builder"].includes(ownerItem.type) ||
      !["cell", "slice", "builder"].includes(rootItem.type)
    )
      return null;
    if (!("cell" in ownerItem) || !("cell" in rootItem)) return null;
    const ownerSlice = ownerItem.cell.beginParse();
    const rootSlice = rootItem.cell.beginParse();
    const owner = ownerSlice.loadAddress().toRawString();
    const master = rootSlice.loadAddress().toRawString();
    if (
      ownerSlice.remainingBits ||
      ownerSlice.remainingRefs ||
      rootSlice.remainingBits ||
      rootSlice.remainingRefs
    )
      return null;
    // The source validates root getter, wallet address, owner, and deployed code.
    const verified = await this.source.getJettonBalance(owner, master);
    if (
      !verified ||
      canonicalLedgerAddress(verified.wallet) !== canonicalLedgerAddress(wallet)
    )
      return null;
    const metadata = await this.source.getJettonMetadata(master);
    return {
      kind: "jetton",
      id: `${this.network}:jetton:${master}`,
      master,
      wallet: canonicalLedgerAddress(wallet),
      owner,
      symbol: metadata?.symbol,
      decimals: metadata?.decimals,
    };
  }
}
