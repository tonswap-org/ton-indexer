import { Address } from '@ton/core';
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

type ReleaseManifestContract = string | { address?: unknown };

export type RegistryMarketMetadata = {
  saleModel?: 'fixed' | 'bonding' | 'dutch';
  marketKey: string;
  marketAddress: string;
  tokenRoot: string;
  sale?: string;
  lpVault?: string;
  optionAddress: string;
  perpsMarketId: number;
  optionSeriesId: string;
  coverPolicyId?: string;
  assetSymbol: string;
  quoteSymbol: string;
  assetDecimals: number;
  quoteDecimals: number;
  configuration?: 'ready';
  oracle?: {status:'pending'|'ready';reason:string|null;observationTimestamp:string;windows:Array<{seconds:string;available:boolean;elapsed:string;priceQ64:string}>};
};

export type CanonicalReleaseManifest = {
  schema?: unknown;
  schemaVersion?: unknown;
  network?: unknown;
  releaseId?: unknown;
  registryHash?: unknown;
  manifestHash?: unknown;
  contracts?: Record<string, ReleaseManifestContract>;
  markets?: unknown;
  [key: string]: unknown;
};

export type RegistryMetadata = {
  releaseId: string | null;
  registryHash: string;
  releaseManifestHash: string | null;
  markets?: RegistryMarketMetadata[];
};

export type RegistryBundle = {
  contracts: Record<string, string>;
  metadata: RegistryMetadata;
};

const normalizeNetwork = (value: unknown): Network | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^ton:/, '');
  if (normalized === 'mainnet' || normalized === 'testnet' || normalized === 'localnet') {
    return normalized;
  }
  return null;
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

const parseContracts = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release manifest contracts must be an object');
  }
  const contracts: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, ReleaseManifestContract>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Release manifest contract key is invalid: ${key}`);
    }
    if (typeof candidate !== 'string') throw new Error(`Release manifest contract ${key} must be a raw address string`);
    const address = candidate;
    try {
      if (Address.parse(address).toRawString() !== address || !/^0:[0-9a-f]{64}$/.test(address) || address === `0:${'0'.repeat(64)}`) throw new Error('noncanonical');
    } catch {
      throw new Error(`Release manifest contract ${key} has an invalid TON address`);
    }
    contracts[key] = address;
  }
  if (Object.keys(contracts).length === 0) {
    throw new Error('Release manifest contracts must not be empty');
  }
  return sortedRecord(contracts);
};

const parseMarkets = (value: unknown, contracts: Record<string,string>): RegistryMarketMetadata[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Release manifest markets must contain configured instruments');
  const sets = Object.fromEntries(['key','symbol','pool','optionAddress','perpsMarketId','optionSeriesId'].map(key => [key,new Set<unknown>()]));
  return value.map((market: any, index) => {
    const require = (ok: unknown, field: string) => { if (!ok) throw new Error(`Release manifest market ${index} ${field}`); };
    const uint = (v:unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
    require(market && typeof market === 'object', 'must be an object');
    require(typeof market.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(market.key), 'key');
    require(typeof market.symbol === 'string' && /^[A-Z0-9_.$-]{1,32}$/.test(market.symbol) && market.symbol !== 'T3', 'symbol');
    for (const field of ['tokenRoot','pool','optionAddress']) {
      const role = market.contractRoles?.[field];
      require(typeof role === 'string' && typeof market[field] === 'string' && /^0:[0-9a-f]{64}$/.test(market[field]) && contracts[role] === market[field], `${field} contract binding`);
    }
    require(Number.isSafeInteger(market.perpsMarketId) && market.perpsMarketId > 0, 'perpsMarketId');
    require(uint(market.optionSeriesId) && BigInt(market.optionSeriesId) > 0n, 'optionSeriesId');
    require(Number.isSafeInteger(market.optionTemplateId) && market.optionTemplateId > 0 && uint(market.optionExpiry) && BigInt(market.optionExpiry) > 0n, 'option configuration');
    require(market.coverSource === market.pool, 'cover source');
    require(market.configuration === 'ready' && market.lifecycle === 'not-run', 'configuration/lifecycle');
    for (const field of ['decimals','quoteDecimals']) require(Number.isInteger(market[field]) && market[field] >= 0 && market[field] <= 18, field);
    for (const [field, seen] of Object.entries(sets)) { require(!seen.has(market[field]), `duplicate ${field}`); seen.add(market[field]); }
    const oracle = market.oracle;
    require(oracle && ['pending','ready'].includes(oracle.status) && uint(oracle.observationTimestamp), 'oracle');
    require(Array.isArray(oracle.windows) && JSON.stringify(oracle.windows.map((w:any)=>w.seconds)) === '["300","1800","7200"]', 'oracle windows');
    for (const window of oracle.windows) require(typeof window.available === 'boolean' && uint(window.elapsed) && uint(window.priceQ64), 'oracle window');
    if (oracle.status === 'ready') require(oracle.reason === null && oracle.windows.every((w:any)=>w.available && BigInt(w.elapsed)>=BigInt(w.seconds) && BigInt(w.priceQ64)>0n), 'oracle ready');
    else require(oracle.reason === 'history-incomplete-or-stale', 'oracle pending');
    return {marketKey:`spot:${market.symbol}-T3`,marketAddress:market.pool,tokenRoot:market.tokenRoot,optionAddress:market.optionAddress,
      perpsMarketId:market.perpsMarketId,optionSeriesId:market.optionSeriesId,assetSymbol:market.symbol,quoteSymbol:'T3',assetDecimals:market.decimals,
      quoteDecimals:market.quoteDecimals,configuration:market.configuration,oracle};
  }).sort((a,b)=>a.marketKey.localeCompare(b.marketKey));
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
} => {
  let raw: string;
  let parsed: CanonicalReleaseManifest;
  try {
    raw = readStableReleaseManifest(path, testHooks);
    assertNoDuplicateJsonObjectKeys(raw);
    parsed = JSON.parse(raw) as CanonicalReleaseManifest;
  } catch (error) {
    throw new Error(`Failed to read release manifest at ${path}: ${(error as Error).message}`);
  }

  if (parsed.schema !== 'tonswap-first-release-manifest-v1') {
    throw new Error('Release manifest schema must be tonswap-first-release-manifest-v1');
  }
  for (const field of ['contracts', 'codeHashes', 'artifactCodeHashes', 'webAddresses']) {
    const values = parsed[field];
    if (values && typeof values === 'object' &&
        ['FarmFactory', 'Farm', 'FarmStaker', 'FarmReceiptWallet', 'farmFactory'].some(role => Object.hasOwn(values, role))) {
      throw new Error('Release manifest contains retired CLMM farming roles; farming must be native to DLMM pools.');
    }
  }
  const network = normalizeNetwork(parsed.network);
  if (parsed.schemaVersion !== 1) {
    throw new Error('Release manifest schemaVersion must be 1');
  }
  if (!network) {
    throw new Error('Release manifest network must be mainnet, testnet, or localnet');
  }
  if (network !== expectedNetwork) {
    throw new Error(`Release manifest network mismatch: expected ${expectedNetwork}, got ${network}`);
  }
  if (typeof parsed.releaseId !== 'string' || !parsed.releaseId.trim()) {
    throw new Error('Release manifest releaseId must be a non-empty string');
  }
  const releaseManifestHash = hashReleaseManifest(parsed);
  if (
    typeof parsed.manifestHash !== 'string' ||
    parsed.manifestHash.toLowerCase() !== releaseManifestHash
  ) {
    throw new Error('Release manifest manifestHash does not match its canonical contents');
  }

  const contracts = parseContracts(parsed.contracts);
  if (parsed.network !== `ton:${network}` || !['testnet','localnet'].includes(network) ||
      typeof parsed.attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed.attemptId) ||
      typeof parsed.candidateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.candidateDigest) || parsed.setup !== 'ready' || parsed.lifecycle !== 'not-run') {
    throw new Error('Release manifest candidate/attempt/configuration identity is invalid');
  }
  const codeHashes = parsed.codeHashes as Record<string,string>;
  if (!codeHashes || JSON.stringify(Object.keys(codeHashes).sort()) !== JSON.stringify(Object.keys(contracts).sort()) ||
      Object.values(codeHashes).some(hash=>typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) throw new Error('Release manifest code/address inventory is invalid');
  for (const field of ['sourceHashes','artifactHashes']) {
    const map = parsed[field] as Record<string,string>;
    if (!map || JSON.stringify(Object.keys(map).sort()) !== '["contracts","indexer","web"]' || Object.values(map).some(hash=>typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) throw new Error(`Release manifest ${field} is invalid`);
  }
  const markets = parseMarkets(parsed.markets, contracts);
  const registryHash = hashRegistry(contracts);
  if (typeof parsed.registryHash !== 'string' || parsed.registryHash.toLowerCase() !== registryHash) {
    throw new Error('Release manifest registryHash does not match its contracts');
  }

  return {
    contracts,
    releaseId: parsed.releaseId.trim(),
    registryHash,
    releaseManifestHash,
    markets
  };
};

export const buildRegistryBundle = (
  registry: Record<string, string>,
  network: Network,
  releaseManifestPath?: string
): RegistryBundle => {
  const normalizedRegistry = sortedRecord(registry);
  if (!releaseManifestPath) {
    return {
      contracts: normalizedRegistry,
      metadata: {
        releaseId: null,
        registryHash: hashRegistry(normalizedRegistry),
        releaseManifestHash: null,
        markets: []
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
      markets: manifest.markets
    }
  };
};
