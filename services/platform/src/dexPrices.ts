import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { Address, Cell } from '@ton/core';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Network } from './types.js';
import { Decimal } from './decimal.js';
import { fetchJson, record, type Fetcher } from './http.js';

export const DEX_PRICE_MAX_AGE_MS = 120_000;
export const DEX_PRICE_FUTURE_SKEW_MS = 5_000;
const HASH = /^[0-9a-f]{64}$/;
const RAW_ADDRESS = /^0:[0-9a-f]{64}$/;
const Q64 = 1n << 64n;

export interface DexTokenBinding {
  assetId: string; symbol: string; name: string; root: string; decimals: number; codeHash: string;
}
export interface DexMarketBinding {
  assetId: string; marketKey: string; address: string; codeHash: string; binSpacing: number; feePips: number;
}
export interface DexReleaseBinding {
  network: Network; releaseId: string; manifestHash: string; indexerUrl: string;
  quoteAssetId: string; quoteRoot: string; quoteDecimals: number; quoteCodeHash: string;
  tokens: DexTokenBinding[]; markets: DexMarketBinding[];
}
export interface DexCatalogueEntry {
  assetId: string; symbol: string; name: string; decimals: number; quoteAssetId: string; quoteSymbol: 'T3';
  marketKey: string | null; marketAddress: string | null; priceConfigured: boolean;
}
export interface DexPriceQuote {
  assetId: string; price: string | null; observedAt: string | null; source: 'tonswap-dex';
  status: 'available' | 'unavailable'; stale: boolean; change24h: null;
  evidence: Record<string, unknown>; issues: string[];
}
export interface DexPriceResponse {
  network: Network; currency: 'T3'; quoteAssetId: string | null;
  release: { releaseId: string; manifestHash: string } | null; requestedAt: string; quotes: DexPriceQuote[];
}

const digest = z.string().regex(HASH);
const address = z.string().regex(RAW_ADDRESS).refine(value => value !== `0:${'0'.repeat(64)}`);
const symbol = z.string().regex(/^[A-Z0-9_.$-]{1,32}$/);
// Validate the complete current native format before deriving any display binding.
const roles = ['Governance', 'USDT', 'USDC', 'KUSD', 'T3Hub', 'Treasury', 'GasVault', 'BuybackExecutor', 'FeeRouter',
  'DlmmPoolFactory', 'SwapCoordinator', 'SpotOrderFactory', 'EmissionsSplitter', 'ReferralRegistry', 'SaleFactory',
  'RiskVault', 'PerpsEngine', 'OptionVault', 'OptionFactory', 'OptionSeriesManager', 'CoverVault', 'ParisianPolicyManager',
  'CoverAutomationUpkeep', 'GenesisDistributor', 'TSMinter', 'MerkleClaim', 'Remint', 'TestnetFaucet'] as const;
const templates = ['T3Wallet', 'T3RecoveryProof', 'JettonV21Wallet', 'DlmmPool', 'SpotOrder', 'ShoutOption',
  'OutperformanceOption', 'SaleFixed', 'SaleBonding', 'SaleAuction', 'VestingVault', 'LpVault', 'JettonV21Minter'] as const;
const uint = (bits: number, minimum = 0) => z.number().int().min(minimum).max(2 ** bits - 1);
const atomic = z.string().regex(/^(0|[1-9][0-9]*)$/);
const asset = z.object({ path: z.string(), sha256: digest, bytes: z.number().int().min(1).max(512 * 1024 * 1024) }).strict();
const validAssetPath = (value: z.infer<typeof asset>) =>
  value.path === `release-assets/${value.sha256}.json` || value.path === `release-assets/${value.sha256}.boc`;
const releaseAsset = asset.refine(validAssetPath);
const executableAsset = asset.extend({ codeHash: digest }).refine(validAssetPath);
const walletBudget = z.object({ senderGas: uint(32, 10000), walletBounceGas: uint(32).max(500000), burnWalletGas: uint(32, 1).max(2000000),
  smallPayloadCells: uint(16, 1), largeWalletGas: uint(32, 1).max(2000000), largeSenderGas: uint(32, 1),
  rentSeconds: uint(32, 1), rentBits: uint(32, 1), rentCells: uint(16, 1), initBits: uint(32, 1), initCells: uint(16, 1),
  initCopies: uint(8, 1).max(4), transferBits: uint(16, 880), transferCells: uint(8, 1), transferCopies: uint(8, 3).max(8),
  creditProtection: z.boolean() }).strict();
const manifestSchema = z.object({
  schema: z.literal('tonswap-release-v1'), network: z.enum(['ton:testnet', 'ton:mainnet']), globalId: z.number().int(),
  releaseId: z.string().regex(/^[a-z]+-[A-Za-z0-9._-]+-[0-9a-f]{12}$/), createdAt: z.string().datetime(),
  source: z.object({ contracts: z.string().regex(/^[0-9a-f]{40}$/), build: digest }).strict(),
  services: z.object({ indexer: z.string().url(), tonRpc: z.string().url(), platform: z.string().url() }).strict(),
  contracts: z.partialRecord(z.enum(roles), z.object({ address, codeHash: digest }).strict()),
  templates: z.record(z.enum(templates), digest),
  tokens: z.array(z.object({ symbol, root: address, decimals: uint(5).max(18), masterCodeHash: digest, walletCodeHash: digest }).strict()).min(1).max(100),
  vendor: z.object({ stablecoin: z.object({ provenance: releaseAsset, minter: executableAsset, wallet: executableAsset }).strict() }).strict(),
  campaign: z.object({ id: atomic.refine(value => BigInt(value) < 1n << 256n), root: digest,
    count: z.number().int().min(1).max(2 ** 24), total: atomic.refine(value => BigInt(value) > 0n && BigInt(value) < 1n << 120n),
    start: uint(32), leaves: releaseAsset, proofs: releaseAsset }).strict(),
  supplyBase: atomic, orderKeeper: z.object({ address }).strict(),
  spotMarkets: z.array(z.object({ symbol, pool: address, binSpacing: z.number().int().min(1).max(0x7fffffff),
    feePips: uint(32), xDecimals: uint(5).max(18), walletGasX: uint(32, 10000).max(500000),
    walletGramX: atomic.refine(value => BigInt(value) <= 500000000n), walletBudgetX: walletBudget }).strict()).min(1).max(100),
  perpsMarkets: z.array(z.object({ marketId: uint(32, 1), symbol, pool: address }).strict()),
  options: z.array(z.object({ templateId: uint(32, 1), kind: z.enum(['shout', 'outperformance']), symbol,
    comparisonSymbol: symbol.optional(), seriesId: atomic.optional(), option: address.optional(), expiry: atomic.optional() }).strict()),
  manifestHash: digest,
}).strict();
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableJson(record(value)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export function parseDexReleaseManifest(value: unknown): DexReleaseBinding {
  const manifest = manifestSchema.parse(value);
  const { manifestHash, ...contents } = record(value);
  if (createHash('sha256').update(stableJson(contents)).digest('hex') !== manifestHash) {
    throw new Error('DEX release manifestHash does not match its canonical contents.');
  }
  const network: Network = manifest.network === 'ton:testnet' ? 'testnet' : 'mainnet';
  if (manifest.globalId !== (network === 'testnet' ? -3 : -239) ||
    !manifest.releaseId.endsWith(`-${manifest.source.build.slice(0, 12)}`)) throw new Error('DEX release identity is inconsistent.');
  const service = new URL(manifest.services.indexer);
  for (const value of Object.values(manifest.services)) {
    const url = new URL(value);
    if (value !== value.trim() || url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('DEX manifest services must be HTTPS or loopback URLs without credentials, query or fragment.');
    }
  }
  if (service.protocol !== 'https:' || manifest.services.indexer !== `${service.origin}/api/indexer`) {
    throw new Error('DEX manifest indexer must use the canonical HTTPS /api/indexer mount.');
  }
  if (BigInt(manifest.supplyBase) > BigInt(manifest.campaign.total)) throw new Error('DEX release supplyBase exceeds its campaign.');
  const contracts = Object.values(manifest.contracts);
  const unique = (values: string[]) => new Set(values).size === values.length;
  const identities = [...contracts.map(contract => contract.address), manifest.orderKeeper.address,
    ...manifest.spotMarkets.map(market => market.pool), ...manifest.options.flatMap(option => option.option ? [option.option] : [])];
  if (!unique(manifest.tokens.map(token => token.symbol)) || !unique(manifest.tokens.map(token => token.root)) ||
    !unique(manifest.spotMarkets.map(market => market.symbol)) || !unique(identities)) throw new Error('DEX release contains duplicate identities.');
  const tokens = manifest.tokens.map(token => {
    const role = token.symbol === 'T3' ? 'T3Hub' : token.symbol === 'TS' ? 'TSMinter' : token.symbol;
    const contract = manifest.contracts[role as typeof roles[number]];
    if (!contract || contract.address !== token.root || contract.codeHash !== token.masterCodeHash ||
      (token.symbol === 'T3' && token.walletCodeHash !== manifest.templates.T3Wallet) ||
      (token.symbol === 'TS' && (token.walletCodeHash !== manifest.templates.JettonV21Wallet || token.masterCodeHash !== manifest.templates.JettonV21Minter))) {
      throw new Error('DEX token root or code pins do not match its current release role.');
    }
    return { assetId: token.root, symbol: token.symbol, name: token.symbol, root: token.root, decimals: token.decimals, codeHash: token.masterCodeHash };
  });
  const quote = tokens.find(token => token.symbol === 'T3');
  if (!quote) throw new Error('DEX release requires the canonical T3Hub token.');
  const markets = manifest.spotMarkets.map(market => {
    const token = tokens.find(token => token.symbol === market.symbol);
    const budget = market.walletBudgetX;
    if (!token || token === quote || tokens.some(token => token.root === market.pool) || market.xDecimals !== token.decimals ||
      budget.senderGas > market.walletGasX || budget.burnWalletGas < budget.senderGas || budget.largeSenderGas < budget.senderGas ||
      budget.largeWalletGas < market.walletGasX || budget.largeSenderGas > budget.largeWalletGas) throw new Error('DEX market identity or wallet profile is invalid.');
    return { assetId: token.assetId, marketKey: `spot:${token.symbol}-T3`, address: market.pool,
      codeHash: manifest.templates.DlmmPool, binSpacing: market.binSpacing, feePips: market.feePips };
  });
  if (!unique(manifest.perpsMarkets.map(market => String(market.marketId))) || manifest.perpsMarkets.some(market =>
    manifest.spotMarkets.find(spot => spot.symbol === market.symbol)?.pool !== market.pool)) throw new Error('DEX release perps bindings are invalid.');
  const series = manifest.options.flatMap(option => option.seriesId === undefined ? [] : [option.seriesId]);
  if (!unique(series) || manifest.options.some(option => {
    const listed = [option.seriesId, option.option, option.expiry].filter(value => value !== undefined).length;
    return !manifest.spotMarkets.some(spot => spot.symbol === option.symbol) || (listed !== 0 && listed !== 3) ||
      (option.kind === 'outperformance' ? option.comparisonSymbol === option.symbol ||
        !manifest.spotMarkets.some(spot => spot.symbol === option.comparisonSymbol) : option.comparisonSymbol !== undefined);
  })) throw new Error('DEX release option bindings are invalid.');
  return { network, releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    indexerUrl: `${service.toString().replace(/\/$/, '')}/v1`, quoteAssetId: quote.assetId, quoteRoot: quote.root,
    quoteDecimals: quote.decimals, quoteCodeHash: quote.codeHash, tokens, markets };
}
export function loadDexReleaseManifest(path: string): DexReleaseBinding {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error('DEX release manifest must be a regular file below 1 MB.');
    const raw = readFileSync(descriptor, 'utf8');
    const value: unknown = JSON.parse(raw);
    // JSON.parse already checked syntax. Scan structural tokens to reject even equal
    // duplicate values, which JSON parsers may otherwise silently coalesce.
    const containers: Array<{ keys: Set<string> | null; expectsKey: boolean }> = [];
    for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)) {
      const token = match[0];
      if (token === '{' || token === '[') containers.push({ keys: token === '{' ? new Set() : null, expectsKey: true });
      else if (token === '}' || token === ']') containers.pop();
      else {
        const container = containers.at(-1);
        if (token === ',' && container?.keys) container.expectsKey = true;
        else if (token.startsWith('"') && container?.keys && container.expectsKey) {
          const key = JSON.parse(token) as string;
          if (container.keys.has(key)) throw new Error('DEX release manifest contains duplicate JSON keys.');
          container.keys.add(key); container.expectsKey = false;
        }
      }
    }
    return parseDexReleaseManifest(value);
  } finally { closeSync(descriptor); }
}

class DexFailure extends Error {
  constructor(readonly issue: string, readonly stale = false) { super(issue); }
}
function requireValue(condition: unknown, issue: string): asserts condition {
  if (!condition) throw new DexFailure(issue);
}
const integer = (value: unknown, minimum: bigint, maximum: bigint): bigint => {
  const lexeme = typeof value === 'string' || typeof value === 'number' || record(value).isLosslessNumber === true ? String(value) : '';
  requireValue(/^-?(0|[1-9][0-9]*)$/.test(lexeme), 'dex_invalid_integer');
  const parsed = BigInt(lexeme);
  requireValue(parsed >= minimum && parsed <= maximum, 'dex_integer_out_of_range');
  return parsed;
};
const int32 = (value: unknown) => Number(integer(value, -(1n << 31n), (1n << 31n) - 1n));
const uint128 = (value: unknown) => integer(value, 0n, (1n << 128n) - 1n);
const safeInteger = (value: unknown) => Number(integer(value, 0n, BigInt(Number.MAX_SAFE_INTEGER)));
const cell = (value: unknown): Cell => {
  requireValue(typeof value === 'string' && value.length <= 2_000_000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'dex_invalid_cell');
  let cells: Cell[];
  try { cells = Cell.fromBoc(Buffer.from(value, 'base64')); } catch { throw new DexFailure('dex_invalid_cell'); }
  requireValue(cells.length === 1 && !cells[0]!.isExotic, 'dex_invalid_cell');
  return cells[0]!;
};
const tupleNumber = (stack: unknown[], index: number): unknown => {
  const tuple = stack[index];
  requireValue(Array.isArray(tuple) && tuple.length === 2 && tuple[0] === 'num' && typeof tuple[1] === 'string', 'dex_invalid_stack');
  return tuple[1];
};
const tupleAddress = (stack: unknown[], index: number): string => {
  const tuple = stack[index];
  requireValue(Array.isArray(tuple) && tuple.length === 2 && tuple[0] === 'slice', 'dex_invalid_stack');
  const slice = cell(record(tuple[1]).bytes).beginParse();
  let parsed: Address;
  try { parsed = slice.loadAddress(); } catch { throw new DexFailure('dex_invalid_address'); }
  requireValue(slice.remainingBits === 0 && slice.remainingRefs === 0, 'dex_invalid_address');
  return parsed.toRawString();
};
const getter = (value: unknown, size: number): unknown[] => {
  const result = record(value);
  requireValue(integer(result.exit_code, -0x80000000n, 0x7fffffffn) === 0n && Array.isArray(result.stack) && result.stack.length === size, 'dex_getter_failed');
  return result.stack;
};
const account = (value: unknown, expectedHash: string): void => {
  const result = record(value);
  requireValue(result.account_state === 'active', 'dex_account_inactive');
  requireValue(cell(result.code_boc).hash().toString('hex') === expectedHash, 'dex_code_hash_mismatch');
};
const time = (seconds: unknown): number => Number(integer(seconds, 1n, BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)))) * 1000;
const fresh = (timestamp: number, now: number): void => {
  if (timestamp > now + DEX_PRICE_FUTURE_SKEW_MS) throw new DexFailure('dex_future_timestamp');
  if (now - timestamp > DEX_PRICE_MAX_AGE_MS) throw new DexFailure('dex_stale_state', true);
};
const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
/** The pool stores X atomic units per T3 atomic unit. Return T3 units per X. */
export function dexQ64Ratio(q64: bigint, assetDecimals: number, quoteDecimals: number): { numerator: string; denominator: string; price: string } {
  requireValue(q64 > 0n && q64 < 1n << 128n && [assetDecimals, quoteDecimals].every(value => Number.isInteger(value) && value >= 0 && value <= 18), 'dex_invalid_price');
  const numerator = Q64 * 10n ** BigInt(assetDecimals);
  const denominator = q64 * 10n ** BigInt(quoteDecimals);
  const divisor = gcd(numerator, denominator);
  return { numerator: (numerator / divisor).toString(), denominator: (denominator / divisor).toString(),
    price: new Decimal(numerator.toString()).div(denominator.toString()).toFixed() };
}

type Call = { kind: 'account'; address: string } | { kind: 'getter'; address: string; method: string; stack: never[] };
const identity = (binding: DexReleaseBinding) => ({ releaseId: binding.releaseId, manifestHash: binding.manifestHash });
const unavailable = (assetId: string, issue: string, stale = false): DexPriceQuote => ({
  assetId, price: null, observedAt: null, source: 'tonswap-dex', status: 'unavailable', stale, change24h: null,
  evidence: {}, issues: [issue],
});

export class DexPrices {
  constructor(private readonly config: Config, private readonly fetcher: Fetcher = fetch, private readonly clock: () => Date = () => new Date()) {}
  configured(network: Network): boolean {
    const release = this.config.dexRelease;
    return !!release && release.network === network && this.config.networks.includes(network) && this.config.indexerUrls[network] === release.indexerUrl;
  }
  catalogue(network: Network): DexCatalogueEntry[] {
    if (!this.config.dexRelease || this.config.dexRelease.network !== network) return [];
    const release = this.config.dexRelease;
    return release.tokens.map(token => {
      const market = release.markets.find(market => market.assetId === token.assetId);
      return { assetId: token.assetId, symbol: token.symbol, name: token.name, decimals: token.decimals,
        quoteAssetId: release.quoteAssetId, quoteSymbol: 'T3', marketKey: market?.marketKey ?? null,
        marketAddress: market?.address ?? null, priceConfigured: !!market && this.configured(network) };
    });
  }
  async prices(network: Network, assets: string[]): Promise<DexPriceResponse> {
    const requestedAt = this.clock().toISOString();
    const release = this.config.dexRelease?.network === network ? this.config.dexRelease : undefined;
    const response: DexPriceResponse = { network, currency: 'T3', quoteAssetId: release?.quoteAssetId ?? null,
      release: release ? identity(release) : null, requestedAt, quotes: [] };
    if (!release || !this.configured(network)) return { ...response, quotes: assets.map(asset => unavailable(asset, 'dex_release_not_configured')) };
    const markets = release.markets.filter(market => assets.includes(market.assetId));
    const quotes = new Map<string, DexPriceQuote>();
    // 1 shared quote-root account + 7 calls per market stays within readFresh's 32-call limit.
    for (let start = 0; start < markets.length; start += 4) {
      for (const quote of await this.readMarkets(release, markets.slice(start, start + 4))) quotes.set(quote.assetId, quote);
    }
    response.quotes = assets.map(asset => quotes.get(asset) ?? unavailable(asset, 'dex_market_not_in_release'));
    return response;
  }
  private async readMarkets(release: DexReleaseBinding, markets: DexMarketBinding[]): Promise<DexPriceQuote[]> {
    const methods = ['pool_state', 'active_price_q64', 'observation', 'oracle_depth_health', 'perps_oracle_snapshot'];
    const calls: Call[] = [{ kind: 'account', address: release.quoteRoot }];
    for (const market of markets) calls.push({ kind: 'account', address: market.assetId }, { kind: 'account', address: market.address },
      ...methods.map(method => ({ kind: 'getter' as const, address: market.address, method, stack: [] as never[] })));
    try {
      const body = record(await fetchJson(`${release.indexerUrl}/readFresh`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.indexerApiKey ? { authorization: `Bearer ${this.config.indexerApiKey}` } : {}) },
        body: JSON.stringify({ calls }) }, this.fetcher));
      const now = this.clock().getTime();
      requireValue(body.network === release.network && record(body.release).releaseId === release.releaseId &&
        record(body.release).manifestHash === release.manifestHash, 'dex_release_mismatch');
      const context = record(body.readContext), head = record(context.head);
      requireValue(['http4', 'lite'].includes(String(context.source)) && integer(head.workchain, -1n, -1n) === -1n &&
        head.shard === '-9223372036854775808' && typeof head.rootHashHex === 'string' && HASH.test(head.rootHashHex) &&
        typeof head.fileHashHex === 'string' && HASH.test(head.fileHashHex), 'dex_invalid_read_context');
      const seqno = safeInteger(head.seqno), queriedAt = safeInteger(context.queriedAt);
      requireValue(seqno > 0 && queriedAt > 0, 'dex_invalid_read_context');
      fresh(queriedAt, now);
      requireValue(Array.isArray(body.results) && body.results.length === calls.length, 'dex_result_identity_mismatch');
      const results = body.results;
      for (let index = 0; index < calls.length; index++) requireValue(record(results[index]).kind === calls[index]!.kind &&
        record(results[index]).address === calls[index]!.address, 'dex_result_identity_mismatch');
      account(results[0], release.quoteCodeHash);
      return markets.map((market, index) => {
        try {
          const token = release.tokens.find(token => token.assetId === market.assetId)!;
          const offset = 1 + index * 7;
          account(results[offset], token.codeHash); account(results[offset + 1], market.codeHash);
          const state = getter(results[offset + 2], 13), price = getter(results[offset + 3], 2);
          const observation = getter(results[offset + 4], 3), depth = getter(results[offset + 5], 5), snapshot = getter(results[offset + 6], 4);
          requireValue(tupleAddress(state, 0) === release.quoteRoot && tupleAddress(state, 1) === token.root &&
            int32(tupleNumber(state, 4)) === market.binSpacing && safeInteger(tupleNumber(state, 6)) === market.feePips, 'dex_pool_binding_mismatch');
          const activeBin = int32(tupleNumber(price, 0));
          requireValue(activeBin === int32(tupleNumber(state, 5)), 'dex_active_bin_mismatch');
          const q64 = uint128(tupleNumber(price, 1));
          const safetyAvailable = integer(tupleNumber(snapshot, 0), -1n, 0n) === -1n;
          const safetyCell = snapshot[3];
          requireValue(Array.isArray(safetyCell) && safetyCell.length === 2 && safetyCell[0] === 'cell', 'dex_invalid_stack');
          cell(record(safetyCell[1]).bytes);
          const observedMs = time(tupleNumber(snapshot, 1));
          fresh(observedMs, now); fresh(observedMs, queriedAt);
          const observationMs = time(tupleNumber(observation, 1));
          requireValue(observationMs === time(tupleNumber(snapshot, 2)) && observationMs <= observedMs, 'dex_activity_timestamp_mismatch');
          const healthy = integer(tupleNumber(depth, 0), 0n, 1n) === 1n;
          const healthySince = time(tupleNumber(depth, 1));
          const executableT3 = uint128(tupleNumber(depth, 2)), executableAsset = uint128(tupleNumber(depth, 3));
          requireValue(healthy && executableT3 > 0n && executableAsset > 0n, 'dex_insufficient_executable_liquidity');
          requireValue(healthySince <= observedMs && safeInteger(tupleNumber(depth, 4)) <= (observedMs - healthySince) / 1000, 'dex_depth_timestamp_mismatch');
          const ratio = dexQ64Ratio(q64, token.decimals, release.quoteDecimals);
          const observedAt = new Date(observedMs).toISOString();
          return { assetId: token.assetId, price: ratio.price, observedAt, source: 'tonswap-dex', status: 'available', stale: false,
            change24h: null, issues: [], evidence: { method: 'active_pool_q64', precision: 'indicative_display', network: release.network,
              assetId: token.assetId, currency: 'T3', quoteAssetId: release.quoteAssetId, release: identity(release),
              marketKey: market.marketKey, marketAddress: market.address, codeHash: market.codeHash,
              observedAt, queriedAt: new Date(queriedAt).toISOString(), source: `ton-indexer/${context.source}`,
              head: { workchain: -1, shard: head.shard, seqno, rootHashHex: head.rootHashHex, fileHashHex: head.fileHashHex },
              exactRatio: { numerator: ratio.numerator, denominator: ratio.denominator }, activeBin, q64: q64.toString(),
              perpsOracleSafetyAvailable: safetyAvailable,
              lastMarketObservationAt: new Date(observationMs).toISOString(), executableDepthT3Raw: executableT3.toString(),
              executableDepthAssetRaw: executableAsset.toString(),
              rootBindings: { assetRoot: token.root, quoteRoot: release.quoteRoot, assetCodeHash: token.codeHash, quoteCodeHash: release.quoteCodeHash },
            } } satisfies DexPriceQuote;
        } catch (error) { return unavailable(market.assetId, error instanceof DexFailure ? error.issue : 'dex_invalid_response', error instanceof DexFailure && error.stale); }
      });
    } catch (error) { return markets.map(market => unavailable(market.assetId, error instanceof DexFailure ? error.issue : 'dex_source_unavailable', error instanceof DexFailure && error.stale)); }
  }
}
