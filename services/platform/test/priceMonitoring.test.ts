import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Store, type WatchedPriceRule } from '../src/store.js';
import { Providers } from '../src/providers.js';
import { AlertObservations } from '../src/alertObservations.js';
import { PushSender } from '../src/push.js';
import { Worker } from '../src/worker.js';
import { createReleaseTestServer as createServer, injectRelease, apiConfig as config } from './releaseRequests.js';
import { assessPriceObservation, priceMonitoring, type PriceMonitoringRecord } from '../src/priceMonitoring.js';
import type { AlertAsset, AlertQuote, Job, PriceRuleInput, Session } from '../src/types.js';
import { dexConfig, dexDefinition, dexQuote, token, otherToken, quoteRoot, release } from './dexAlertFixtures.js';
import { Decimal } from '../src/decimal.js';
import {address, database, secondAddress, session} from './helpers.js';

const cfg = dexConfig({ networks: ['testnet', 'mainnet'] });
let db: Database, store: Store, providers: Providers, worker: Worker;
let current: Session & { token: string }, other: Session, mainnet: Session;
let now: number;
let cleanup = async () => {};
const forbiddenFetch = vi.fn(async () => { throw Error('Unexpected external request in local monitoring qualification.'); });
beforeAll(async () => {
  const nativeUrl = process.env.PLATFORM_TEST_DATABASE_URL;
  if (nativeUrl) {
    const url = new URL(nativeUrl);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_')) throw Error('Disposable loopback test database required.');
    const admin = postgres(nativeUrl), schema = `price_monitoring_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
    db = postgres(url.toString()); await migrate(db);
    cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
  } else { db = await database(); cleanup = () => db.close(); }
  store = new Store(db, cfg); current = await session(store); other = await session(store, secondAddress);
  const challenge = await store.createChallenge(address, 'mainnet', 'app.example.test');
  mainnet = await store.createSession(challenge.payload, address, 'mainnet');
});
afterAll(async () => { await cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  now = Math.floor(Date.now() / 1000) * 1000; forbiddenFetch.mockClear();
  for (const table of ['platform_jobs', 'platform_notifications', 'platform_subscriptions', 'platform_price_rules']) await db.query(`DELETE FROM ${table}`);
  for (const owner of [current, other, mainnet]) await store.setPreferences(owner, { priceAlerts: true, activity: false, walletProtocol: false, governance: false });
  providers = new Providers(db, cfg, forbiddenFetch);
  worker = new Worker(cfg, store, providers, new PushSender(cfg), forbiddenFetch, () => new Date(now));
});
const iso = (value = now) => new Date(value).toISOString();
const definition = (overrides: Partial<PriceRuleInput> = {}): PriceRuleInput => dexDefinition(overrides);
const quote = (overrides: Partial<AlertQuote> = {}): AlertQuote => dexQuote({
  ...overrides, ...(overrides.change24h && !overrides.price ? { price: new Decimal(100).plus(overrides.change24h).toString() } : {}),
  change24h: null,
}, now);
const indexedQuote = (asset: AlertAsset, overrides: Partial<AlertQuote> = {}): AlertQuote => quote({ asset, ...overrides });
async function saved(overrides: Partial<PriceRuleInput> = {}, owner: Session = current) {
  const input = definition(overrides);
  if (owner.network !== 'testnet' && input.asset.kind === 'ton') input.asset = { ...input.asset, network: owner.network };
  const rule = await store.saveRule(owner, input);
  const watched = (await store.watchedRules()).find(row => row.id === rule.id)!;
  return { rule, watched };
}
async function lease() { return (await store.lease('price-monitoring-test', 100)).find(row => row.kind === 'price_scan')!; }
async function apply(watched: WatchedPriceRule, value: AlertQuote | null, job: Job, scan = { startedAt: iso(), currency: 'T3' }) {
  await worker.applyPrice(watched, value, scan, job);
}
async function monitoring(id: string, owner: Session = current) { return (await store.rules(owner)).find(rule => rule.id === id)!.monitoring; }
async function persisted(id: string) { return (await db.query('SELECT * FROM platform_price_rule_monitoring WHERE rule_id=$1', [id])).rows; }
async function inbox(owner: Session = current) { return (await store.inbox(owner, 100)).notifications; }

describe('durable price monitoring, separate from saved rule definitions', () => {
  it('reports waiting before the first actual scan, then records unavailable DEX access without inventing an observation', async () => {
    const { rule } = await saved();
    expect(await monitoring(rule.id)).toMatchObject({ state: 'waiting', issue: 'awaiting_first_check', checkedAt: null, observedAt: null, evaluatedAt: null });
    await worker.scanPrices(await lease());
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', issue: 'dex_source_unavailable', checkedAt: iso(), observedAt: null, evaluatedAt: null });
    expect(forbiddenFetch).toHaveBeenCalled(); expect(await inbox()).toHaveLength(0);
  });
  it.each(['throw', 'missing', 'duplicate'] as const)('records a %s provider result without silently retaining an operational status', async outcome => {
    const { rule } = await saved();
    const prices = vi.spyOn(AlertObservations.prototype, 'prices');
    if (outcome === 'throw') prices.mockRejectedValue(new Error('Private upstream message must not be persisted'));
    else prices.mockResolvedValue({ currency: 'T3', quoteAssetId: quoteRoot, requestedAt: iso(), issues: [], quotes: outcome === 'missing' ? [] : [quote(), quote()] });
    await worker.scanPrices(await lease());
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', evaluatedAt: null,
      issue: outcome === 'throw' ? 'provider_unavailable' : 'quote_missing' });
    expect(JSON.stringify(await persisted(rule.id))).not.toContain('Private upstream');
  });
  it.each([
    ['stale provider flag', { stale: true }, 'T3', 'stale', 'quote_stale'],
    ['aged observation', { observedAt: '2000-01-01T00:00:00.000Z' }, 'T3', 'stale', 'quote_stale'],
    ['other asset', { asset: otherToken }, 'T3', 'unavailable', 'quote_scope_invalid'],
    ['daily precision', { evidence: { ...dexQuote().evidence, precision: 'daily' } }, 'T3', 'unavailable', 'quote_scope_invalid'],
    ['foreign method', { evidence: { ...dexQuote().evidence, method: 'coingecko-utc-daily-snapshot' } }, 'T3', 'unavailable', 'quote_scope_invalid'],
    ['foreign currency', {}, 'EUR', 'unavailable', 'dex_rule_binding_mismatch'],
    ['invalid observed time', { observedAt: 'not-a-time' }, 'T3', 'unavailable', 'observation_time_invalid'],
    ['nonpositive price', { price: '0' }, 'T3', 'unavailable', 'quote_invalid'],
  ] as const)('rejects %s before changing the crossing baseline', async (_name, overrides, currency, state, issue) => {
    const { rule, watched } = await saved();
    await apply(watched, quote(overrides), await lease(), { startedAt: iso(), currency });
    expect(await monitoring(rule.id)).toMatchObject({ state, issue, evaluatedAt: null });
    expect((await store.rules(current))[0]?.lastDirection).toBeNull(); expect(await inbox()).toHaveLength(0);
  });
  it('refreshes repeated cached checks, marks failed/stale repeats explicitly, and recovers without re-evaluating or notifying', async () => {
    const { rule, watched } = await saved(), job = await lease(), original = quote({ change24h: '7' });
    await apply(watched, original, job); const observedAt = original.observedAt;
    now += 1_000; await apply(watched, original, job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'monitoring', checkedAt: iso(), evaluatedAt: observedAt });
    expect(Date.parse((await monitoring(rule.id)).observedAt!)).toBe(Date.parse(observedAt!));
    now += 1_000; await apply(watched, { ...original, stale: true }, job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'stale', issue: 'quote_stale', evaluatedAt: observedAt });
    now += 1_000; await apply(watched, { ...original, status: 'unavailable' }, job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', issue: 'provider_unavailable', evaluatedAt: observedAt });
    now += 1_000; await apply(watched, original, job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'monitoring', issue: null, checkedAt: iso(), evaluatedAt: observedAt });
    expect(Date.parse((await monitoring(rule.id)).observedAt!)).toBe(Date.parse(observedAt!));
    expect((await store.rules(current))[0]?.lastDirection).toBe('up'); expect(await inbox()).toHaveLength(0);
  });
  it('records observation regression while preserving the later crossing baseline and its exact market timestamp', async () => {
    const { rule, watched } = await saved(), job = await lease();
    const original = quote(); await apply(watched, original, job); now += 1_000;
    await apply(watched, quote({ observedAt: iso(now - 2_000), change24h: '9' }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', issue: 'observation_regressed', evaluatedAt: original.observedAt });
    expect((await store.rules(current))[0]?.lastDirection).toBe('inside'); expect(await inbox()).toHaveLength(0);
  });
  it('retains crossing detection, a strict 24-hour cooldown, event deduplication and exact monetary evidence', async () => {
    const { watched } = await saved(), job = await lease(), base = now;
    const sample = async (offset: number, price: string) => { now = base + offset; await apply(watched, quote({ price }), job); };
    await sample(0, '100'); await sample(1_000, '105');
    expect(await inbox()).toHaveLength(1);
    await sample(2_000, '104'); await sample(86_400_000, '106');
    expect(await inbox()).toHaveLength(1);
    await sample(86_401_000, '100'); await sample(86_402_000, '107.000000001');
    await sample(86_402_000, '107.000000001');
    const notices = await inbox(); expect(notices).toHaveLength(2);
    expect(notices[0]?.evidence).toMatchObject({ price: '107.000000001', currency: 'T3', quoteAssetId: quoteRoot, change24h: null, source: 'tonswap-dex' });
  });
  it('supports a target observation without a 24-hour percentage value', async () => {
    const { rule, watched } = await saved({ kind: 'target', thresholdPercent: null, targetPrice: '100.000000000000000002', direction: 'above' }), job = await lease();
    await apply(watched, quote({ change24h: null, price: '100' }), job); now += 1_000;
    await apply(watched, quote({ change24h: null, price: '100.000000003' }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'monitoring', issue: null }); expect(await inbox()).toHaveLength(1);
  });
  it('scans two canonical contracts with distinct network and wallet scopes', async () => {
    const first = await saved(), second = await saved({ asset: otherToken });
    const mainToken = await saved({}, mainnet), repeated = await saved({}, other);
    const observations = vi.spyOn(AlertObservations.prototype, 'prices').mockImplementation(async assets => ({
      currency: 'T3', quoteAssetId: quoteRoot, requestedAt: iso(), issues: [], quotes: assets.map(asset => indexedQuote(asset)),
    }));
    await worker.scanPrices(await lease());
    expect(observations).toHaveBeenCalledOnce();
    expect(observations.mock.calls[0]![0]).toHaveLength(3);
    expect(observations.mock.calls[0]![0]).toEqual(expect.arrayContaining([first.rule.asset, second.rule.asset, mainToken.rule.asset]));
    for (const row of [first, second]) expect(await monitoring(row.rule.id)).toMatchObject({ state: 'monitoring', source: 'tonswap-dex' });
    expect(await monitoring(repeated.rule.id, other)).toMatchObject({ state: 'monitoring', source: 'tonswap-dex' });
    expect(await inbox()).toHaveLength(0);
  });
  it('emits indexed target crossings with exact tagged asset and market evidence while stale observations preserve the baseline', async () => {
    const asset: AlertAsset = { kind: 'ton', network: 'testnet', assetId: address };
    const { rule, watched } = await saved({ asset, kind: 'target', thresholdPercent: null, targetPrice: '100.000000000000000002', direction: 'above' });
    const job = await lease();
    await apply(watched, indexedQuote(asset, { price: '100' }), job); now += 1_000;
    await apply(watched, indexedQuote(asset, { price: '100.000000003', stale: true }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'stale', issue: 'quote_stale' });
    expect((await store.rules(current))[0]?.lastDirection).toBe('inside'); expect(await inbox()).toHaveLength(0);
    now += 1_000; const crossed = indexedQuote(asset, { price: '100.000000003' });
    await apply(watched, crossed, job); await apply(watched, crossed, job);
    const notices = await inbox(); expect(notices).toHaveLength(1);
    expect(notices[0]?.evidence).toMatchObject({ asset, source: 'tonswap-dex', price: crossed.price, currency: 'T3', quoteAssetId: quoteRoot,
      change24h: null, valuationEvidence: crossed.evidence });
    expect(notices[0]?.evidence).not.toHaveProperty('assetId');
    expect(notices[0]?.title).toBe(`TONSwap asset ${address} crossed your target price`);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'monitoring', source: 'tonswap-dex' });
  });
  it('does not create percentage observations from current DEX state and keeps forged scope inert', async () => {
    const asset: AlertAsset = otherToken;
    const { rule, watched } = await saved({ asset, kind: 'percent', thresholdPercent: '5', targetPrice: null, direction: 'both' }), job = await lease();
    await apply(watched, indexedQuote(asset), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', issue: 'change_unavailable', evaluatedAt: null });
    now += 1_000; await apply(watched, indexedQuote(asset, { change24h: '5' }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', issue: 'change_unavailable', evaluatedAt: null });
    now += 1_000; await apply(watched, indexedQuote({ ...asset, network: 'mainnet' }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'unavailable', issue: 'quote_scope_invalid', evaluatedAt: null });
    const original = await monitoring(rule.id);
    await apply({ ...watched, asset: { ...asset, network: 'mainnet' } }, indexedQuote({ ...asset, network: 'mainnet' }), job);
    expect(await monitoring(rule.id)).toEqual(original); expect(await inbox()).toHaveLength(0);
  });
  it('keeps another configured asset observable when one TON valuation path becomes unavailable', async () => {
    const listed = await saved(), ton = await saved({ asset: otherToken });
    vi.spyOn(AlertObservations.prototype, 'prices').mockResolvedValue({ currency: 'T3', quoteAssetId: quoteRoot, requestedAt: iso(), issues: ['valuation_path_missing'],
      quotes: [quote(), indexedQuote(ton.rule.asset, { price: null, observedAt: null, source: null, status: 'unavailable', stale: true, issue: 'valuation_path_missing' })] });
    await worker.scanPrices(await lease());
    expect(await monitoring(listed.rule.id)).toMatchObject({ state: 'monitoring' });
    expect(await monitoring(ton.rule.id)).toMatchObject({ state: 'unavailable', issue: 'valuation_path_missing', evaluatedAt: null });
  });
  it('fences a response captured before a definition edit even when both saves share the same millisecond', async () => {
    const { rule, watched } = await saved(), job = await lease();
    await store.saveRule(current, definition({ targetPrice: '108' }));
    const replacement = (await store.watchedRules())[0]!; expect(replacement.revision).not.toBe(watched.revision);
    await apply(watched, quote({ change24h: '7' }), job);
    expect(await persisted(rule.id)).toHaveLength(0); expect(await monitoring(rule.id)).toMatchObject({ state: 'waiting', evaluatedAt: null });
    await apply(replacement, quote({ change24h: '7' }), job);
    expect((await store.rules(current))[0]?.lastDirection).toBe('inside'); expect(await inbox()).toHaveLength(0);
  });
  it('withdraws category consent immediately and starts a new baseline after re-enabling instead of accepting an old scan', async () => {
    const { rule, watched } = await saved(), job = await lease();
    await apply(watched, quote(), job); await store.setPreferences(current, { priceAlerts: false });
    expect(await monitoring(rule.id)).toMatchObject({ state: 'category-off' });
    now += 1_000; await apply(watched, quote({ change24h: '9' }), job);
    await store.setPreferences(current, { priceAlerts: true });
    await apply(watched, quote({ change24h: '9' }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'waiting', evaluatedAt: null });
    const replacement = (await store.watchedRules())[0]!;
    await apply(replacement, quote({ change24h: '9' }), job);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'monitoring' }); expect(await inbox()).toHaveLength(0);
  });
  it('does not reset price monitoring when an unrelated category preference is edited', async () => {
    const { watched } = await saved(); await store.setPreferences(current, { governance: true });
    expect((await store.watchedRules())[0]?.revision).toBe(watched.revision);
  });
  it('does not let an older slow scan overwrite the result of a later-started scan', async () => {
    const { rule, watched } = await saved(), job = await lease(), oldStart = iso(now - 1_000);
    await apply(watched, quote(), job); const original = await monitoring(rule.id);
    now += 1_000; await apply(watched, null, job, { startedAt: oldStart, currency: 'T3' });
    expect(await monitoring(rule.id)).toEqual(original);
  });
  it.each(['definition', 'category'] as const)('fences an actual deferred provider response across a %s edit', async change => {
    const { rule } = await saved(), job = await lease();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(AlertObservations.prototype, 'prices').mockImplementation(async () => {
      entered(); await delayed; return { currency: 'T3', quoteAssetId: quoteRoot, requestedAt: iso(), issues: [], quotes: [quote({ change24h: '9' })] };
    });
    const scanning = worker.scanPrices(job); await started;
    try {
      if (change === 'definition') await store.saveRule(current, definition({ targetPrice: '108' }));
      else { await store.setPreferences(current, { priceAlerts: false }); await store.setPreferences(current, { priceAlerts: true }); }
    } finally { release(); }
    await scanning;
    expect(await monitoring(rule.id)).toMatchObject({ state: 'waiting', evaluatedAt: null });
    expect(await persisted(rule.id)).toHaveLength(0); expect(await inbox()).toHaveLength(0);
  });
  it('keeps valid partial observations usable while explicitly recording a missing independent asset', async () => {
    const bitcoin = await saved(), ethereum = await saved({ asset: otherToken });
    const prices = vi.spyOn(AlertObservations.prototype, 'prices').mockResolvedValue({ currency: 'T3', quoteAssetId: quoteRoot, requestedAt: iso(), issues: ['one_quote_missing'], quotes: [quote()] });
    await worker.scanPrices(await lease());
    expect(prices).toHaveBeenCalledWith([token, otherToken]);
    expect(await monitoring(bitcoin.rule.id)).toMatchObject({ state: 'monitoring', source: 'tonswap-dex' });
    expect(await monitoring(ethereum.rule.id)).toMatchObject({ state: 'unavailable', issue: 'quote_missing', observedAt: null });
  });
  it('rejects a lost lease or unrelated job before creating monitoring or inbox state', async () => {
    const { rule, watched } = await saved(), job = await lease();
    await expect(apply(watched, quote(), { ...job, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'job_lease_lost' });
    await expect(apply(watched, quote(), { ...job, kind: 'poll_wallet' })).rejects.toThrow('price_scan_lease_required');
    expect(await persisted(rule.id)).toHaveLength(0); expect(await inbox()).toHaveLength(0);
  });
  it('rejects a response after its price job expires and is leased by a replacement worker', async () => {
    const { rule, watched } = await saved(), job = await lease();
    await db.query("UPDATE platform_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    const replacement = await lease(); expect(replacement.leaseToken).not.toBe(job.leaseToken);
    await expect(apply(watched, quote(), job)).rejects.toMatchObject({ code: 'job_lease_lost' });
    expect(await persisted(rule.id)).toHaveLength(0); await apply(watched, quote(), replacement);
    expect(await monitoring(rule.id)).toMatchObject({ state: 'monitoring' });
  });
  it('isolates wallet and network monitoring, scopes rule deletion and cascades only the deleted rule evidence', async () => {
    const first = await saved(), second = await saved({}, other), third = await saved({}, mainnet), job = await lease();
    await apply(first.watched, quote(), job);
    expect(await monitoring(second.rule.id, other)).toMatchObject({ state: 'waiting' });
    expect(await monitoring(third.rule.id, mainnet)).toMatchObject({ state: 'waiting' });
    await apply({ ...first.watched, walletAddress: secondAddress }, quote({ change24h: '9' }), job);
    await apply({ ...first.watched, network: 'mainnet' }, quote({ change24h: '9' }), job);
    expect(await inbox()).toHaveLength(0); expect(await inbox(other)).toHaveLength(0); expect(await inbox(mainnet)).toHaveLength(0);
    await store.deleteRule(other, first.rule.id); expect(await persisted(first.rule.id)).toHaveLength(1);
    await store.deleteRule(current, first.rule.id); expect(await persisted(first.rule.id)).toHaveLength(0);
    expect(await store.rules(other)).toHaveLength(1); expect(await store.rules(mainnet)).toHaveLength(1);
  });
  it('exposes real monitoring evidence through the authenticated rules response and recalculates expiry when no worker runs', async () => {
    const { rule, watched } = await saved(); await apply(watched, quote(), await lease());
    const app = await createServer(cfg, db, { store, providers, logger: false });
    try {
      const headers = { cookie: `__Host-tonswap_session=${current.token}`, origin: 'https://app.example.test', 'x-wallet-address': address, 'x-wallet-network': 'testnet' };
      const response = await injectRelease(app, { url: '/v1/notifications/price-rules', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().rules[0]).toMatchObject({ id: rule.id, asset: watched.asset, capabilities: { target: true, percent: false },
        monitoring: { state: 'monitoring', checkedAt: iso(), evaluatedAt: iso(), source: 'tonswap-dex', issue: null, validUntil: iso(now + 30_000) } });
      expect(Date.parse(response.json().rules[0].monitoring.observedAt)).toBe(now);
      await db.query("UPDATE platform_price_rule_monitoring SET started_at=now()-interval '1 hour',checked_at=now()-interval '1 hour' WHERE rule_id=$1", [rule.id]);
      expect((await injectRelease(app, { url: '/v1/notifications/price-rules', headers })).json().rules[0].monitoring).toMatchObject({ state: 'stale', issue: 'monitoring_overdue' });
    } finally { await app.close(); }
  });
});

describe('price evidence freshness deadlines', () => {
  const at = Date.parse('2026-09-12T10:00:00.000Z');
  const record: PriceMonitoringRecord = { started_at: new Date(at).toISOString(), checked_at: new Date(at).toISOString(), observed_at: new Date(at).toISOString(), source: 'tonswap-dex', outcome: 'observed', issue: null };
  const state = (offset: number, overrides: Partial<Parameters<typeof priceMonitoring>[0]> = {}) => priceMonitoring({ enabled: true, categoryEnabled: true, lastEvaluatedAt: record.observed_at, record, scanIntervalSeconds: 120, now: at + offset, ...overrides });
  it('uses exact inclusive observation and check deadlines without updating source time', () => {
    expect(state(30_000)).toMatchObject({ state: 'monitoring', validUntil: new Date(at + 30_000).toISOString() });
    expect(state(30_001)).toMatchObject({ state: 'stale', issue: 'quote_stale', observedAt: record.observed_at });
    expect(state(360_001)).toMatchObject({ state: 'stale', issue: 'monitoring_overdue' });
  });
  it('does not turn saved, disabled or category-off rules into active monitoring', () => {
    expect(state(0, { record: null })).toMatchObject({ state: 'waiting', issue: 'awaiting_first_check' });
    expect(state(0, { lastEvaluatedAt: null })).toMatchObject({ state: 'waiting', issue: 'awaiting_baseline' });
    expect(state(1_000_000, { enabled: false })).toMatchObject({ state: 'disabled' });
    expect(state(1_000_000, { categoryEnabled: false })).toMatchObject({ state: 'category-off' });
  });
  it('expires a previously unavailable check and rejects implausible future check times', () => {
    expect(state(0, { record: { ...record, outcome: 'unavailable', issue: 'provider_unavailable', observed_at: null } })).toMatchObject({ state: 'unavailable', issue: 'provider_unavailable' });
    expect(state(360_001, { record: { ...record, outcome: 'unavailable', issue: 'provider_unavailable', observed_at: null } })).toMatchObject({ state: 'stale', issue: 'monitoring_overdue' });
    expect(state(-5_001)).toMatchObject({ state: 'stale', issue: 'monitoring_overdue' });
  });
  it('rejects foreign scope and nonfinite prices while accepting exact positive target values', () => {
    const value = dexQuote({ price: '0.001000001' }, at);
    expect(assessPriceObservation(token, 'target', value, 'T3', at, quoteRoot)).toMatchObject({ outcome: 'observed', issue: null });
    expect(assessPriceObservation(token, 'percent', value, 'T3', at, quoteRoot)).toMatchObject({ issue: 'change_unavailable' });
    expect(assessPriceObservation(token, 'target', { ...value, price: 'Infinity' }, 'T3', at, quoteRoot)).toMatchObject({ issue: 'quote_invalid' });
    expect(assessPriceObservation(token, 'target', dexQuote({ observedAt: new Date(at + 5_001).toISOString() }, at), 'T3', at, quoteRoot)).toMatchObject({ issue: 'observation_time_invalid' });
    expect(assessPriceObservation(token, 'target', { ...value, source: 'coingecko' as AlertQuote['source'] }, 'T3', at, quoteRoot)).toMatchObject({ source: null, issue: 'quote_scope_invalid' });
  });
});
