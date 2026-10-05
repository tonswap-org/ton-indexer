import type { Network } from './index';

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

const object = (x: unknown): x is Record<string, any> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(x).sort().join(',') === [...expected].sort().join(',');
const hash = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const address = (x: unknown): x is string => typeof x === 'string' && /^0:[0-9a-f]{64}$/.test(x) && x !== `0:${'0'.repeat(64)}`;
const integer = (x: unknown, min: number, max: number) => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
const uint = (x: unknown) => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const symbol = (x: unknown): x is string => typeof x === 'string' && /^[A-Z0-9_.$-]{1,32}$/.test(x);
const need: (ok: unknown, label: string) => asserts ok = (ok, label) => { if (!ok) throw Error(`Release manifest ${label} is invalid`); };

/** The sole runtime schema produced by deploy/manifest.ts. Its identities are
 * configuration pins; they never prove current oracle or economic readiness. */
export function parseRuntimeReleaseManifest(value: unknown, expectedNetwork: Network): RuntimeReleaseManifest {
  need(object(value), 'object');
  need(value.schema === 'tonswap-release-v1', 'schema must be tonswap-release-v1');
  need(keys(value, ['schema', 'network', 'globalId', 'releaseId', 'createdAt', 'source', 'services', 'contracts',
    'templates', 'tokens', 'spotMarkets', 'perpsMarkets', 'options', 'manifestHash']), 'top-level fields');
  need(value.network === `ton:${expectedNetwork}`, `network mismatch: expected ${expectedNetwork}`);
  need(value.globalId === (expectedNetwork === 'mainnet' ? -239 : -3), 'network/globalId');
  need(object(value.source) && keys(value.source, ['contracts', 'build']) &&
    typeof value.source.contracts === 'string' && /^[0-9a-f]{40}$/.test(value.source.contracts) && hash(value.source.build), 'source');
  need(typeof value.releaseId === 'string' && /^[a-z]+-[A-Za-z0-9._-]+-[0-9a-f]{12}$/.test(value.releaseId) &&
    value.releaseId.startsWith(`${expectedNetwork}-`) && value.releaseId.endsWith(`-${value.source.build.slice(0, 12)}`), 'releaseId');
  need(typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)), 'createdAt');
  need(object(value.services) && keys(value.services, ['indexer', 'tonRpc', 'platform']), 'services');
  for (const [key, raw] of Object.entries(value.services)) {
    try {
      need(typeof raw === 'string', `services.${key}`);
      const url = new URL(raw);
      need(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, `services.${key}`);
    } catch { throw Error(`Release manifest services.${key} is invalid`); }
  }
  need(object(value.contracts) && Object.keys(value.contracts).length > 0, 'contracts');
  const used = new Set<string>();
  const unique = (raw: string, label: string) => { need(!used.has(raw), `${label} duplicates an address`); used.add(raw); };
  for (const [role, c] of Object.entries(value.contracts)) {
    need((RUNTIME_CONTRACT_ROLES as readonly string[]).includes(role), `contracts.${role} role`);
    need(object(c) && keys(c, ['address', 'codeHash']) && address(c.address) && hash(c.codeHash), `contracts.${role}`);
    unique(c.address, `contracts.${role}`);
  }
  need(object(value.templates) && keys(value.templates, RUNTIME_TEMPLATES) && Object.values(value.templates).every(hash), 'templates');
  need(Array.isArray(value.tokens) && value.tokens.length > 0, 'tokens');
  const symbols = new Set<string>(), roots = new Set<string>();
  for (const [i, token] of value.tokens.entries()) {
    need(object(token) && keys(token, ['symbol', 'root', 'decimals']) && symbol(token.symbol) && !symbols.has(token.symbol) &&
      address(token.root) && !roots.has(token.root) && integer(token.decimals, 0, 18), `tokens[${i}]`);
    const role = token.symbol === 'T3' || token.symbol === 'TS' ? `${token.symbol}Root` : token.symbol;
    if (value.contracts[role]) need(value.contracts[role].address === token.root, `tokens.${token.symbol} root binding`);
    need(!used.has(token.root) || value.contracts[role]?.address === token.root, `tokens.${token.symbol} singleton collision`);
    symbols.add(token.symbol); roots.add(token.root);
  }
  const t3 = value.tokens.find((token: any) => token.symbol === 'T3');
  need(value.contracts.T3Root && t3?.root === value.contracts.T3Root.address && t3.decimals === 9, 'tokens.T3 root/precision');
  const ts = value.tokens.find((token: any) => token.symbol === 'TS');
  if (value.contracts.TSRoot) need(ts?.root === value.contracts.TSRoot.address && ts.decimals === 9, 'tokens.TS root/precision');

  need(Array.isArray(value.spotMarkets) && value.spotMarkets.length > 0 && value.spotMarkets.length <= 256, 'spotMarkets');
  const spots = new Map<string, any>();
  for (const [i, spot] of value.spotMarkets.entries()) {
    need(object(spot) && keys(spot, ['symbol', 'pool', 'binSpacing', 'feePips']) && spot.symbol !== 'T3' && symbols.has(spot.symbol) &&
      !spots.has(spot.symbol) && address(spot.pool) && !roots.has(spot.pool) && integer(spot.binSpacing, 1, 0x7fffffff) &&
      integer(spot.feePips, 0, 0xffffffff), `spotMarkets[${i}]`);
    unique(spot.pool, `spotMarkets[${i}]`); spots.set(spot.symbol, spot);
  }
  need(Array.isArray(value.perpsMarkets), 'perpsMarkets');
  if (value.perpsMarkets.length) need(value.contracts.PerpsEngine, 'perpsMarkets engine binding');
  const marketIds = new Set<number>();
  for (const [i, market] of value.perpsMarkets.entries()) {
    need(object(market) && keys(market, ['marketId', 'symbol', 'pool']) && integer(market.marketId, 1, 4) &&
      !marketIds.has(market.marketId) && spots.get(market.symbol)?.pool === market.pool, `perpsMarkets[${i}] pool/ID binding`);
    marketIds.add(market.marketId);
  }
  need(Array.isArray(value.options), 'options');
  if (value.options.length) need(value.contracts.OptionFactory && value.contracts.OptionVault, 'options factory/vault binding');
  const series = new Set<string>(), templates = new Map<number, string>();
  for (const [i, option] of value.options.entries()) {
    const label = `options[${i}]`;
    need(object(option), label);
    const listed = ['seriesId', 'option', 'expiry'].filter(key => Object.hasOwn(option, key)).length;
    const expected = ['templateId', 'kind', 'symbol', ...(option.kind === 'outperformance' ? ['comparisonSymbol'] : []),
      ...(listed ? ['seriesId', 'option', 'expiry'] : [])];
    need(keys(option, expected) && integer(option.templateId, 1, 0xffffffff) && ['shout', 'outperformance'].includes(option.kind) &&
      spots.has(option.symbol), `${label} template`);
    if (option.kind === 'outperformance') need(spots.has(option.comparisonSymbol) && option.comparisonSymbol !== option.symbol, `${label} comparison`);
    const identity = `${option.kind}:${option.symbol}:${option.comparisonSymbol ?? ''}`;
    need(!templates.has(option.templateId) || templates.get(option.templateId) === identity, `${label} conflicting template`);
    templates.set(option.templateId, identity);
    need(listed === 0 || (listed === 3 && uint(option.seriesId) && BigInt(option.seriesId) > 0n && BigInt(option.seriesId) <= (1n << 64n) - 1n &&
      !series.has(option.seriesId) && address(option.option) && !roots.has(option.option) && uint(option.expiry) && BigInt(option.expiry) > 0n), `${label} series`);
    if (listed) { series.add(option.seriesId); unique(option.option, label); }
  }
  need(hash(value.manifestHash), 'manifestHash');
  return value as RuntimeReleaseManifest;
}
