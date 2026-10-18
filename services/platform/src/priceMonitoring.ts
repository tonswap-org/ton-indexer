import { DEX_PRICE_MAX_AGE_MS, DEX_PRICE_FUTURE_SKEW_MS } from './dexPrices.js';
import { Decimal } from './decimal.js';
import { alertAssetKey } from './alertAssets.js';
import type { AlertAsset, AlertQuote, AlertQuoteSource, PriceRuleMonitoring } from './types.js';

export const PRICE_OBSERVATION_MAX_AGE_MS = DEX_PRICE_MAX_AGE_MS;
export interface PriceMonitoringRecord {
  started_at: string; checked_at: string; observed_at: string | null;
  outcome: 'observed' | 'stale' | 'unavailable'; source: AlertQuoteSource | null; issue: string | null;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^(-1|0):[a-f0-9]{64}$/.test(value);
const positiveInteger = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,155}$/.test(value);

export function assessPriceObservation(asset: AlertAsset, kind: 'percent' | 'target', quote: AlertQuote | null,
  currency: string, now: number, expectedQuoteAssetId: string | null = null): Pick<PriceMonitoringRecord, 'outcome' | 'observed_at' | 'source' | 'issue'> {
  const result = (outcome: PriceMonitoringRecord['outcome'], issue: string | null, observedAt: string | null = null) =>
    ({ outcome, issue, observed_at: observedAt, source: quote?.source === 'tonswap-dex' ? quote.source : null });
  if (currency !== 'T3') return result('unavailable', 'currency_mismatch');
  if (!quote) return result('unavailable', 'quote_missing');
  if (asset.kind !== 'ton' || alertAssetKey(quote.asset) !== alertAssetKey(asset))
    return result('unavailable', 'quote_scope_invalid');
  if (quote.status !== 'available') return result('unavailable', quote.issue ?? (quote.status === 'missing' ? 'quote_missing' : 'provider_unavailable'));
  if (quote.currency !== 'T3' || !address(expectedQuoteAssetId) || quote.quoteAssetId !== expectedQuoteAssetId)
    return result('unavailable', 'currency_mismatch');
  const evidence = quote.evidence, release = object(evidence.release), roots = object(evidence.rootBindings),
    ratio = object(evidence.exactRatio), head = object(evidence.head);
  const sourceValid = quote.source === 'tonswap-dex' && evidence.method === 'active_pool_q64' &&
    evidence.precision === 'indicative_display' && evidence.network === asset.network && evidence.assetId === asset.assetId &&
    evidence.currency === 'T3' && evidence.quoteAssetId === expectedQuoteAssetId &&
    typeof release.releaseId === 'string' && release.releaseId.length > 0 && hash(release.manifestHash) &&
    typeof evidence.marketKey === 'string' && evidence.marketKey.length > 0 && address(evidence.marketAddress) && hash(evidence.codeHash) &&
    ['ton-indexer/http4', 'ton-indexer/lite'].includes(String(evidence.source)) &&
    address(roots.assetRoot) && (asset.assetId === 'native' || roots.assetRoot === asset.assetId) &&
    roots.quoteRoot === expectedQuoteAssetId && hash(roots.assetCodeHash) && hash(roots.quoteCodeHash) &&
    positiveInteger(ratio.numerator) && positiveInteger(ratio.denominator) && positiveInteger(evidence.q64) &&
    positiveInteger(evidence.executableDepthT3Raw) && positiveInteger(evidence.executableDepthAssetRaw) &&
    Number.isSafeInteger(evidence.activeBin) && Number.isSafeInteger(head.workchain) &&
    typeof head.shard === 'string' && head.shard.length > 0 && Number.isSafeInteger(head.seqno) && Number(head.seqno) >= 0 &&
    hash(head.rootHashHex) && hash(head.fileHashHex);
  if (!sourceValid) return result('unavailable', 'quote_scope_invalid');
  const observed = quote.observedAt === null ? NaN : Date.parse(quote.observedAt);
  const queried = typeof evidence.queriedAt === 'string' ? Date.parse(evidence.queriedAt) : NaN;
  if (!Number.isFinite(observed) || observed > now + DEX_PRICE_FUTURE_SKEW_MS || evidence.observedAt !== quote.observedAt ||
      !Number.isFinite(queried) || queried > now + DEX_PRICE_FUTURE_SKEW_MS || observed > queried + DEX_PRICE_FUTURE_SKEW_MS)
    return result('unavailable', 'observation_time_invalid');
  const observedAt = new Date(observed).toISOString();
  try {
    if (quote.price === null || !new Decimal(quote.price).isFinite() || !new Decimal(quote.price).gt(0) ||
        !new Decimal(quote.price).eq(new Decimal(ratio.numerator as string).div(ratio.denominator as string))) throw Error();
  } catch { return result('unavailable', 'quote_invalid', observedAt); }
  if (quote.stale || now - observed > PRICE_OBSERVATION_MAX_AGE_MS || now - queried > PRICE_OBSERVATION_MAX_AGE_MS)
    return result('stale', 'quote_stale', observedAt);
  // A current pool state does not establish a comparable observed state 24 hours earlier.
  if (kind === 'percent') return result('unavailable', 'change_unavailable', observedAt);
  return result('observed', null, observedAt);
}

/** A successful definition save says nothing about actual background evaluation. */
export function priceMonitoring(input: { enabled: boolean; categoryEnabled: boolean; lastEvaluatedAt: string | null;
  record: PriceMonitoringRecord | null; scanIntervalSeconds: number; now: number }): PriceRuleMonitoring {
  const r = input.record;
  const base = { checkedAt: r ? new Date(r.checked_at).toISOString() : null, observedAt: r?.observed_at ?? null,
    evaluatedAt: input.lastEvaluatedAt, validUntil: null, source: r?.source ?? null, issue: r?.issue ?? null };
  if (!input.enabled) return { ...base, state: 'disabled' };
  if (!input.categoryEnabled) return { ...base, state: 'category-off' };
  if (!r) return { ...base, state: 'waiting', issue: 'awaiting_first_check' };
  const checkDeadline = Date.parse(r.checked_at) + Math.max(300_000, input.scanIntervalSeconds * 3_000);
  if (input.now > checkDeadline || Date.parse(r.checked_at) > input.now + DEX_PRICE_FUTURE_SKEW_MS)
    return { ...base, state: 'stale', issue: 'monitoring_overdue', validUntil: new Date(checkDeadline).toISOString() };
  if (r.outcome !== 'observed') return { ...base, state: r.outcome };
  const validUntil = new Date(Math.min(checkDeadline, Date.parse(r.observed_at!) + PRICE_OBSERVATION_MAX_AGE_MS)).toISOString();
  if (input.now > Date.parse(validUntil)) return { ...base, state: 'stale', issue: 'quote_stale', validUntil };
  return { ...base, validUntil, state: input.lastEvaluatedAt ? 'monitoring' : 'waiting', issue: input.lastEvaluatedAt ? null : 'awaiting_baseline' };
}
