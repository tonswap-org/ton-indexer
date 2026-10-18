import { randomUUID } from 'node:crypto';
import { Address } from '@ton/core';
import type { Config } from './config.js';
import type { Database, Sql } from './db.js';
import { ApiError } from './errors.js';
import { decrypt, encrypt, hash, token } from './crypto.js';
import { priceMonitoring, type PriceMonitoringRecord } from './priceMonitoring.js';
import { alertAssetSchema } from './alertAssetSchema.js';
import { alertCapabilities } from './alertCapabilities.js';
import { DEFAULT_PREFERENCES, type AlertAsset, type Category, type Job, type Network, type Notification, type Preferences,
  type PriceRule, type PriceRuleInput, type PushSubscriptionRecord, type Session, type SubscriptionInput } from './types.js';

export const iso = (value: Date | string): string => new Date(value).toISOString();
export function normalizeAddress(value: string): string {
  try { return Address.parse(value).toRawString(); } catch { throw new ApiError(400, 'invalid_address', 'Invalid TON wallet address.'); }
}
export const normalizeNetwork = (value: string): Network => {
  if (value === '-239' || value === 'mainnet') return 'mainnet';
  if (value === '-3' || value === 'testnet') return 'testnet';
  throw new ApiError(400, 'unsupported_network', 'Only configured TON mainnet/testnet networks are accepted.');
};
type NoticeRow = { id: string; category: Category; title: string; body: string; href: string;
  occurred_at: Date | string; created_at: Date | string; read_at: Date | string | null;
  source_event_id: string; evidence: Record<string, unknown> };
const notification = (row: NoticeRow): Notification => ({ id: row.id, category: row.category, title: row.title,
  body: row.body, href: row.href, occurredAt: iso(row.occurred_at), createdAt: iso(row.created_at),
  readAt: row.read_at ? iso(row.read_at) : null, sourceEventId: row.source_event_id, evidence: row.evidence });
export type NewNotification = Pick<Notification, 'category' | 'title' | 'body' | 'href' | 'occurredAt' | 'sourceEventId' | 'evidence'>;
export type WalletMonitoring = { activity: string | null; walletProtocol: string | null };
type PreferenceRow = { preferences: Preferences; activity_enabled_at: Date | string | null; wallet_protocol_enabled_at: Date | string | null };
type RuleRow = { currency: 'T3'; quote_asset_id: string; release_manifest_hash: string; id: string; wallet_address: string; network: Network; asset_kind: AlertAsset['kind']; asset_id: string; enabled: boolean;
  kind: 'percent' | 'target'; threshold_percent: string | null; target_price: string | null; direction: 'above' | 'below' | 'both';
  last_direction: 'up' | 'down' | 'inside' | null; last_notified_at: Date | string | null; last_observed_at: Date | string | null };
function ruleAsset(row: Pick<RuleRow, 'asset_kind' | 'asset_id' | 'network'>): AlertAsset {
  if (row.asset_kind === 'listed') return { kind: 'listed', coinGeckoId: row.asset_id };
  if (row.asset_kind === 'ton') return { kind: 'ton', network: row.network, assetId: row.asset_id };
  throw new Error('price_rule_asset_kind_invalid');
}
export interface WatchedPriceRule { id: string; asset: AlertAsset; kind: 'percent' | 'target'; revision: string; walletAddress: string; network: Network }
export const priceRule = (row: RuleRow, monitoring: PriceMonitoringRecord | null, categoryEnabled: boolean, config: Config): PriceRule => ({ id: row.id, asset: ruleAsset(row), enabled: row.enabled,
  capabilities: alertCapabilities(config, ruleAsset(row)),
  kind: row.kind, thresholdPercent: row.threshold_percent, targetPrice: row.target_price, direction: row.direction,
  currency: row.currency, quoteAssetId: row.quote_asset_id, releaseManifestHash: row.release_manifest_hash, windowHours: 24, cooldownHours: 24,
  lastNotifiedAt: row.last_notified_at ? iso(row.last_notified_at) : null, lastDirection: row.last_direction,
  monitoring: priceMonitoring({ enabled: row.enabled, categoryEnabled, record: monitoring, scanIntervalSeconds: config.priceSeconds,
    lastEvaluatedAt: row.last_observed_at ? iso(row.last_observed_at) : null, now: Date.now() }) });

export class Store {
  constructor(readonly db: Database, private config: Config) {}
  async createChallenge(address: string, network: Network, domain: string): Promise<{ payload: string; domain: string; expiresAt: string }> {
    const count = (await this.db.query<{ count: string }>(`SELECT count(*) FROM platform_challenges
      WHERE wallet_address=$1 AND created_at>now()-interval '5 minutes'`, [address])).rows[0];
    if (Number(count?.count) >= 15) throw new ApiError(429, 'challenge_rate_limit', 'Please wait before requesting another proof.');
    const payload = `tonswap-platform:${network}:${token()}`;
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    await this.db.query('INSERT INTO platform_challenges(payload_hash,wallet_address,network,domain,expires_at) VALUES($1,$2,$3,$4,$5)',
      [hash(payload), address, network, domain, expiresAt]);
    return { payload, domain, expiresAt };
  }
  async challenge(payload: string, address: string, network: Network): Promise<{ domain: string } | null> {
    return (await this.db.query<{ domain: string }>(`SELECT domain FROM platform_challenges
      WHERE payload_hash=$1 AND wallet_address=$2 AND network=$3 AND used_at IS NULL AND expires_at>now()`,
    [hash(payload), address, network])).rows[0] ?? null;
  }
  async createSession(payload: string, walletAddress: string, network: Network): Promise<Session & { token: string }> {
    return this.db.transaction(async sql => {
      const consumed = await sql.query(`UPDATE platform_challenges SET used_at=now()
        WHERE payload_hash=$1 AND wallet_address=$2 AND network=$3 AND used_at IS NULL AND expires_at>now() RETURNING payload_hash`,
      [hash(payload), walletAddress, network]);
      if (!consumed.rows.length) throw new ApiError(401, 'proof_replayed_or_expired', 'Request a new wallet proof.');
      const session: Session & { token: string } = { id: randomUUID(), walletAddress, network,
        expiresAt: new Date(Date.now() + this.config.sessionHours * 3600_000).toISOString(), csrfToken: token(), token: token() };
      await sql.query('INSERT INTO platform_sessions(id,token_hash,wallet_address,network,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [session.id, hash(session.token), walletAddress, network, session.csrfToken, session.expiresAt]);
      await sql.query(`INSERT INTO platform_preferences(wallet_address,network,preferences) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [walletAddress, network, JSON.stringify(DEFAULT_PREFERENCES)]);
      return session;
    });
  }
  async session(value: string): Promise<Session | null> {
    const row = (await this.db.query<{ id: string; wallet_address: string; network: Network; csrf_token: string; expires_at: Date | string }>(
      `SELECT id,wallet_address,network,csrf_token,expires_at FROM platform_sessions
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [hash(value)])).rows[0];
    return row ? { id: row.id, walletAddress: row.wallet_address, network: row.network, csrfToken: row.csrf_token, expiresAt: iso(row.expires_at) } : null;
  }
  async logout(session: Session): Promise<void> {
    await this.db.transaction(async sql => {
      await sql.query('UPDATE platform_sessions SET revoked_at=now() WHERE id=$1', [session.id]);
      await sql.query("UPDATE platform_subscriptions SET active=false,retired_at=now(),retirement_reason='session_logout' WHERE session_id=$1", [session.id]);
    });
  }
  async preferences(wallet: string, network: Network, sql: Sql = this.db): Promise<Preferences> {
    const row = (await sql.query<{ preferences: Preferences }>('SELECT preferences FROM platform_preferences WHERE wallet_address=$1 AND network=$2', [wallet, network])).rows[0];
    return { ...DEFAULT_PREFERENCES, ...row?.preferences };
  }
  private async preferenceState(wallet: string, network: Network, sql: Sql, lock = false) {
    const row = (await sql.query<PreferenceRow>(`SELECT preferences,activity_enabled_at,wallet_protocol_enabled_at FROM platform_preferences
      WHERE wallet_address=$1 AND network=$2${lock ? ' FOR UPDATE' : ''}`, [wallet, network])).rows[0];
    if (!row) return { preferences: { ...DEFAULT_PREFERENCES }, monitoring: { activity: null, walletProtocol: null } as WalletMonitoring };
    const monitoring: WalletMonitoring = { activity: row.activity_enabled_at === null ? null : iso(row.activity_enabled_at),
      walletProtocol: row.wallet_protocol_enabled_at === null ? null : iso(row.wallet_protocol_enabled_at) };
    if (row.preferences.activity !== (monitoring.activity !== null) || row.preferences.walletProtocol !== (monitoring.walletProtocol !== null))
      throw new Error('notification_enrollment_invalid');
    return { preferences: row.preferences, monitoring };
  }
  async walletMonitoring(wallet: string, network: Network, sql: Sql = this.db): Promise<WalletMonitoring> {
    return (await this.preferenceState(wallet, network, sql)).monitoring;
  }
  /** Current category consent and its independently persisted activation epoch.
   * Event times and activation boundaries both use the ledger's second precision. */
  async canNotify(wallet: string, network: Network, notice: Pick<NewNotification, 'category' | 'occurredAt'>,
    sql: Sql = this.db, lock = false): Promise<boolean> {
    const state = await this.preferenceState(wallet, network, sql, lock);
    if (!state.preferences[notice.category]) return false;
    if (notice.category !== 'activity' && notice.category !== 'walletProtocol') return true;
    const enabledAt = state.monitoring[notice.category];
    return enabledAt !== null && Number.isFinite(Date.parse(notice.occurredAt)) && Date.parse(notice.occurredAt) >= Date.parse(enabledAt);
  }
  async setPreferences(session: Session, value: Partial<Preferences>): Promise<Preferences> {
    return this.db.transaction(async sql => {
      // Lock identities even when no job row exists yet. Enqueue and workers use
      // the same job-before-preference order; a concurrent creator cannot bypass it.
      for (const key of [`wallet:${session.network}:${session.walletAddress}`, `governance:${session.network}`, 'prices'].sort())
        await this.lockJobIdentity(sql, key);
      // Lock before reading both preferences and clock: a delayed concurrent edit
      // cannot overwrite another category or backdate its activation.
      const before = await this.preferenceState(session.walletAddress, session.network, sql, true);
      const preferences = { ...before.preferences, ...value };
      const now = (await sql.query<{ enabled_at: Date | string }>("SELECT date_trunc('second',clock_timestamp()) AS enabled_at")).rows[0]!.enabled_at;
      const enabled = (category: keyof WalletMonitoring) => preferences[category] ? before.monitoring[category] ?? iso(now) : null;
      await sql.query(`UPDATE platform_preferences SET preferences=$3::jsonb,activity_enabled_at=$4,wallet_protocol_enabled_at=$5,updated_at=clock_timestamp()
        WHERE wallet_address=$1 AND network=$2`, [session.walletAddress, session.network, JSON.stringify(preferences), enabled('activity'), enabled('walletProtocol')]);
      if (preferences.activity || preferences.walletProtocol) await this.enqueue(sql, 'poll_wallet',
        `wallet:${session.network}:${session.walletAddress}`, { walletAddress: session.walletAddress, network: session.network }, true);
      if (preferences.governance && this.config.governanceContracts[session.network]) await this.enqueue(sql, 'poll_governance',
        `governance:${session.network}`, { network: session.network }, true);
      if (preferences.priceAlerts) await this.enqueue(sql, 'price_scan', 'prices', {}, true);
      if (preferences.priceAlerts !== before.preferences.priceAlerts) await sql.query(`UPDATE platform_price_rules
        SET last_direction=NULL,last_observed_at=NULL,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
        WHERE wallet_address=$1 AND network=$2`, [session.walletAddress, session.network]);
      return preferences;
    });
  }
  async listSubscriptions(session: Session): Promise<unknown[]> {
    const rows = await this.db.query<{ id: string; device_name: string; active: boolean; created_at: Date | string; endpoint_hash: string;
      last_sent_at: Date | string | null; retirement_reason: string | null; application_server_key: string }>(`SELECT id,device_name,active,created_at,last_sent_at,retirement_reason,endpoint_hash,application_server_key
      FROM platform_subscriptions WHERE wallet_address=$1 AND network=$2 ORDER BY created_at DESC`, [session.walletAddress, session.network]);
    return rows.rows.map(row => ({ id: row.id, deviceName: row.device_name, active: row.active, createdAt: iso(row.created_at),
      lastSentAt: row.last_sent_at ? iso(row.last_sent_at) : null, retirementReason: row.retirement_reason, endpointHash: row.endpoint_hash, applicationServerKey: row.application_server_key }));
  }
  async saveSubscription(session: Session, input: SubscriptionInput, replacesSubscriptionId?: string): Promise<{ id: string; active: true; applicationServerKey: string }> {
    return this.db.transaction(async sql => {
      // Serialize this wallet's device limit and a shared browser endpoint's ownership transition.
      await sql.query('SELECT wallet_address FROM platform_preferences WHERE wallet_address=$1 AND network=$2 FOR UPDATE', [session.walletAddress, session.network]);
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [hash(input.endpoint)]);
      const existing = await sql.query<{ id: string; encrypted_subscription: string; wallet_address: string; network: Network; active: boolean }>(
        'SELECT id,encrypted_subscription,wallet_address,network,active FROM platform_subscriptions WHERE endpoint_hash=$1 FOR UPDATE', [hash(input.endpoint)]);
      if (existing.rows[0]) {
        const previous = decrypt<SubscriptionInput>(existing.rows[0].encrypted_subscription, this.config.encryptionKey);
        if (previous.keys.auth !== input.keys.auth || previous.keys.p256dh !== input.keys.p256dh || previous.applicationServerKey !== input.applicationServerKey)
          throw new ApiError(409, 'push_key_mismatch', 'Renew the browser subscription before registering it.');
      }
      const id = existing.rows[0]?.id ?? randomUUID();
      if (replacesSubscriptionId && replacesSubscriptionId !== id) await sql.query(`UPDATE platform_subscriptions
        SET active=false,retired_at=now(),retirement_reason='replaced',updated_at=now()
        WHERE id=$1 AND wallet_address=$2 AND network=$3`, [replacesSubscriptionId, session.walletAddress, session.network]);
      const total = await sql.query<{ count: string }>('SELECT count(*) FROM platform_subscriptions WHERE wallet_address=$1 AND network=$2 AND active', [session.walletAddress, session.network]);
      const alreadyActive = existing.rows[0]?.active && existing.rows[0].wallet_address === session.walletAddress && existing.rows[0].network === session.network;
      if (!alreadyActive && Number(total.rows[0]?.count) >= 12) throw new ApiError(409, 'device_limit', 'Remove an old notification device first.');
      // Browser subscription may change wallet only after proving the new wallet and presenting the same secret keys.
      await sql.query(`INSERT INTO platform_subscriptions(id,wallet_address,network,session_id,endpoint_hash,encrypted_subscription,device_name,application_server_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint_hash) DO UPDATE SET wallet_address=EXCLUDED.wallet_address,
        network=EXCLUDED.network,session_id=EXCLUDED.session_id,encrypted_subscription=EXCLUDED.encrypted_subscription,
        application_server_key=EXCLUDED.application_server_key,device_name=EXCLUDED.device_name,active=true,last_sent_at=NULL,retired_at=NULL,retirement_reason=NULL,updated_at=now()`,
      [id, session.walletAddress, session.network, session.id, hash(input.endpoint), encrypt(input, this.config.encryptionKey), input.deviceName ?? 'Browser', input.applicationServerKey]);
      return { id, active: true, applicationServerKey: input.applicationServerKey };
    });
  }
  async retireSubscription(id: string, reason: string, session?: Session): Promise<void> {
    const scope = session ? ' AND wallet_address=$3 AND network=$4' : '';
    await this.db.query(`UPDATE platform_subscriptions SET active=false,retired_at=now(),retirement_reason=$2,updated_at=now() WHERE id=$1${scope}`,
      session ? [id, reason, session.walletAddress, session.network] : [id, reason]);
  }
  async subscription(id: string): Promise<PushSubscriptionRecord | null> {
    const row = (await this.db.query<{ id: string; wallet_address: string; network: Network; encrypted_subscription: string; active: boolean; application_server_key: string }>(
      'SELECT id,wallet_address,network,encrypted_subscription,active,application_server_key FROM platform_subscriptions WHERE id=$1', [id])).rows[0];
    return row ? { ...decrypt<SubscriptionInput>(row.encrypted_subscription, this.config.encryptionKey), id: row.id,
      walletAddress: row.wallet_address, network: row.network, active: row.active, applicationServerKey: row.application_server_key,
      registrationIdentity: row.encrypted_subscription } : null;
  }
  /** Fence both the lease and exact registration around an external delivery. */
  async deliveryRegistration(job: Job, subscription: PushSubscriptionRecord,
    outcome: 'check' | 'sent' | 'provider_expired' | 'vapid_key_changed'): Promise<boolean> {
    return this.db.transaction(async sql => {
      await this.assertLease(sql, job);
      const values = [subscription.id, subscription.walletAddress, subscription.network,
        subscription.applicationServerKey, subscription.registrationIdentity];
      const condition = 'id=$1 AND wallet_address=$2 AND network=$3 AND application_server_key=$4 AND encrypted_subscription=$5 AND active';
      const current = await sql.query(`SELECT id FROM platform_subscriptions WHERE ${condition} FOR UPDATE`, values);
      if (!current.rows.length) return false;
      if (outcome === 'sent') await sql.query(`UPDATE platform_subscriptions SET last_sent_at=now() WHERE ${condition}`, values);
      else if (outcome !== 'check') await sql.query(`UPDATE platform_subscriptions SET active=false,retired_at=now(),retirement_reason=$6,updated_at=now() WHERE ${condition}`, [...values, outcome]);
      return true;
    });
  }
  async rules(session: Session): Promise<PriceRule[]> {
    return (await this.db.query<RuleRow & { monitoring: PriceMonitoringRecord | null; category_enabled: boolean }>(`SELECT r.*,to_jsonb(m) AS monitoring,
      (p.preferences->>'priceAlerts')::boolean AS category_enabled FROM platform_price_rules r JOIN platform_preferences p USING(wallet_address,network)
      LEFT JOIN platform_price_rule_monitoring m ON m.rule_id=r.id AND m.definition_revision=r.updated_at::text
      WHERE r.wallet_address=$1 AND r.network=$2 ORDER BY r.asset_kind,r.asset_id`, [session.walletAddress, session.network])).rows
      .map(row => priceRule(row, row.monitoring, row.category_enabled, this.config));
  }
  async saveRule(session: Session, input: PriceRuleInput): Promise<PriceRule> {
    const asset = alertAssetSchema.parse(input.asset), { enabled } = input;
    if (asset.kind !== 'ton' || input.currency !== 'T3' || !input.quoteAssetId || !input.releaseManifestHash)
      throw new ApiError(400, 'dex_pair_required', 'Choose a release-bound TONSwap DEX pair and quote denomination.');
    if (asset.kind === 'ton' && asset.network !== session.network)
      throw new ApiError(400, 'asset_network_mismatch', 'Choose an asset on the authenticated wallet network.');
    const assetId = asset.assetId;
    return this.db.transaction(async sql => {
      await this.lockJobIdentity(sql, 'prices');
      const total = await sql.query<{ count: string }>('SELECT count(*) FROM platform_price_rules WHERE wallet_address=$1 AND network=$2', [session.walletAddress, session.network]);
      const existing = await sql.query('SELECT id FROM platform_price_rules WHERE wallet_address=$1 AND network=$2 AND asset_kind=$3 AND asset_id=$4', [session.walletAddress, session.network, asset.kind, assetId]);
      if (!existing.rows.length && Number(total.rows[0]?.count) >= 30) throw new ApiError(409, 'rule_limit', 'Up to 30 watched assets are supported.');
      const result = await sql.query<RuleRow>(`INSERT INTO platform_price_rules(id,wallet_address,network,asset_kind,asset_id,enabled,kind,threshold_percent,target_price,direction,currency,quote_asset_id,release_manifest_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(network,wallet_address,asset_kind,asset_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        kind=EXCLUDED.kind,threshold_percent=EXCLUDED.threshold_percent,target_price=EXCLUDED.target_price,direction=EXCLUDED.direction,currency=EXCLUDED.currency,quote_asset_id=EXCLUDED.quote_asset_id,release_manifest_hash=EXCLUDED.release_manifest_hash,
        last_direction=NULL,last_observed_at=NULL,updated_at=GREATEST(clock_timestamp(),platform_price_rules.updated_at+interval '1 microsecond') RETURNING *`,
      [randomUUID(), session.walletAddress, session.network, asset.kind, assetId, enabled, input.kind, input.thresholdPercent, input.targetPrice, input.direction, input.currency, input.quoteAssetId, input.releaseManifestHash]);
      await this.enqueue(sql, 'price_scan', 'prices', {}, true);
      return priceRule(result.rows[0]!, null, (await this.preferences(session.walletAddress, session.network, sql)).priceAlerts, this.config);
    });
  }
  async deleteRule(session: Session, id: string): Promise<void> {
    await this.db.query('DELETE FROM platform_price_rules WHERE id=$1 AND wallet_address=$2 AND network=$3', [id, session.walletAddress, session.network]);
  }
  async watchedRules(): Promise<WatchedPriceRule[]> {
    return (await this.db.query<Omit<WatchedPriceRule, 'asset'> & Pick<RuleRow, 'asset_kind' | 'asset_id'>>(`SELECT r.id,r.asset_kind,r.asset_id,r.kind,r.updated_at::text AS revision,r.wallet_address AS "walletAddress",r.network FROM platform_price_rules r JOIN platform_preferences p
      USING(network,wallet_address) WHERE r.enabled AND p.preferences->>'priceAlerts'='true' ORDER BY r.asset_kind,r.asset_id`)).rows
      .map(({ asset_kind, asset_id, ...row }) => ({ ...row, asset: ruleAsset({ asset_kind, asset_id, network: row.network }) }));
  }
  async inbox(session: Session, limit: number, cursor?: string): Promise<{ notifications: Notification[]; nextCursor: string | null }> {
    let boundary: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url');
        if (decoded.toString('base64url') !== cursor) throw new Error();
        boundary = JSON.parse(decoded.toString());
        if (!boundary || Object.keys(boundary).sort().join(',') !== 'createdAt,id'
          || typeof boundary.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(boundary.createdAt)
          || !Number.isFinite(Date.parse(boundary.createdAt)) || new Date(boundary.createdAt).toISOString() !== boundary.createdAt.slice(0, 23) + 'Z'
          || typeof boundary.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boundary.id)) throw new Error();
      } catch { throw new ApiError(400, 'invalid_cursor', 'Invalid inbox cursor.'); }
    }
    // Event timestamps may use millisecond Date values for display. The cursor
    // must retain PostgreSQL microseconds or it skips the rest of a tied batch.
    const rows = await this.db.query<NoticeRow & { cursor_created_at: string }>(`SELECT *,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM platform_notifications WHERE wallet_address=$1 AND network=$2
      ${boundary ? 'AND (created_at,id)<($4::timestamptz,$5::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $3`,
    boundary ? [session.walletAddress, session.network, limit + 1, boundary.createdAt, boundary.id] : [session.walletAddress, session.network, limit + 1]);
    const page = rows.rows.slice(0, limit), notifications = page.map(notification), last = page.at(-1);
    return { notifications, nextCursor: rows.rows.length > limit && last ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id })).toString('base64url') : null };
  }
  async markRead(session: Session, id: string): Promise<void> {
    await this.db.query('UPDATE platform_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND wallet_address=$2 AND network=$3', [id, session.walletAddress, session.network]);
  }
  async notification(id: string, wallet: string, network: Network): Promise<Notification | null> {
    const row = (await this.db.query<NoticeRow>('SELECT * FROM platform_notifications WHERE id=$1 AND wallet_address=$2 AND network=$3',
      [id, wallet, network])).rows[0];
    return row ? notification(row) : null;
  }
  async emit(wallet: string, network: Network, notice: NewNotification, options: { sql?: Sql; force?: boolean; subscriptionId?: string } = {}): Promise<string | null> {
    const execute = async (sql: Sql): Promise<string | null> => {
      if (!options.force && !await this.canNotify(wallet, network, notice, sql, true)) return null;
      const id = randomUUID();
      const inserted = await sql.query(`INSERT INTO platform_notifications(id,wallet_address,network,category,source_event_id,title,body,href,evidence,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(network,wallet_address,source_event_id) DO NOTHING RETURNING id`,
      [id, wallet, network, notice.category, notice.sourceEventId, notice.title, notice.body, notice.href, JSON.stringify(notice.evidence), notice.occurredAt]);
      if (!inserted.rows.length) return null;
      const devices = await sql.query<{ id: string; application_server_key: string }>(`SELECT id,application_server_key FROM platform_subscriptions WHERE wallet_address=$1 AND network=$2 AND active
        ${options.subscriptionId ? 'AND id=$3' : ''}`, options.subscriptionId ? [wallet, network, options.subscriptionId] : [wallet, network]);
      for (const device of devices.rows) await this.enqueue(sql, 'deliver_push', `push:${id}:${device.id}`,
        { notificationId: id, subscriptionId: device.id, applicationServerKey: device.application_server_key, walletAddress: wallet, network, test: Boolean(options.force) });
      return id;
    };
    return options.sql ? execute(options.sql) : this.db.transaction(execute);
  }
  async enqueue(sql: Sql, kind: Job['kind'], dedupeKey: string, payload: Record<string, unknown>, revive = false): Promise<void> {
    // Keep the lock and insert in one statement: callers may use the database
    // directly rather than an already open transaction (worker initialization).
    await sql.query(`WITH job_identity AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended($5,0)))
      INSERT INTO platform_jobs(id,kind,dedupe_key,payload) SELECT $1,$2,$3,$4 FROM job_identity ON CONFLICT(dedupe_key)
      ${revive ? "DO UPDATE SET state=CASE WHEN platform_jobs.state IN ('done','failed') THEN 'ready' ELSE platform_jobs.state END, available_at=LEAST(platform_jobs.available_at,now()),updated_at=now()" : 'DO NOTHING'}`,
    [randomUUID(), kind, dedupeKey, JSON.stringify(payload), `notification-job:${dedupeKey}`]);
  }
  async lease(workerId: string, limit: number): Promise<Job[]> {
    return this.db.transaction(async sql => {
      const result = await sql.query<{ id: string; kind: Job['kind']; dedupe_key: string; payload: Record<string, unknown>; attempts: number }>(
        `SELECT id,kind,dedupe_key,payload,attempts FROM platform_jobs WHERE (state='ready' AND available_at<=now())
        OR (state='leased' AND lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
      const jobs: Job[] = [];
      for (const row of result.rows) {
        const leaseToken = randomUUID();
        await sql.query("UPDATE platform_jobs SET state='leased',lease_token=$2,lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now() WHERE id=$1", [row.id, leaseToken]);
        jobs.push({ id: row.id, kind: row.kind, dedupeKey: row.dedupe_key, payload: row.payload, attempts: row.attempts + 1, leaseToken });
      }
      await sql.query('INSERT INTO platform_worker_status(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET last_seen_at=now()', [workerId]);
      return jobs;
    });
  }
  async heartbeat(job: Job): Promise<boolean> {
    const result = await this.db.query("UPDATE platform_jobs SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND state='leased' AND lease_until>now() RETURNING id", [job.id, job.leaseToken]);
    return result.rows.length > 0;
  }
  async assertLease(sql: Sql, job: Job): Promise<void> {
    await this.lockJobIdentity(sql, job.dedupeKey);
    const owned = await sql.query(`SELECT id FROM platform_jobs WHERE id=$1 AND lease_token=$2
      AND state='leased' AND lease_until>now() FOR UPDATE`, [job.id, job.leaseToken]);
    if (!owned.rows.length) throw new ApiError(409, 'job_lease_lost', 'The job is no longer owned by this worker.');
  }
  private async lockJobIdentity(sql: Sql, dedupeKey: string): Promise<void> {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notification-job:${dedupeKey}`]);
  }
  async finish(job: Job, nextSeconds?: number): Promise<void> {
    await this.db.query(`UPDATE platform_jobs SET state=$3,available_at=now()+($4::int * interval '1 second'),
      attempts=0,lease_until=NULL,lease_token=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2`,
    [job.id, job.leaseToken, nextSeconds === undefined ? 'done' : 'ready', nextSeconds ?? 0]);
  }
  async fail(job: Job, code: string, retryAfterSeconds?: number): Promise<void> {
    const recurring = job.kind !== 'deliver_push';
    const dead = !recurring && job.attempts >= 8;
    const delay = Math.min(3600, Math.max(retryAfterSeconds ?? 0, 5 * 2 ** Math.min(job.attempts, 9))) + Math.floor(Math.random() * 5);
    await this.db.query(`UPDATE platform_jobs SET state=$3,available_at=now()+($4::int * interval '1 second'),
      lease_until=NULL,lease_token=NULL,last_error=$5,updated_at=now() WHERE id=$1 AND lease_token=$2`,
    [job.id, job.leaseToken, dead ? 'failed' : 'ready', delay, code.slice(0, 160)]);
  }
  async checkpoint<T>(key: string): Promise<T | null> {
    return (await this.db.query<{ value: T }>('SELECT value FROM platform_checkpoints WHERE key=$1', [key])).rows[0]?.value ?? null;
  }
  async setCheckpoint(key: string, value: unknown, sql: Sql = this.db): Promise<void> {
    await sql.query('INSERT INTO platform_checkpoints(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()', [key, JSON.stringify(value)]);
  }
  async cleanup(): Promise<void> {
    await this.db.transaction(async sql => {
      await sql.query("DELETE FROM platform_challenges WHERE expires_at<now()-interval '1 day'");
      await sql.query(`DELETE FROM platform_notifications WHERE created_at<now()-($1::int * interval '1 day')`, [this.config.retentionDays]);
      await sql.query("DELETE FROM platform_quote_cache WHERE expires_at<now()-interval '7 days'");
      await sql.query("DELETE FROM platform_jobs WHERE state IN ('done','failed') AND updated_at<now()-interval '14 days'");
      await sql.query("DELETE FROM platform_source_events WHERE observed_at<now()-interval '35 days'");
      await sql.query("DELETE FROM platform_subscriptions WHERE NOT active AND retired_at<now()-interval '30 days'");
      await sql.query("DELETE FROM platform_sessions WHERE expires_at<now()-interval '30 days' AND id NOT IN (SELECT session_id FROM platform_subscriptions WHERE session_id IS NOT NULL)");
    });
  }
}
