import type { Network } from './index';
import { createHash } from 'node:crypto';

export const RUNTIME_CONTRACT_ROLES = [
  'Governance', 'USDT', 'USDC', 'KUSD', 'T3Hub', 'Treasury', 'GasVault', 'BuybackExecutor', 'FeeRouter',
  'DlmmPoolFactory', 'SwapCoordinator', 'SpotOrderFactory', 'EmissionsSplitter', 'ReferralRegistry', 'SaleFactory',
  'RiskVault', 'PerpsEngine', 'OptionVault', 'OptionFactory', 'OptionSeriesManager',
  'CoverVault', 'ParisianPolicyManager', 'CoverAutomationUpkeep',
  'GenesisDistributor', 'TSMinter', 'MerkleClaim', 'Remint', 'TestnetFaucet',
] as const;
export const RUNTIME_TEMPLATES = ['T3Wallet', 'T3RecoveryProof', 'JettonV21Wallet', 'DlmmPool', 'SpotOrder', 'ShoutOption', 'OutperformanceOption', 'SaleFixed', 'SaleBonding', 'SaleAuction', 'VestingVault', 'LpVault'] as const;

export type RuntimeRole = typeof RUNTIME_CONTRACT_ROLES[number];
export type RuntimeTemplate = typeof RUNTIME_TEMPLATES[number];
export type ReleaseAsset = { path: string; sha256: string; bytes: number };
export type JettonWalletBudget = {
  senderGas: number; walletBounceGas: number; burnWalletGas: number; smallPayloadCells: number;
  largeWalletGas: number; largeSenderGas: number; rentSeconds: number; rentBits: number; rentCells: number;
  initBits: number; initCells: number; initCopies: number; transferBits: number; transferCells: number;
  transferCopies: number; creditProtection: boolean;
};
export type RuntimeReleaseManifest = {
  schema: 'tonswap-release-v1';
  network: 'ton:mainnet' | 'ton:testnet' | 'ton:localnet';
  globalId: number;
  releaseId: string;
  createdAt: string;
  source: { contracts: string; build: string };
  services: { indexer: string; tonRpc: string; platform: string };
  contracts: Partial<Record<RuntimeRole, { address: string; codeHash: string }>>;
  templates: Record<RuntimeTemplate, string>;
  tokens: Array<{ symbol: string; root: string; decimals: number; masterCodeHash: string; walletCodeHash: string }>;
  vendor: { stablecoin: { provenance: ReleaseAsset; minter: ReleaseAsset & { codeHash: string }; wallet: ReleaseAsset & { codeHash: string } } };
  campaign: { id: string; root: string; count: number; total: string; start: number; leaves: ReleaseAsset; proofs: ReleaseAsset };
  supplyBase: string;
  orderKeeper: { address: string };
  spotMarkets: Array<{ symbol: string; pool: string; binSpacing: number; feePips: number; xDecimals: number; walletGasX: number; walletGramX: string; walletBudgetX: JettonWalletBudget }>;
  perpsMarkets: Array<{ marketId: number; symbol: string; pool: string }>;
  options: Array<{ templateId: number; kind: 'shout' | 'outperformance'; symbol: string; comparisonSymbol?: string;
    seriesId?: string; option?: string; expiry?: string }>;
  manifestHash: string;
};

export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export function hashReleaseManifest(value: Record<string, unknown>): string {
  const { manifestHash: omitted, ...rest } = value;
  return createHash('sha256').update(stableJson(rest)).digest('hex');
}

export function releaseServiceUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value !== value.trim() || !/^https?:\/\//.test(value)) return null;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url;
  } catch { return null; }
}
const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const isDigest = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const isAddress = (x: unknown): x is string => typeof x === 'string' && /^0:[0-9a-f]{64}$/.test(x) && x !== `0:${'0'.repeat(64)}`;
const isUint = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const isInt = (x: unknown, min: number, max: number): x is number => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
const isSymbol = (x: unknown): x is string => typeof x === 'string' && /^[A-Z0-9_.$-]{1,32}$/.test(x);
const sameKeys = (value: unknown, keys: readonly string[]) => isObject(value) && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
const KEYS = ['schema', 'network', 'globalId', 'releaseId', 'createdAt', 'source', 'services', 'contracts', 'templates', 'tokens',
  'spotMarkets', 'perpsMarkets', 'options', 'vendor', 'campaign', 'supplyBase', 'orderKeeper', 'manifestHash'];
const GLOBAL_ID: Record<string, number> = { 'ton:mainnet': -239, 'ton:testnet': -3, 'ton:localnet': -3 };
const isStableIndexer = (value: unknown) => { const url = releaseServiceUrl(value); return !!url && value === `${url.origin}/api/indexer`; };
export const validReleaseAsset = (a: unknown): a is ReleaseAsset => isObject(a) && isDigest(a.sha256)
  && (a.path === `release-assets/${a.sha256}.json` || a.path === `release-assets/${a.sha256}.boc`) && isInt(a.bytes, 1, 512 * 1024 * 1024);
const WALLET_BUDGET_WIDTHS: Record<string, number> = { senderGas: 32, walletBounceGas: 32, burnWalletGas: 32, smallPayloadCells: 16,
  largeWalletGas: 32, largeSenderGas: 32, rentSeconds: 32, rentBits: 32, rentCells: 16, initBits: 32, initCells: 16, initCopies: 8,
  transferBits: 16, transferCells: 8, transferCopies: 8 };
export function validJettonWalletProfile(walletGas: unknown, walletGram: unknown, budget: unknown): boolean {
  if (!isUint(walletGram) || !isObject(budget) || !sameKeys(budget, [...Object.keys(WALLET_BUDGET_WIDTHS), 'creditProtection'])) return false;
  if (!Object.entries(WALLET_BUDGET_WIDTHS).every(([key, width]) => isInt(budget[key], key === 'walletBounceGas' ? 0 : 1, 2 ** width - 1))) return false;
  return typeof budget.creditProtection === 'boolean' && budget.walletBounceGas <= 500000 && budget.senderGas >= 10000
    && budget.initCopies <= 4 && budget.transferBits >= 880 && budget.transferCopies >= 3 && budget.transferCopies <= 8
    && isInt(walletGas, 10000, 500000) && budget.senderGas <= walletGas && budget.burnWalletGas >= budget.senderGas
    && budget.burnWalletGas <= 2000000 && budget.largeSenderGas >= budget.senderGas && budget.largeWalletGas >= walletGas
    && budget.largeSenderGas <= budget.largeWalletGas && budget.largeWalletGas <= 2000000 && BigInt(walletGram) <= 500000000n;
}
export function validateReleaseManifest(x: unknown): { ok: true; m: RuntimeReleaseManifest } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const need = (ok: unknown, label: string) => { if (!ok) errors.push(label); };
    if (!isObject(x)) return { ok: false, errors: ['manifest must be an object'] };
    need(stableJson(Object.keys(x).sort()) === stableJson([...KEYS].sort()), 'top-level keys');
    need(x.schema === 'tonswap-release-v1', 'schema');
    need(typeof x.network === 'string' && Object.hasOwn(GLOBAL_ID, x.network) && x.globalId === GLOBAL_ID[x.network], 'network/globalId');
    need(typeof x.releaseId === 'string' && /^[a-z]+-[A-Za-z0-9._-]+-[0-9a-f]{12}$/.test(x.releaseId)
        && isObject(x.source) && x.releaseId.endsWith(`-${String(x.source.build).slice(0, 12)}`), 'releaseId');
    need(typeof x.createdAt === 'string' && !Number.isNaN(Date.parse(x.createdAt)), 'createdAt');
    need(sameKeys(x.source, ['contracts', 'build']) && typeof x.source.contracts === 'string' && /^[0-9a-f]{40}$/.test(x.source.contracts)
        && isDigest(x.source.build), 'source');
    need(sameKeys(x.services, ['indexer', 'tonRpc', 'platform']) && ['indexer', 'tonRpc', 'platform'].every(k => releaseServiceUrl(x.services[k])), 'services');
    need(isStableIndexer(x.services?.indexer), 'services.indexer must use /api/indexer');

    const addresses = new Set<string>();
    const unique = (a: string, label: string) => { need(!addresses.has(a), `${label} duplicates an address`); addresses.add(a); };
    need(isObject(x.contracts) && Object.keys(x.contracts).length > 0, 'contracts');
    for (const [role, c] of Object.entries(isObject(x.contracts) ? x.contracts : {})) {
        need((RUNTIME_CONTRACT_ROLES as readonly string[]).includes(role), `contracts.${role} is not a role`);
        need(sameKeys(c, ['address', 'codeHash']) && isObject(c) && isAddress(c.address) && isDigest(c.codeHash), `contracts.${role}`);
        if (isObject(c) && isAddress(c.address)) unique(c.address, `contracts.${role}`);
    }
    need(isObject(x.templates) && stableJson(Object.keys(x.templates).sort()) === stableJson([...RUNTIME_TEMPLATES].sort())
        && Object.values(x.templates).every(isDigest), 'templates');

    const vendor = x.vendor?.stablecoin;
    need(sameKeys(x.vendor, ['stablecoin']) && sameKeys(vendor, ['provenance', 'minter', 'wallet']) && isObject(vendor)
        && sameKeys(vendor.provenance, ['path', 'sha256', 'bytes'])
        && [vendor.minter, vendor.wallet].every(asset => sameKeys(asset, ['path', 'sha256', 'bytes', 'codeHash'])) && validReleaseAsset(vendor.provenance) && isDigest(vendor.minter?.codeHash) && validReleaseAsset(vendor.minter)
        && isDigest(vendor.wallet?.codeHash) && validReleaseAsset(vendor.wallet), 'vendor');
    const campaign = x.campaign;
    need(sameKeys(campaign, ['id', 'root', 'count', 'total', 'start', 'leaves', 'proofs']) && isObject(campaign)
        && [campaign.leaves, campaign.proofs].every(asset => sameKeys(asset, ['path', 'sha256', 'bytes'])) && isUint(campaign.id) && BigInt(campaign.id) < (1n << 256n) && isDigest(campaign.root)
        && isInt(campaign.count, 1, 2 ** 24) && isUint(campaign.total) && BigInt(campaign.total) > 0n && BigInt(campaign.total) < (1n << 120n)
        && isInt(campaign.start, 0, 0xffffffff) && validReleaseAsset(campaign.leaves) && validReleaseAsset(campaign.proofs), 'campaign');
    need(isUint(x.supplyBase) && isUint(campaign?.total) && BigInt(x.supplyBase) <= BigInt(campaign.total), 'supplyBase');
    const keeper = x.orderKeeper;
    need(sameKeys(keeper, ['address']) && isObject(keeper) && isAddress(keeper.address), 'orderKeeper');
    if (isObject(keeper) && isAddress(keeper.address)) unique(keeper.address, 'orderKeeper');

    const tokens: any[] = Array.isArray(x.tokens) ? x.tokens : [];
    need(Array.isArray(x.tokens) && tokens.some(t => t?.symbol === 'T3'), 'tokens');
    const symbols = new Set<string>(), roots = new Set<string>();
    tokens.forEach((t, i) => {
        need(sameKeys(t, ['symbol', 'root', 'decimals', 'masterCodeHash', 'walletCodeHash']) && isObject(t) && isSymbol(t.symbol) && !symbols.has(t.symbol) && isAddress(t.root) && !roots.has(t.root)
            && isInt(t.decimals, 0, 18) && isDigest(t.masterCodeHash) && isDigest(t.walletCodeHash), `tokens[${i}]`);
        symbols.add(t?.symbol); roots.add(t?.root);
    });
    if (isObject(x.contracts)) for (const token of tokens) {
        if (!isObject(token) || !isSymbol(token.symbol)) continue;
        const role = token.symbol === 'T3' ? 'T3Hub' : token.symbol === 'TS' ? 'TSMinter' : token.symbol;
        need(token.root === x.contracts[role]?.address && token.masterCodeHash === x.contracts[role]?.codeHash, `tokens.${token.symbol} master`);
        if (token.symbol === 'T3' || token.symbol === 'TS') need(token.walletCodeHash === x.templates?.[token.symbol === 'T3' ? 'T3Wallet' : 'JettonV21Wallet'], `tokens.${token.symbol} wallet`);
    }

    const spots: any[] = Array.isArray(x.spotMarkets) ? x.spotMarkets : [];
    need(Array.isArray(x.spotMarkets) && spots.length > 0, 'spotMarkets');
    const spotSymbols = new Set<string>();
    spots.forEach((s, i) => {
        const profile = validJettonWalletProfile(s?.walletGasX, s?.walletGramX, s?.walletBudgetX);
        need(sameKeys(s, ['symbol', 'pool', 'binSpacing', 'feePips', 'xDecimals', 'walletGasX', 'walletGramX', 'walletBudgetX']) && isObject(s) && s.symbol !== 'T3' && symbols.has(s.symbol) && !spotSymbols.has(s.symbol) && isAddress(s.pool)
            && profile && s.xDecimals === tokens.find(t => t?.symbol === s.symbol)?.decimals && !roots.has(s.pool) && isInt(s.binSpacing, 1, 0x7fffffff) && isInt(s.feePips, 0, 0xffffffff), `spotMarkets[${i}]`);
        if (isObject(s)) { spotSymbols.add(s.symbol); unique(s.pool, `spotMarkets[${i}]`); }
    });
    const pool = (symbol: unknown) => spots.find(s => s?.symbol === symbol)?.pool;

    const perps: any[] = Array.isArray(x.perpsMarkets) ? x.perpsMarkets : [];
    need(Array.isArray(x.perpsMarkets), 'perpsMarkets');
    const marketIds = new Set<number>();
    perps.forEach((m, i) => {
        need(sameKeys(m, ['marketId', 'symbol', 'pool']) && isObject(m) && isInt(m.marketId, 1, 0xffffffff) && !marketIds.has(m.marketId) && isSymbol(m.symbol)
            && spotSymbols.has(m.symbol) && isAddress(m.pool) && pool(m.symbol) === m.pool, `perpsMarkets[${i}]`);
        marketIds.add(m?.marketId);
    });

    const options: any[] = Array.isArray(x.options) ? x.options : [];
    need(Array.isArray(x.options), 'options');
    const series = new Set<string>();
    options.forEach((o, i) => {
        const label = `options[${i}]`;
        if (!isObject(o)) return errors.push(label);
        need(Object.keys(o).every(key => ['templateId', 'kind', 'symbol', 'comparisonSymbol', 'seriesId', 'option', 'expiry'].includes(key)), label + '.keys');
        need(isInt(o.templateId, 1, 0xffffffff) && ['shout', 'outperformance'].includes(o.kind) && spotSymbols.has(o.symbol), label);
        need(o.kind === 'outperformance' ? spotSymbols.has(o.comparisonSymbol) && o.comparisonSymbol !== o.symbol : !('comparisonSymbol' in o),
            `${label}.comparisonSymbol`);
        const listed = ['seriesId', 'option', 'expiry'].filter(k => k in o).length;
        need(listed === 0 || (listed === 3 && isUint(o.seriesId) && !series.has(o.seriesId) && isAddress(o.option) && isUint(o.expiry)), `${label}.series`);
        if (listed === 3) { series.add(o.seriesId); unique(o.option, label); }
    });
    try { need(isDigest(x.manifestHash) && x.manifestHash === hashReleaseManifest(x as RuntimeReleaseManifest), 'manifestHash'); }
    catch { need(false, 'manifestHash'); }
    return errors.length ? { ok: false, errors } : { ok: true, m: x as RuntimeReleaseManifest };
}

const assertNoDuplicateJsonObjectKeys = (raw: string): void => {
  let index = 0;
  const fail = (message: string): never => {
    throw new Error(`Release manifest JSON is not canonical: ${message} at byte ${index}.`);
  };
  const whitespace = () => {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
  };
  const string = (): string => {
    const start = index;
    if (raw[index] !== '"') fail('expected string');
    index += 1;
    while (index < raw.length) {
      const character = raw[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(raw.slice(start, index)) as string;
      }
      if (character === '\\') {
        index += 1;
        if (index >= raw.length) fail('unterminated string escape');
        if (raw[index] === 'u') {
          const codepoint = raw.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(codepoint)) fail('invalid Unicode escape');
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(raw[index])) fail('invalid string escape');
      } else if (character.charCodeAt(0) < 0x20) {
        fail('unescaped control character');
      }
      index += 1;
    }
    return fail('unterminated string');
  };
  const value = (): void => {
    whitespace();
    const character = raw[index];
    if (character === '{') {
      object();
      return;
    }
    if (character === '[') {
      array();
      return;
    }
    if (character === '"') {
      string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (raw.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) return fail('invalid JSON value');
    index += number[0].length;
  };
  const array = (): void => {
    index += 1;
    whitespace();
    if (raw[index] === ']') {
      index += 1;
      return;
    }
    while (index < raw.length) {
      value();
      whitespace();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      if (raw[index] !== ',') fail('expected array comma');
      index += 1;
    }
    fail('unterminated array');
  };
  const object = (): void => {
    index += 1;
    whitespace();
    const keys = new Set<string>();
    if (raw[index] === '}') {
      index += 1;
      return;
    }
    while (index < raw.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (raw[index] !== ':') fail('expected object colon');
      index += 1;
      value();
      whitespace();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      if (raw[index] !== ',') fail('expected object comma');
      index += 1;
    }
    fail('unterminated object');
  };

  value();
  whitespace();
  if (index !== raw.length) fail('trailing JSON content');
};

export function parseRuntimeReleaseManifest(value: unknown, expectedNetwork: Network): RuntimeReleaseManifest {
  const result = validateReleaseManifest(value);
  if (result.ok === false) {
    if (result.errors.includes('schema')) throw Error('Release manifest schema must be tonswap-release-v1');
    if (result.errors.includes('manifestHash')) throw Error('Release manifest manifestHash does not match its canonical contents');
    throw Error(`Release manifest is invalid: ${result.errors.join(', ')}`);
  }
  if (result.m.network !== `ton:${expectedNetwork}`)
    throw Error(`Release manifest network mismatch: expected ${expectedNetwork}, got ${result.m.network}`);
  return result.m;
}
export function parseRuntimeReleaseManifestText(raw: string, expectedNetwork: Network): RuntimeReleaseManifest {
  assertNoDuplicateJsonObjectKeys(raw);
  return parseRuntimeReleaseManifest(JSON.parse(raw), expectedNetwork);
}
