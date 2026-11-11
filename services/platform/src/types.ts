export type Network = 'mainnet' | 'testnet';
export type Category = 'priceAlerts' | 'activity' | 'governance' | 'walletProtocol';
export type Preferences = Record<Category, boolean>;
export const DEFAULT_PREFERENCES: Preferences = {
  priceAlerts: false, activity: false, governance: false, walletProtocol: false,
};
export interface Session {
  id: string; walletAddress: string; network: Network; expiresAt: string; csrfToken: string;
}
export interface Quote {
  symbol: string; rate: string | null; observedAt: string | null;
  observationDate: string | null; requestedDate: string | null;
  source: 'identity' | 'frankfurter-v2' | 'coingecko' | 'polkaswap+coingecko' | 'ton-indexer+coingecko' | 'unavailable'; providers: string[]; stale: boolean;
  providerObservations?: { key: string; date: string; rate: string | null; excluded: boolean }[];
  status: 'available' | 'missing' | 'unavailable'; precision: 'daily' | 'spot';
}
export interface Price {
  assetId: string; price: string | null; observedAt: string | null;
  observationDate: string | null; requestedDate: string | null;
  source: 'coingecko' | 'unavailable'; stale: boolean;
  status: 'available' | 'missing' | 'unavailable'; precision: 'daily' | 'spot';
  change24h: string | null;
}
export interface RatesResponse { base: string; requestedAt: string; quotes: Quote[]; issues: string[];
  /** Dated fiat provider evidence only; absent for current rates and mathematical identity. */
  historicalFx?: import('./historicalFx.js').HistoricalFxEnvelope;
  historicalPrices?: import('./historicalDaily.js').HistoricalDailyEnvelope[];
}
export interface PricesResponse { currency: string; requestedAt: string; quotes: Price[]; issues: string[]; historicalPrices?: import('./historicalDaily.js').HistoricalDailyEnvelope[] }
export interface Notification {
  id: string; category: Category; title: string; body: string; href: string;
  occurredAt: string; createdAt: string; readAt: string | null;
  sourceEventId: string; evidence: Record<string, unknown>;
}
export interface SubscriptionInput {
  applicationServerKey: string;
  endpoint: string; expirationTime?: number | null;
  keys: { p256dh: string; auth: string }; deviceName?: string;
}
export interface PushSubscriptionRecord extends SubscriptionInput {
  /** Captured encrypted registration identity; internal worker fencing only. */
  registrationIdentity: string;
  id: string; walletAddress: string; network: Network; active: boolean;
}
/** Alert identities distinguish a provider listing from a token on a specific network. */
export type AlertAsset = { kind: 'listed'; coinGeckoId: string }
  | { kind: 'ton'; network: Network; assetId: string };
export type AlertQuoteSource = 'tonswap-dex';
export interface AlertQuote {
  asset: AlertAsset; price: string | null; observedAt: string | null; currency: string | null; quoteAssetId: string | null;
  source: AlertQuoteSource | null; status: 'available' | 'missing' | 'unavailable'; stale: boolean;
  change24h: string | null; evidence: Record<string, unknown>; issue: string | null;
}
export interface AlertQuotesResponse {
  currency: string; quoteAssetId: string | null; requestedAt: string; quotes: AlertQuote[]; issues: string[];
}
export interface AlertAssetOption {
  asset: AlertAsset; name: string; symbol: string; currency: 'T3'; quoteAssetId: string; releaseManifestHash: string; capabilities: { target: boolean; percent: boolean };
}
export interface PriceRule {
  id: string; asset: AlertAsset; enabled: boolean; kind: 'percent' | 'target';
  capabilities: AlertAssetOption['capabilities'];
  thresholdPercent: string | null; targetPrice: string | null; direction: 'above' | 'below' | 'both'; currency: 'T3'; quoteAssetId: string; releaseManifestHash: string;
  windowHours: 24; cooldownHours: 24; lastNotifiedAt: string | null;
  lastDirection: 'up' | 'down' | 'inside' | null;
  monitoring: PriceRuleMonitoring;
}
export interface PriceRuleMonitoring {
  state: 'disabled' | 'category-off' | 'waiting' | 'monitoring' | 'stale' | 'unavailable';
  checkedAt: string | null; observedAt: string | null; evaluatedAt: string | null;
  validUntil: string | null; source: AlertQuoteSource | null; issue: string | null;
}
export interface PriceRuleInput {
  currency: 'T3'; quoteAssetId: string; releaseManifestHash: string;
  asset: AlertAsset; enabled: boolean; kind: 'percent' | 'target';
  thresholdPercent: string | null; targetPrice: string | null; direction: 'above' | 'below' | 'both';
}
export interface Job {
  id: string; kind: 'poll_wallet' | 'poll_governance' | 'price_scan' | 'deliver_push' | 'retention';
  dedupeKey: string; payload: Record<string, unknown>; attempts: number; leaseToken: string;
}
