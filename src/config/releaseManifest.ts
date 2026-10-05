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
import { assertCurrentContractRoles } from './registry';
import { parseRuntimeReleaseManifest, type RuntimeReleaseManifest } from './runtimeManifest';


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
  releaseManifestHash: string | null;
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

const assertSafeManifestParent = (path: string, label: string): StableFileIdentity => {
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
  return fileIdentity(stat);
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
    !sameFileIdentity(parentBefore, parentAfter) ||
    realpathSync(path) !== path
  ) {
    throw new Error('Release manifest path or parent changed during its stable read.');
  }
  return raw.toString('utf8');
};

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

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const hashRegistry = (contracts: Record<string, string>) =>
  sha256(`${JSON.stringify(sortedRecord(contracts))}\n`);

export const hashReleaseManifest = (manifest: Record<string, unknown>) => {
  const unsigned = { ...manifest };
  delete unsigned.manifestHash;
  return sha256(stableJson(unsigned));
};

const instrumentMetadata = (manifest: RuntimeReleaseManifest) => {
  const token = (symbol: string) => manifest.tokens.find(t => t.symbol === symbol)!;
  const spotMarkets: RegistrySpotMarketMetadata[] = manifest.spotMarkets.map(spot => {
    const base = token(spot.symbol);
    const rootCodeHash = Object.values(manifest.contracts).find(c => c?.address === base.root)?.codeHash;
    return { marketKey: `spot:${spot.symbol}-T3`, marketAddress: spot.pool, tokenRoot: base.root,
      ...(rootCodeHash ? { tokenRootCodeHash: rootCodeHash } : {}), poolCodeHash: manifest.templates.DlmmPool,
      assetSymbol: spot.symbol, quoteSymbol: 'T3', assetDecimals: base.decimals, quoteDecimals: 9 };
  }).sort((a, b) => a.marketKey.localeCompare(b.marketKey));
  const markets: RegistryMarketMetadata[] = manifest.perpsMarkets.map(market => {
    const spot = spotMarkets.find(s => s.assetSymbol === market.symbol)!;
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

const assertRegistryParity = (
  registry: Record<string, string>,
  manifestContracts: Record<string, string>
) => {
  const registryKeys = Object.keys(registry).sort();
  const manifestKeys = Object.keys(manifestContracts).sort();
  if (
    registryKeys.length !== manifestKeys.length ||
    registryKeys.some((key, index) => key !== manifestKeys[index])
  ) {
    throw new Error(
      `Registry/release manifest key mismatch: registry=[${registryKeys.join(',')}] manifest=[${manifestKeys.join(',')}]`
    );
  }
  for (const key of manifestKeys) {
    if (registry[key] !== manifestContracts[key]) {
      throw new Error(`Registry/release manifest address mismatch for ${key}`);
    }
  }
};

export const readCanonicalReleaseManifest = (
  path: string,
  expectedNetwork: Network,
  testHooks: ReleaseManifestReadTestHooks = {}
): {
  contracts: Record<string, string>;
  releaseId: string;
  registryHash: string;
  releaseManifestHash: string;
  markets: RegistryMarketMetadata[];
  spotMarkets: RegistrySpotMarketMetadata[];
  approvedComparisons: RegistryApprovedComparison[];
  runtime: RuntimeReleaseManifest;
} => {
  let parsed: unknown;
  try {
    const raw = readStableReleaseManifest(path, testHooks);
    assertNoDuplicateJsonObjectKeys(raw);
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to read release manifest at ${path}: ${(error as Error).message}`);
  }
  const runtime = parseRuntimeReleaseManifest(parsed, expectedNetwork);
  const releaseManifestHash = hashReleaseManifest(runtime);
  if (runtime.manifestHash !== releaseManifestHash)
    throw Error('Release manifest manifestHash does not match its canonical contents');
  const contracts = sortedRecord(Object.fromEntries(Object.entries(runtime.contracts).map(([role, contract]) => [role, contract!.address])));
  return { contracts, releaseId: runtime.releaseId, registryHash: hashRegistry(contracts), releaseManifestHash,
    ...instrumentMetadata(runtime), runtime };
};

export const buildRegistryBundle = (
  registry: Record<string, string>,
  network: Network,
  releaseManifestPath?: string
): RegistryBundle => {
  assertCurrentContractRoles(registry);
  const normalizedRegistry = sortedRecord(registry);
  if (!releaseManifestPath) {
    return {
      contracts: normalizedRegistry,
      metadata: {
        releaseId: null,
        registryHash: hashRegistry(normalizedRegistry),
        releaseManifestHash: null,
        markets: [],
        spotMarkets: [],
        approvedComparisons: []
      }
    };
  }

  const manifest = readCanonicalReleaseManifest(releaseManifestPath, network);
  assertRegistryParity(normalizedRegistry, manifest.contracts);
  return {
    contracts: manifest.contracts,
    metadata: {
      releaseId: manifest.releaseId,
      registryHash: manifest.registryHash,
      releaseManifestHash: manifest.releaseManifestHash,
      markets: manifest.markets,
      spotMarkets: manifest.spotMarkets,
      approvedComparisons: manifest.approvedComparisons,
      runtime: manifest.runtime
    }
  };
};
