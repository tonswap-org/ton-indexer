import type { Network } from './index';
import { createHash } from 'node:crypto';

export const RUNTIME_CONTRACT_ROLES = [
  'T3Root', 'TSRoot', 'USDT', 'USDC', 'KUSD', 'ActivationGate', 'T3',
  'GovernanceRegistry', 'GovernanceTimelock', 'GovernanceProposalExecutor', 'Treasury', 'FeeRouter', 'GasVault',
  'ControlMesh', 'RiskController', 'RiskVault', 'PerpsEngine', 'InsuranceVault', 'DexRouter', 'DlmmSeedingExecutor',
  'OptionFactory', 'OptionSeriesManager', 'VolIndex', 'OptionVault', 'ParisianPolicyManager', 'CoverVault',
  'ReferralRegistry', 'ReferralDistributor', 'EmissionsSplitter', 'BuybackExecutor', 'SaleFactory', 'Voting',
  'AutomationRegistry', 'AutomationJobQueue', 'AnchorGuard',
  'PerpsOracleUpkeep', 'ControlMeshUpkeep', 'T3Upkeep', 'CoverAutomationUpkeep',
  'DlmmRegistry', 'DlmmPoolFactory', 'TestnetFaucet',
] as const;
export const RUNTIME_TEMPLATES = ['JettonWallet', 'T3Receiver', 'DlmmPool', 'ShoutOption', 'OutperformanceOption',
  'SaleFixed', 'SaleBonding', 'SaleAuction', 'VestingVault', 'LpVault', 'NativeReturnCollector'] as const;
export type RuntimeRole = typeof RUNTIME_CONTRACT_ROLES[number];
export type RuntimeTemplate = typeof RUNTIME_TEMPLATES[number];
export type RuntimeReleaseManifest = {
  schema: 'tonswap-release-v1';
  network: `ton:${Network}`;
  globalId: number;
  releaseId: string;
  createdAt: string;
  source: { contracts: string; build: string };
  services: { indexer: string; tonRpc: string; platform: string };
  contracts: Partial<Record<RuntimeRole, { address: string; codeHash: string }>>;
  templates: Record<RuntimeTemplate, string>;
  tokens: Array<{ symbol: string; root: string; decimals: number }>;
  spotMarkets: Array<{ symbol: string; pool: string; binSpacing: number; feePips: number }>;
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

const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const DIGEST = /^[0-9a-f]{64}$/;
const isDigest = (x: unknown): x is string => typeof x === 'string' && DIGEST.test(x);
const isAddress = (x: unknown) => typeof x === 'string' && /^0:[0-9a-f]{64}$/.test(x) && x !== `0:${'0'.repeat(64)}`;
const isUint = (x: unknown) => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const isInt = (x: unknown, min: number, max: number) => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
const SYMBOL = /^[A-Z0-9_.$-]{1,32}$/;
const KEYS = ['schema', 'network', 'globalId', 'releaseId', 'createdAt', 'source', 'services', 'contracts', 'templates', 'tokens',
    'spotMarkets', 'perpsMarkets', 'options', 'manifestHash'];
const GLOBAL_ID: Record<string, number> = { 'ton:mainnet': -239, 'ton:testnet': -3, 'ton:localnet': -3 };

/** Shape plus address, spot and instrument invariants; no policy literals. */
export function validateReleaseManifest(x: unknown): { ok: true; m: RuntimeReleaseManifest } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const need = (ok: unknown, label: string) => { if (!ok) errors.push(label); };
    if (!isObject(x)) return { ok: false, errors: ['manifest must be an object'] };
    need(stableJson(Object.keys(x).sort()) === stableJson([...KEYS].sort()), 'top-level keys');
    need(x.schema === 'tonswap-release-v1', 'schema');
    need(x.network in GLOBAL_ID && x.globalId === GLOBAL_ID[x.network], 'network/globalId');
    need(typeof x.releaseId === 'string' && /^[a-z]+-[A-Za-z0-9._-]+-[0-9a-f]{12}$/.test(x.releaseId)
        && isObject(x.source) && x.releaseId.endsWith(`-${String(x.source.build).slice(0, 12)}`), 'releaseId');
    need(typeof x.createdAt === 'string' && !Number.isNaN(Date.parse(x.createdAt)), 'createdAt');
    need(isObject(x.source) && typeof x.source.contracts === 'string' && /^[0-9a-f]{40}$/.test(x.source.contracts)
        && isDigest(x.source.build), 'source');
    need(isObject(x.services) && ['indexer', 'tonRpc', 'platform'].every(k => typeof x.services[k] === 'string' && /^https?:\/\//.test(x.services[k])), 'services');

    const addresses = new Set<string>();
    const unique = (a: string, label: string) => { need(!addresses.has(a), `${label} duplicates an address`); addresses.add(a); };
    need(isObject(x.contracts) && Object.keys(x.contracts).length > 0, 'contracts');
    for (const [role, c] of Object.entries(isObject(x.contracts) ? x.contracts : {})) {
        need((RUNTIME_CONTRACT_ROLES as readonly string[]).includes(role), `contracts.${role} is not a role`);
        need(isObject(c) && isAddress(c.address) && isDigest(c.codeHash), `contracts.${role}`);
        if (isObject(c)) unique(c.address, `contracts.${role}`);
    }
    need(isObject(x.templates) && stableJson(Object.keys(x.templates).sort()) === stableJson([...RUNTIME_TEMPLATES].sort())
        && Object.values(x.templates).every(isDigest), 'templates');

    const tokens: any[] = Array.isArray(x.tokens) ? x.tokens : [];
    need(Array.isArray(x.tokens) && tokens.some(t => t?.symbol === 'T3'), 'tokens');
    const symbols = new Set<string>(), roots = new Set<string>();
    tokens.forEach((t, i) => {
        need(isObject(t) && typeof t.symbol === 'string' && SYMBOL.test(t.symbol) && !symbols.has(t.symbol) && isAddress(t.root) && !roots.has(t.root)
            && isInt(t.decimals, 0, 18), `tokens[${i}]`);
        symbols.add(t?.symbol); roots.add(t?.root);
    });
    if (isObject(x.contracts)) need(tokens.find(t => t?.symbol === 'T3')?.root === x.contracts.T3Root?.address, 'tokens.T3 root');

    const spots: any[] = Array.isArray(x.spotMarkets) ? x.spotMarkets : [];
    need(Array.isArray(x.spotMarkets) && spots.length > 0, 'spotMarkets');
    const spotSymbols = new Set<string>();
    spots.forEach((s, i) => {
        need(isObject(s) && s.symbol !== 'T3' && symbols.has(s.symbol) && !spotSymbols.has(s.symbol) && isAddress(s.pool)
            && !roots.has(s.pool) && isInt(s.binSpacing, 1, 0x7fffffff) && isInt(s.feePips, 0, 0xffffffff), `spotMarkets[${i}]`);
        if (isObject(s)) { spotSymbols.add(s.symbol); unique(s.pool, `spotMarkets[${i}]`); }
    });
    const pool = (symbol: unknown) => spots.find(s => s?.symbol === symbol)?.pool;

    const perps: any[] = Array.isArray(x.perpsMarkets) ? x.perpsMarkets : [];
    need(Array.isArray(x.perpsMarkets), 'perpsMarkets');
    const marketIds = new Set<number>();
    perps.forEach((m, i) => {
        need(isObject(m) && isInt(m.marketId, 1, 0xffffffff) && !marketIds.has(m.marketId)
            && typeof m.symbol === 'string' && spotSymbols.has(m.symbol) && isAddress(m.pool)
            && pool(m.symbol) === m.pool, `perpsMarkets[${i}]`);
        marketIds.add(m?.marketId);
    });

    const options: any[] = Array.isArray(x.options) ? x.options : [];
    need(Array.isArray(x.options), 'options');
    const series = new Set<string>();
    options.forEach((o, i) => {
        const label = `options[${i}]`;
        if (!isObject(o)) return errors.push(label);
        need(isInt(o.templateId, 1, 0xffffffff) && ['shout', 'outperformance'].includes(o.kind) && spotSymbols.has(o.symbol), label);
        need(o.kind === 'outperformance' ? spotSymbols.has(o.comparisonSymbol) && o.comparisonSymbol !== o.symbol : !('comparisonSymbol' in o),
            `${label}.comparisonSymbol`);
        const listed = ['seriesId', 'option', 'expiry'].filter(k => k in o).length;
        need(listed === 0 || (listed === 3 && isUint(o.seriesId) && !series.has(o.seriesId) && isAddress(o.option) && isUint(o.expiry)), `${label}.series`);
        if (listed === 3) { series.add(o.seriesId); unique(o.option, label); }
    });
    need(typeof x.manifestHash === 'string' && x.manifestHash === hashReleaseManifest(x as RuntimeReleaseManifest), 'manifestHash');
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
