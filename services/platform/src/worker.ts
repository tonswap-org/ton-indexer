import { stageTime } from './notificationEvidence.js';
import { currentLedgerNotification } from './currentLedgerNotifications.js';
import { governanceNotificationLink, NOTIFICATION_DESTINATIONS, walletNotificationLink } from './notificationLinks.js';
import { ledgerDiscoverySchema, type LedgerEvent } from './ledger.js';
export type { LedgerEvent } from './ledger.js';
import { randomUUID } from 'node:crypto';
import { Decimal } from './decimal.js';
import { z } from 'zod';
import type { Config } from './config.js';
import type { AlertQuote, AlertQuotesResponse, Job, Network } from './types.js';
import { DexPrices } from './dexPrices.js';
import { AlertObservations } from './alertObservations.js';
import { alertAssetKey } from './alertAssets.js';
import { Store, normalizeAddress, iso, type NewNotification, type WatchedPriceRule } from './store.js';
import { assessPriceObservation } from './priceMonitoring.js';
import { Providers } from './providers.js';
import { PushSender, validateApplicationServerKey } from './push.js';
import { ApiError } from './errors.js';
import { assessGovernanceObservation, governanceBinding, type GovernanceHead, type GovernanceProposalObservation } from './governanceObservations.js';
import { fetchJson, ordinaryJson, record, type Fetcher } from './http.js';

/** No action hint or minimum-output field is accepted as evidence of a fill. */
export function ledgerNotification(event: LedgerEvent): NewNotification | null {
  if (event.status === 'pending') return null;
  const evidence = { ledgerEventId: event.id, account: event.account, lt: event.lt, hash: event.hash,
    transactionStatus: event.status, decodingIssues: event.issues };
  const common = { href: walletNotificationLink(event.txId), occurredAt: new Date(event.utime * 1000).toISOString(), evidence: { ...evidence, txId: event.txId } };
  if (event.status === 'failed') return { ...common, category: 'walletProtocol', sourceEventId: `ledger:${event.id}:failed`,
    title: 'Wallet transaction failed', body: 'A transaction failed on-chain. Open your wallet history for details.' };
  const settlement = event.settlement;
  const currentNotice = currentLedgerNotification(event, common);
  if (currentNotice !== undefined) return currentNotice;
  const bridge = settlement?.bridge;
  if (settlement?.status === 'confirmed' && settlement.protocol === 'sccp' && bridge?.tonOwner === event.account &&
    bridge.counterpartyStatus === 'unverified' && BigInt(bridge.amountRaw) > 0n && event.kind === settlement.operation &&
    ((settlement.operation === 'bridge_burn' && bridge.localStage === 'burned') || (settlement.operation === 'bridge_mint' && bridge.localStage === 'minted'))) {
    const burning = bridge.localStage === 'burned';
    const principal = event.movements.some(item => item.direction === (burning ? 'out' : 'in') && item.asset.kind === 'jetton' &&
      item.asset.master === bridge.tonMaster && item.amountRaw === bridge.amountRaw &&
      item.evidence?.kind === (burning ? 'sccp_burn_record' : 'sccp_mint'));
    if (principal && settlement.evidence.some(item => item.account === bridge.tonWallet || item.account === bridge.tonMaster)) return {
      ...stageTime(common, settlement.evidence), category: 'walletProtocol', sourceEventId: `bridge:${bridge.tonMaster}:${bridge.sourceDomain}:${bridge.destinationDomain}:${bridge.messageId ?? bridge.nonce ?? event.txId}:${bridge.localStage}`,
      title: burning ? 'Bridge burn recorded on TON' : 'Bridge mint recorded on TON',
      body: burning ? 'The TON burn was verified. Receipt on the destination chain remains unverified.' : 'The TON mint was verified. The source-chain burn remains unverified.',
      evidence: { ...stageTime(common, settlement.evidence).evidence, settlement, movements: event.movements },
    };
  }
  return { ...common, category: 'walletProtocol', sourceEventId: `ledger:${event.id}:confirmed`,
    title: 'Wallet transaction confirmed', body: 'A transaction was confirmed on-chain. Product settlement may still be pending.' };
}
export function ledgerNotifications(event: LedgerEvent): NewNotification[] {
  const notice = ledgerNotification(event);
  return notice ? [notice] : [];
}
export function priceDirection(change24h: string, threshold = '5', direction = 'both'): 'up' | 'down' | 'inside' {
  const change = new Decimal(change24h);
  if (direction !== 'below' && change.gte(threshold)) return 'up';
  if (direction !== 'above' && change.lte(new Decimal(threshold).neg())) return 'down'; return 'inside';
}
export function shouldNotifyCrossing(input: { previous: string | null; next: string;
  lastNotifiedAt: string | null; observedAt: string }): boolean {
  return input.previous !== null && input.next !== 'inside' && input.next !== input.previous &&
    (!input.lastNotifiedAt || Date.parse(input.observedAt) - Date.parse(input.lastNotifiedAt) >= 24 * 3600_000);
}
type WalletCheckpoint = { since: string; afterRevision: string; cursor: string | null;
  throughRevision?: string; generation?: string; publishedAt?: string; headObservedAt?: string; checkedAt?: string };
type GovernanceProposalCheckpoint = Pick<GovernanceProposalObservation, 'status' | 'actionsHash' | 'descriptionHash' | 'proposer' | 'class' | 'start' | 'valueTotalRaw'>;
type GovernanceCheckpoint = { schema: 'current-governance-monitor-v1'; proposals: Record<string, GovernanceProposalCheckpoint>;
  initialized: boolean; nextStartId: string; nextProposalId: string; head: GovernanceHead; dataHash: string };

export class Worker {
  readonly id = `worker:${randomUUID()}`;
  private stopped = false;
  private readonly observations: AlertObservations;
  constructor(private config: Config, private store: Store, providers: Providers,
    private push: PushSender, private fetcher: Fetcher = fetch, private clock: () => Date = () => new Date()) {
    this.observations = new AlertObservations(config, new DexPrices(config, fetcher, clock), clock);
  }
  async initialize(): Promise<void> {
    await this.store.enqueue(this.store.db, 'retention', 'retention', {}, true);
    // Reconcile durable scheduled work from saved preferences after a fresh deployment or worker recovery.
    const preferences = await this.store.db.query<{ wallet_address: string; network: Network }>(`SELECT wallet_address,network
      FROM platform_preferences WHERE preferences->>'activity'='true' OR preferences->>'walletProtocol'='true'`);
    for (const item of preferences.rows) await this.store.enqueue(this.store.db, 'poll_wallet', `wallet:${item.network}:${item.wallet_address}`,
      { walletAddress: item.wallet_address, network: item.network }, true);
    await this.store.enqueue(this.store.db, 'price_scan', 'prices', {}, true);
    for (const network of this.config.networks) if (governanceBinding(this.config, network))
      await this.store.enqueue(this.store.db, 'poll_governance', `governance:${network}`, { network }, true);
  }
  stop(): void { this.stopped = true; }
  async run(): Promise<void> {
    await this.initialize();
    while (!this.stopped) {
      try { await this.tick(); }
      catch { await this.store.db.query('INSERT INTO platform_worker_status(id,last_error) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET last_seen_at=now(),last_error=$2', [this.id, 'worker_cycle_failed']).catch(() => {}); }
      if (!this.stopped) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  async tick(): Promise<number> {
    const jobs = await this.store.lease(this.id, this.config.workerConcurrency);
    await Promise.all(jobs.map(async job => {
      let lostLease = false;
      const heartbeat = setInterval(() => { void this.store.heartbeat(job).then(owned => { if (!owned) lostLease = true; }).catch(() => { lostLease = true; }); }, 20_000);
      try {
        const next = await this.handle(job);
        if (!lostLease) await this.store.finish(job, next);
      } catch (error) {
        const status = record(error).statusCode;
        const errorCode = typeof record(error).code === 'string' ? String(record(error).code) : 'job_failed';
        // Do not retain provider errors containing subscription endpoints, API keys, or raw HTTP response bodies.
        await this.store.fail(job, errorCode, status === 429 ? 300 : undefined);
      } finally { clearInterval(heartbeat); }
    }));
    return jobs.length;
  }
  async handle(job: Job): Promise<number | undefined> {
    if (job.kind === 'retention') { await this.store.cleanup(); return 3600; }
    if (job.kind === 'price_scan') { await this.scanPrices(job); return this.config.priceSeconds; }
    if (job.kind === 'poll_wallet') return this.pollWallet(job);
    if (job.kind === 'poll_governance') return this.pollGovernance(job);
    if (job.kind === 'deliver_push') await this.deliver(job);
    return undefined;
  }
  private indexer(network: Network): string {
    const url = this.config.indexerUrls[network]; if (!url) throw new Error('indexer_not_configured'); return url;
  }
  private headers(): Record<string, string> { return this.config.indexerApiKey ? { authorization: `Bearer ${this.config.indexerApiKey}` } : {}; }
  async pollWallet(job: Job): Promise<number | undefined> {
    const network = z.enum(['mainnet', 'testnet']).parse(job.payload.network);
    const wallet = normalizeAddress(z.string().parse(job.payload.walletAddress));
    const boundaries = Object.values(await this.store.walletMonitoring(wallet, network)).filter((value): value is string => value !== null);
    if (!boundaries.length) return undefined;
    const since = new Date(Math.min(...boundaries.map(value => Date.parse(value)))).toISOString();
    const checkpointKey = `ledger-discovery:${network}:${wallet}`;
    const previous = await this.store.checkpoint<WalletCheckpoint>(checkpointKey);
    // A changed category epoch replays eligible discovery evidence, while each
    // category's independent epoch and stable source keys suppress old notices.
    const state: WalletCheckpoint = previous?.since === since ? previous : { since, afterRevision: '0', cursor: null };
    const retry = async (reason: string) => this.store.db.transaction(async sql => {
      await this.store.assertLease(sql, job);
      await this.store.setCheckpoint(checkpointKey, { since, afterRevision: state.afterRevision, cursor: null }, sql);
      await this.store.setCheckpoint(`ledger-coverage:${network}:${wallet}`, { reason, fetchedAt: new Date().toISOString() }, sql);
    });
    const target = new URL(`${this.indexer(network)}/accounts/${encodeURIComponent(wallet)}/ledger/discoveries`);
    target.searchParams.set('since', since); target.searchParams.set('after_revision', state.afterRevision); target.searchParams.set('limit', '100');
    if (state.cursor) target.searchParams.set('cursor', state.cursor);
    let raw: unknown;
    try { raw = await fetchJson(target, { headers: this.headers() }, this.fetcher); }
    catch (error) {
      if (state.cursor && record(error).upstreamStatus === 400) await retry('cursor_expired_or_invalid');
      throw error;
    }
    const page = ledgerDiscoverySchema.parse(ordinaryJson(raw));
    if (page.network !== network || page.account !== wallet || page.since !== since) throw new Error('indexer_scope_mismatch');
    const coverage = page.coverage;
    if (!coverage.snapshotComplete || !coverage.historyComplete || !coverage.generation || !coverage.publishedAt || !coverage.headObservedAt || !coverage.checkedAt) {
      await retry('snapshot_incomplete'); return this.config.pollSeconds;
    }
    if (state.cursor && (state.generation !== coverage.generation || state.throughRevision !== page.throughRevision ||
      state.publishedAt !== coverage.publishedAt || state.headObservedAt !== coverage.headObservedAt)) {
      await retry('snapshot_generation_changed'); return this.config.pollSeconds;
    }
    const checkedAt = state.cursor ? state.checkedAt : coverage.checkedAt;
    const checked = checkedAt ? Date.parse(checkedAt) : NaN;
    if (!Number.isFinite(checked) || Date.parse(coverage.publishedAt) > Date.now() || Date.parse(coverage.headObservedAt) > Date.parse(coverage.publishedAt) ||
      checked > Date.now() || (!state.cursor && Date.now() - checked > 300_000)) {
      await retry('snapshot_stale'); return this.config.pollSeconds;
    }
    if (page.nextCursor && page.nextCursor === state.cursor) throw new Error('indexer_cursor_stalled');
    let lastRevision = BigInt(state.afterRevision);
    if (BigInt(page.throughRevision) < lastRevision) throw new Error('indexer_discovery_regressed');
    for (const revision of page.revisions) {
      const event = revision.event;
      const evidenceUtime = Math.max(event.utime, ...(event.settlement?.evidence ?? []).map(ref => ref.utime));
      if (BigInt(revision.revision) <= lastRevision || BigInt(revision.revision) > BigInt(page.throughRevision) ||
        event.network !== network || normalizeAddress(event.account) !== wallet || revision.evidenceUtime !== evidenceUtime ||
        Date.parse(revision.discoveredAt) > Date.parse(coverage.publishedAt) ||
        (Date.parse(revision.discoveredAt) < Date.parse(since) && evidenceUtime * 1000 < Date.parse(since)))
        throw new Error('indexer_event_scope_mismatch');
      lastRevision = BigInt(revision.revision);
    }
    if (page.nextCursor && !page.revisions.length) throw new Error('indexer_cursor_without_progress');
    await this.store.db.transaction(async sql => {
      await this.store.assertLease(sql, job);
      for (const revision of page.revisions) {
        for (const notice of ledgerNotifications(revision.event)) {
          if (Date.parse(notice.occurredAt) > Date.now()) throw new Error('notification_stage_time_invalid');
          await this.store.emit(wallet, network, { ...notice, evidence: { ...notice.evidence,
            discovery: { revision: revision.revision, generation: revision.generation, discoveredAt: revision.discoveredAt } } }, { sql });
        }
      }
      const next: WalletCheckpoint = { since, afterRevision: page.nextCursor ? lastRevision.toString() : page.throughRevision,
        cursor: page.nextCursor, throughRevision: page.throughRevision, generation: coverage.generation!,
        publishedAt: coverage.publishedAt!, headObservedAt: coverage.headObservedAt!, checkedAt };
      await this.store.setCheckpoint(checkpointKey, next, sql);
      await this.store.setCheckpoint(`ledger-coverage:${network}:${wallet}`, { ...coverage, fetchedAt: new Date().toISOString() }, sql);
    });
    return page.nextCursor ? 1 : this.config.pollSeconds;
  }
  async scanPrices(job: Job): Promise<void> {
    const rules = await this.store.watchedRules();
    const assets = [...new Map(rules.map(rule => [alertAssetKey(rule.asset), rule.asset])).values()];
    for (let offset = 0; offset < assets.length; offset += 50) {
      const batchAssets = assets.slice(offset, offset + 50), batchKeys = new Set(batchAssets.map(alertAssetKey));
      const startedAt = this.clock().toISOString();
      // Provider failure is a durable monitoring outcome, not a successful scan
      // that silently leaves an enabled definition looking operational.
      let response: AlertQuotesResponse;
      try { response = await this.observations.prices(batchAssets); }
      catch { response = { currency: 'T3', quoteAssetId: null, requestedAt: this.clock().toISOString(), issues: ['provider_unavailable'],
        quotes: batchAssets.map(asset => ({ asset, currency: null, quoteAssetId: null, price: null, observedAt: null, source: null,
          stale: true, status: 'unavailable', change24h: null, evidence: {}, issue: 'provider_unavailable' })) }; }
      for (const rule of rules.filter(rule => batchKeys.has(alertAssetKey(rule.asset)))) {
        const quotes = response.quotes.filter(quote => alertAssetKey(quote.asset) === alertAssetKey(rule.asset));
        await this.applyPrice(rule, quotes.length === 1 ? quotes[0]! : null,
          { startedAt, currency: response.currency }, job);
      }
    }
  }
  async applyPrice(watched: WatchedPriceRule, quote: AlertQuote | null, scan: { startedAt: string; currency: string }, job: Job): Promise<void> {
    if (job.kind !== 'price_scan' || job.dedupeKey !== 'prices') throw new Error('price_scan_lease_required');
    await this.store.db.transaction(async sql => {
      await this.store.assertLease(sql, job);
      const consent = (await sql.query<{ enabled: boolean }>(`SELECT (preferences->>'priceAlerts')::boolean AS enabled
        FROM platform_preferences WHERE wallet_address=$1 AND network=$2 FOR UPDATE`, [watched.walletAddress, watched.network])).rows[0];
      if (!consent?.enabled) return;
      const rule = (await sql.query<{ wallet_address: string; network: Network; enabled: boolean; last_direction: string | null;
        currency: string; quote_asset_id: string; release_manifest_hash: string; kind: 'percent' | 'target'; threshold_percent: string | null; target_price: string | null; direction: 'above' | 'below' | 'both';
        last_notified_at: Date | string | null; last_observed_at: Date | string | null; revision: string }>(`SELECT *,updated_at::text AS revision
        FROM platform_price_rules WHERE id=$1 AND wallet_address=$2 AND network=$3 AND asset_kind=$4 AND asset_id=$5 FOR UPDATE`,
      [watched.id, watched.walletAddress, watched.network, watched.asset.kind,
        watched.asset.kind === 'listed' ? watched.asset.coinGeckoId : watched.asset.assetId])).rows[0];
      if (watched.asset.kind === 'ton' && watched.asset.network !== watched.network) return;
      if (!rule?.enabled || rule.revision !== watched.revision || rule.kind !== watched.kind) return;
      const checkedAt = this.clock().toISOString(), started = Date.parse(scan.startedAt);
      if (!Number.isFinite(started) || started > Date.parse(checkedAt)) throw new Error('price_scan_time_invalid');
      const previous = (await sql.query<{ started_at: Date | string }>('SELECT started_at FROM platform_price_rule_monitoring WHERE rule_id=$1 AND definition_revision=$2', [watched.id, watched.revision])).rows[0];
      if (previous && Date.parse(iso(previous.started_at)) > started) return;
      let observation = assessPriceObservation(watched.asset, watched.kind, quote, scan.currency, Date.parse(checkedAt), rule.quote_asset_id);
      if (this.config.dexRelease?.network !== watched.network || scan.currency !== rule.currency || (quote?.status === 'available' && record(quote.evidence.release).manifestHash !== rule.release_manifest_hash) ||
          rule.release_manifest_hash !== this.config.dexRelease?.manifestHash)
        observation = { ...observation, outcome: 'unavailable', issue: 'dex_rule_binding_mismatch' };
      if (observation.outcome === 'observed' && rule.last_observed_at && Date.parse(iso(rule.last_observed_at)) > Date.parse(observation.observed_at!))
        observation = { ...observation, outcome: 'unavailable', issue: 'observation_regressed' };
      await sql.query(`INSERT INTO platform_price_rule_monitoring(rule_id,definition_revision,started_at,checked_at,observed_at,source,outcome,issue)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(rule_id) DO UPDATE SET definition_revision=EXCLUDED.definition_revision,
        started_at=EXCLUDED.started_at,checked_at=EXCLUDED.checked_at,observed_at=EXCLUDED.observed_at,source=EXCLUDED.source,outcome=EXCLUDED.outcome,issue=EXCLUDED.issue`,
      [watched.id, watched.revision, scan.startedAt, checkedAt, observation.observed_at, observation.source, observation.outcome, observation.issue]);
      // Repeated cached observations refresh check time, never the crossing
      // baseline or its market timestamp. Failures preserve the same baseline.
      if (observation.outcome !== 'observed' || !quote || rule.last_observed_at && Date.parse(iso(rule.last_observed_at)) === Date.parse(quote.observedAt!)) return;
      const next = rule.kind === 'percent' ? priceDirection(quote.change24h!, rule.threshold_percent!, rule.direction) :
        rule.direction === 'above' ? (new Decimal(quote.price!).gte(rule.target_price!) ? 'up' : 'inside') :
          (new Decimal(quote.price!).lte(rule.target_price!) ? 'down' : 'inside');
      const notify = shouldNotifyCrossing({ previous: rule.last_direction, next,
        lastNotifiedAt: rule.last_notified_at ? iso(rule.last_notified_at) : null, observedAt: quote.observedAt! });
      const assetLabel = watched.asset.kind === 'listed' ? watched.asset.coinGeckoId :
        watched.asset.assetId === 'native' ? `GRAM (${watched.asset.network})` : `TONSwap asset ${watched.asset.assetId}`;
      const emitted = notify ? await this.store.emit(rule.wallet_address, rule.network, { category: 'priceAlerts',
        sourceEventId: `price:${watched.id}:${quote.observedAt}:${next}`, title: rule.kind === 'percent'
          ? `${assetLabel} moved ${next === 'up' ? 'up' : 'down'} ${rule.threshold_percent}%`
          : `${assetLabel} crossed your target price`,
        body: rule.kind === 'percent' ? `${new Decimal(quote.change24h!).abs().toFixed(2)}% over the last 24 hours. Open TONSWAP to review.`
          : `The price crossed ${rule.direction} ${rule.target_price} ${rule.currency}. Open TONSWAP to review.`,
        href: NOTIFICATION_DESTINATIONS.swap, occurredAt: quote.observedAt!, evidence: { source: quote.source, asset: quote.asset, valuationEvidence: quote.evidence,
          observedAt: quote.observedAt, change24h: quote.change24h, price: quote.price, currency: rule.currency, quoteAssetId: rule.quote_asset_id, manifestHash: rule.release_manifest_hash,
          ruleKind: rule.kind, thresholdPercent: rule.threshold_percent, targetPrice: rule.target_price } }, { sql }) : null;
      await sql.query(`UPDATE platform_price_rules SET last_direction=$2,last_observed_at=$3,
        last_notified_at=CASE WHEN $4::boolean THEN $3::timestamptz ELSE last_notified_at END WHERE id=$1`,
      [watched.id, next, quote.observedAt, Boolean(emitted)]);
    });
  }
  async pollGovernance(job: Job): Promise<number | undefined> {
    const network = z.enum(['mainnet', 'testnet']).parse(job.payload.network);
    if (job.kind !== 'poll_governance' || job.dedupeKey !== `governance:${network}`) throw Error('governance_lease_required');
    const binding = governanceBinding(this.config, network); if (!binding) return undefined;
    const { release, contract } = binding;
    const checkpointKey = `governance:${network}:${release.manifestHash}:${contract.address}`;
    const previous = await this.store.checkpoint<GovernanceCheckpoint>(checkpointKey);
    if (previous && previous.schema !== 'current-governance-monitor-v1') throw Error('governance_checkpoint_invalid');
    const startId = previous?.nextStartId ?? '1';
    const target = new URL(`${release.indexerUrl}/governance/${encodeURIComponent(contract.address)}/snapshot`);
    target.searchParams.set('max_scan', '64'); target.searchParams.set('start_id', startId);
    const raw = ordinaryJson(await fetchJson(target, { headers: { ...this.headers(), 'x-tonswap-release': release.manifestHash } },
      async (url, init) => {
        const response = await this.fetcher(url, init);
        if (response.headers.get('x-tonswap-release') !== release.manifestHash) {
          await response.body?.cancel().catch(() => {}); throw Error('governance_release_mismatch');
        }
        return response;
      }));
    const response = assessGovernanceObservation(raw, this.config, network, startId, this.clock().getTime(), previous);
    await this.store.db.transaction(async sql => {
      await this.store.assertLease(sql, job);
      // Database contention cannot turn an expired current observation into a fresh notice.
      assessGovernanceObservation(response, this.config, network, startId, this.clock().getTime(), previous);
      const subscribers = await sql.query<{ wallet_address: string }>("SELECT wallet_address FROM platform_preferences WHERE network=$1 AND preferences->>'governance'='true'", [network]);
      const state: GovernanceCheckpoint = { schema: 'current-governance-monitor-v1', proposals: { ...previous?.proposals },
        initialized: Boolean(previous?.initialized) || response.page.nextStartId === null,
        nextStartId: response.page.nextStartId ?? '1', nextProposalId: response.nextProposalId, head: response.asOf, dataHash: response.dataHash };
      const observedAt = new Date(response.asOf.utime * 1000).toISOString();
      const evidence = { schema: response.schema, releaseId: release.releaseId, manifestHash: release.manifestHash,
        governance: contract.address, codeHash: response.codeHash, dataHash: response.dataHash, asOf: response.asOf,
        source: 'ton-indexer', targetExecution: 'unverified', page: response.page };
      for (const proposal of response.proposals) {
        const old = previous?.proposals[proposal.id];
        if (old && (old.actionsHash !== proposal.actionsHash || old.descriptionHash !== proposal.descriptionHash ||
          old.proposer !== proposal.proposer || old.class !== proposal.class || old.start !== proposal.start ||
          old.valueTotalRaw !== proposal.valueTotalRaw)) throw Error('governance_proposal_changed_identity');
        if (previous?.initialized && (!old || old.status !== proposal.status)) {
          const body = proposal.status === 'queued'
            ? 'The proposal is queued. Execution of its target actions remains unverified.'
            : proposal.status === 'closed'
              ? 'Voting has closed. This does not establish approval, queueing or target execution.'
              : proposal.status === 'expired'
                ? 'The proposal is expired in the current snapshot. Target execution remains unverified.'
                : 'A current on-chain governance proposal is open for voting.';
          for (const subscriber of subscribers.rows) await this.store.emit(subscriber.wallet_address, network, {
            category: 'governance', sourceEventId: `governance:${release.manifestHash}:${contract.address}:${proposal.id}:${proposal.status}`,
            title: old ? `Proposal ${proposal.id} updated` : `New governance proposal ${proposal.id}`,
            body, href: governanceNotificationLink(proposal.id), occurredAt: observedAt,
            evidence: { ...evidence, proposalId: proposal.id, previousStatus: old?.status ?? null, status: proposal.status, proposal } }, { sql });
        }
        state.proposals[proposal.id] = { status: proposal.status, actionsHash: proposal.actionsHash, descriptionHash: proposal.descriptionHash,
          proposer: proposal.proposer, class: proposal.class, start: proposal.start, valueTotalRaw: proposal.valueTotalRaw };
      }
      for (const id of response.prunedProposalIds) {
        const old = previous?.proposals[id];
        if (previous?.initialized && old) {
          for (const subscriber of subscribers.rows) await this.store.emit(subscriber.wallet_address, network, {
            category: 'governance', sourceEventId: `governance:${release.manifestHash}:${contract.address}:${id}:pruned`,
            title: `Proposal ${id} left active governance`,
            body: 'The proposal was pruned from current storage. Its terminal outcome and target execution remain unverified.',
            href: governanceNotificationLink(id), occurredAt: observedAt,
            evidence: { ...evidence, proposalId: id, previousStatus: old.status, status: 'unknown', pruned: true } }, { sql });
        }
        delete state.proposals[id];
      }
      await this.store.setCheckpoint(checkpointKey, state, sql);
      await this.store.setCheckpoint(`governance-coverage:${network}:${release.manifestHash}:${contract.address}`, { ...evidence, nextProposalId: response.nextProposalId,
        prunedProposalIds: response.prunedProposalIds, observedAt }, sql);
      // Roll back notices and checkpoints if any awaited transaction work exhausted freshness.
      assessGovernanceObservation(response, this.config, network, startId, this.clock().getTime(), previous);
    });
    return response.page.nextStartId ? 1 : 120;
  }
  async deliver(job: Job): Promise<void> {
    const subscriptionId = z.string().uuid().parse(job.payload.subscriptionId);
    const noticeId = z.string().uuid().parse(job.payload.notificationId);
    const applicationServerKey = z.string().parse(job.payload.applicationServerKey);
    validateApplicationServerKey(applicationServerKey);
    const subscription = await this.store.subscription(subscriptionId);
    if (!subscription?.active) return;
    if (subscription.walletAddress !== job.payload.walletAddress || subscription.network !== job.payload.network) return;
    if (subscription.applicationServerKey !== applicationServerKey) return;
    // A corrupted outbox reference must never load another wallet or network's
    // private inbox item. Returning completes this invalid job without retry.
    const notice = await this.store.notification(noticeId, subscription.walletAddress, subscription.network);
    if (!notice) return;
    if (!this.push.available) throw new ApiError(503, 'push_unavailable', 'Push delivery is not configured.');
    if (subscription.applicationServerKey !== this.config.vapidPublicKey) {
      await this.store.deliveryRegistration(job, subscription, 'vapid_key_changed'); return;
    }
    if (!job.payload.test && !await this.store.canNotify(subscription.walletAddress, subscription.network, notice)) return;
    if (!await this.store.deliveryRegistration(job, subscription, 'check')) return;
    try {
      await this.push.send(subscription, notice, this.config.appOrigins[0]!);
      await this.store.deliveryRegistration(job, subscription, subscription.applicationServerKey === this.config.vapidPublicKey ? 'sent' : 'vapid_key_changed');
    } catch (error) {
      const status = Number(record(error).statusCode);
      if (record(error).code === 'push_key_changed') {
        await this.store.deliveryRegistration(job, subscription, 'vapid_key_changed'); return;
      }
      if (status === 404 || status === 410 || record(error).code === 'expired_push_subscription') {
        await this.store.deliveryRegistration(job, subscription, 'provider_expired'); return;
      }
      throw error;
    }
  }
}
