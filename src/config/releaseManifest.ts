import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Network } from './index';
import { parseRuntimeReleaseManifest, parseRuntimeReleaseManifestText, type RuntimeReleaseManifest } from './runtimeManifest';
export { hashReleaseManifest } from './runtimeManifest';


export type RegistryMarketMetadata = {
  saleModel?: 'fixed' | 'bonding' | 'dutch';
  marketKey: string;
  marketAddress: string;
  tokenRoot: string;
  sale?: string;
  lpVault?: string;
  optionAddress?: string;
  perpsMarketId: number;
  perpsPool: string;
  perpsPoolCodeHash: string;
  perpsCandleMarketKey: string;
  optionSeriesId?: string;
  coverPolicyId?: string;
  assetSymbol: string;
  quoteSymbol: string;
  assetDecimals: number;
  quoteDecimals: number;
  configuration?: 'ready';
  oracle?: {status:'pending'|'ready';reason:string|null;observationTimestamp:string;windows:Array<{seconds:string;available:boolean;elapsed:string;priceQ64:string}>};
};

export type RegistrySpotMarketMetadata = Pick<RegistryMarketMetadata,
  'marketKey' | 'marketAddress' | 'tokenRoot' | 'assetSymbol' | 'quoteSymbol' |
  'assetDecimals' | 'quoteDecimals' | 'configuration' | 'oracle'> & {
    tokenRootCodeHash?: string;
    tokenWalletCodeHash?: string;
    quoteRoot?: string;
    quoteRootCodeHash?: string;
    quoteWalletCodeHash?: string;
    walletGasX?: number;
    walletGramX?: string;
    walletBudgetX?: RuntimeReleaseManifest['spotMarkets'][number]['walletBudgetX'];
    poolCodeHash: string;
  };
export type RegistryApprovedComparison = {
  templateId: number;
  baseSymbol: string;
  comparisonSymbol: string;
  basePool: string;
  comparisonPool: string;
};

export type CanonicalReleaseManifest = RuntimeReleaseManifest;

export type RegistryMetadata = {
  releaseId: string | null;
  registryHash: string;
  manifestHash?: string | null;
  markets?: RegistryMarketMetadata[];
  spotMarkets?: RegistrySpotMarketMetadata[];
  approvedComparisons?: RegistryApprovedComparison[];
  runtime?: RuntimeReleaseManifest;
};

export type RegistryBundle = {
  contracts: Record<string, string>;
  metadata: RegistryMetadata;
};

const sortedRecord = (input: Record<string, string>) =>
  Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const MAX_RELEASE_MANIFEST_BYTES = 4 * 1024 * 1024;
const RELEASE_MANIFEST_FORBIDDEN_MODE_BITS = 0o7133;

type StableFileIdentity = {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type StableParentIdentity = Pick<Stats, 'dev' | 'ino' | 'mode' | 'uid' | 'gid'>;

export type ReleaseManifestReadTestHooks = {
  /** Deterministic adversarial-test seam; production callers must not provide hooks. */
  afterOpen?: () => void;
  /** Deterministic adversarial-test seam; production callers must not provide hooks. */
  afterRead?: () => void;
};

const fileIdentity = (stat: Stats): StableFileIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  nlink: stat.nlink,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

const sameFileIdentity = (left: StableFileIdentity, right: StableFileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const sameParentIdentity = (left: StableParentIdentity, right: StableParentIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  left.gid === right.gid;

const assertSafeManifestFile = (stat: Stats, label: string): StableFileIdentity => {
  const permissions = stat.mode & 0o7777;
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size <= 0 ||
    stat.size > MAX_RELEASE_MANIFEST_BYTES ||
    (permissions & 0o400) === 0 ||
    (permissions & RELEASE_MANIFEST_FORBIDDEN_MODE_BITS) !== 0
  ) {
    throw new Error(
      `${label} must be a single-link regular file, owner-readable, non-executable, not group/other-writable, and at most ${MAX_RELEASE_MANIFEST_BYTES} bytes.`
    );
  }
  return fileIdentity(stat);
};

const assertSafeManifestParent = (path: string, label: string): StableParentIdentity => {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error(
      `${label} must be a canonical non-symlink directory that is not group/other-writable.`
    );
  }
  // Sibling snapshot writes change directory content metadata, not the
  // authenticated path, permissions or ownership of this parent.
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid };
};

const readStableReleaseManifest = (
  path: string,
  hooks: ReleaseManifestReadTestHooks = {}
): string => {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path
  ) {
    throw new Error('Release manifest path must be a canonical absolute path.');
  }

  const parent = dirname(path);
  const parentBefore = assertSafeManifestParent(parent, 'Release manifest parent');
  if (realpathSync(path) !== path) {
    throw new Error('Release manifest path must not contain symlink aliases.');
  }
  const pathBefore = assertSafeManifestFile(lstatSync(path), 'Release manifest');
  let descriptor: number | undefined;
  let raw: Buffer;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = assertSafeManifestFile(fstatSync(descriptor), 'Opened release manifest');
    if (!sameFileIdentity(pathBefore, opened)) {
      throw new Error('Release manifest changed before its stable descriptor read.');
    }
    hooks.afterOpen?.();
    raw = readFileSync(descriptor);
    hooks.afterRead?.();
    const afterRead = assertSafeManifestFile(fstatSync(descriptor), 'Read release manifest');
    if (!sameFileIdentity(opened, afterRead) || raw.length !== afterRead.size) {
      throw new Error('Release manifest changed during its stable descriptor read.');
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const pathAfter = assertSafeManifestFile(lstatSync(path), 'Release manifest after read');
  const parentAfter = assertSafeManifestParent(parent, 'Release manifest parent after read');
  if (
    !sameFileIdentity(pathBefore, pathAfter) ||
    !sameParentIdentity(parentBefore, parentAfter) ||
    realpathSync(path) !== path
  ) {
    throw new Error('Release manifest path or parent changed during its stable read.');
  }
  return raw.toString('utf8');
};

export const hashRegistry = (contracts: Record<string, string>) =>
  sha256(`${JSON.stringify(sortedRecord(contracts))}\n`);

const instrumentMetadata = (manifest: RuntimeReleaseManifest) => {
  const token = (symbol: string) => {
    const value = manifest.tokens.find(t => t.symbol === symbol);
    if (!value) throw Error('Release manifest token binding is unavailable');
    return value;
  };
  const spotMarkets: RegistrySpotMarketMetadata[] = manifest.spotMarkets.map(spot => {
    const base = token(spot.symbol);
    const quote = token('T3');
    return { marketKey: `spot:${spot.symbol}-T3`, marketAddress: spot.pool, tokenRoot: base.root,
      tokenRootCodeHash: base.masterCodeHash, tokenWalletCodeHash: base.walletCodeHash,
      quoteRoot: quote.root, quoteRootCodeHash: quote.masterCodeHash, quoteWalletCodeHash: quote.walletCodeHash,
      walletGasX: spot.walletGasX, walletGramX: spot.walletGramX, walletBudgetX: structuredClone(spot.walletBudgetX),
      poolCodeHash: manifest.templates.DlmmPool,
      assetSymbol: spot.symbol, quoteSymbol: 'T3', assetDecimals: base.decimals, quoteDecimals: token('T3').decimals };
  }).sort((a, b) => a.marketKey.localeCompare(b.marketKey));
  const markets: RegistryMarketMetadata[] = manifest.perpsMarkets.map(market => {
    const spot = spotMarkets.find(s => s.assetSymbol === market.symbol && s.marketAddress === market.pool);
    if (!spot) throw Error('Release manifest perps pool binding is unavailable');
    return { ...spot, perpsMarketId: market.marketId, perpsPool: market.pool,
      perpsPoolCodeHash: manifest.templates.DlmmPool, perpsCandleMarketKey: `perps-oracle:${market.marketId}` };
  }).sort((a, b) => a.perpsMarketId - b.perpsMarketId);
  const comparisons = new Map<number, RegistryApprovedComparison>();
  for (const option of manifest.options.filter(o => o.kind === 'outperformance')) {
    const base = spotMarkets.find(s => s.assetSymbol === option.symbol)!;
    const comparison = spotMarkets.find(s => s.assetSymbol === option.comparisonSymbol)!;
    comparisons.set(option.templateId, { templateId: option.templateId, baseSymbol: base.assetSymbol,
      comparisonSymbol: comparison.assetSymbol, basePool: base.marketAddress, comparisonPool: comparison.marketAddress });
  }
  return { markets, spotMarkets, approvedComparisons: [...comparisons.values()].sort((a, b) => a.templateId - b.templateId) };
};

export type ParsedReleaseManifest = {
  contracts: Record<string, string>;
  releaseId: string;
  registryHash: string;
  manifestHash: string;
  markets: RegistryMarketMetadata[];
  spotMarkets: RegistrySpotMarketMetadata[];
  approvedComparisons: RegistryApprovedComparison[];
  runtime: RuntimeReleaseManifest;
};

export const buildRuntimeManifestBundle = (runtime: RuntimeReleaseManifest): RegistryBundle => {
  const contracts = sortedRecord(Object.fromEntries(Object.entries(runtime.contracts).map(([role, contract]) => [role, contract!.address])));
  return { contracts, metadata: { releaseId: runtime.releaseId, manifestHash: runtime.manifestHash,
    registryHash: hashRegistry(contracts), ...instrumentMetadata(runtime), runtime } };
};

export const parseCanonicalReleaseManifest = (raw: string | unknown, expectedNetwork: Network): ParsedReleaseManifest => {
  const runtime = typeof raw === 'string' ? parseRuntimeReleaseManifestText(raw, expectedNetwork)
    : parseRuntimeReleaseManifest(raw, expectedNetwork);
  const bundle = buildRuntimeManifestBundle(runtime);
  return { contracts: bundle.contracts, releaseId: runtime.releaseId, registryHash: bundle.metadata.registryHash,
    manifestHash: runtime.manifestHash, ...instrumentMetadata(runtime), runtime };
};

/** Tooling wrapper. Startup's file-or-URL loader passes fetched text to the same parser. */
export const readCanonicalReleaseManifest = (
  path: string,
  expectedNetwork: Network,
  testHooks: ReleaseManifestReadTestHooks = {}
): ParsedReleaseManifest => {
  try { return parseCanonicalReleaseManifest(readStableReleaseManifest(path, testHooks), expectedNetwork); }
  catch (error) { throw Error(`Failed to read release manifest at ${path}: ${(error as Error).message}`); }
};
