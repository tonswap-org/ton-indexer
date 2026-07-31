import { Address } from '@ton/core';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Network } from './index';

type ReleaseManifestContract = string | { address?: unknown };

export type RegistryMarketMetadata = {
  saleModel: 'fixed' | 'bonding' | 'dutch';
  marketKey: string;
  marketAddress: string;
  tokenRoot: string;
  sale: string;
  lpVault: string;
  optionAddress: string;
  perpsMarketId: number;
  optionSeriesId: string;
  coverPolicyId: string;
  assetSymbol: string;
  quoteSymbol: string;
  assetDecimals: number;
  quoteDecimals: number;
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
    const raw =
      typeof candidate === 'string'
        ? candidate
        : candidate && typeof candidate === 'object' && typeof candidate.address === 'string'
          ? candidate.address
          : '';
    const address = raw.trim();
    if (!address) {
      throw new Error(`Release manifest contract ${key} is missing an address`);
    }
    try {
      Address.parse(address);
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

const parseMarkets = (
  value: unknown,
  contracts: Record<string, string>
): RegistryMarketMetadata[] => {
  if (!Array.isArray(value)) {
    throw new Error('Release manifest markets must be an array');
  }
  if (value.length !== 3) {
    throw new Error('Release manifest markets must contain exactly three markets');
  }

  const seenModels = new Set<string>();
  const seenKeys = new Set<string>();
  const seenAddresses = new Set<string>();
  const seenPerpsMarketIds = new Set<number>();
  const seenOptionSeriesIds = new Set<string>();
  const seenCoverPolicyIds = new Set<string>();
  const markets = value.map((candidate, index): RegistryMarketMetadata => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Release manifest market ${index} must be an object`);
    }
    const market = candidate as Record<string, unknown>;
    const saleModel =
      typeof market.saleModel === 'string' ? market.saleModel.trim().toLowerCase() : '';
    if (!['fixed', 'bonding', 'dutch'].includes(saleModel) || seenModels.has(saleModel)) {
      throw new Error(`Release manifest market ${index} has an invalid or duplicate saleModel`);
    }
    seenModels.add(saleModel);

    const assetSymbol = typeof market.symbol === 'string' ? market.symbol.trim().toUpperCase() : '';
    if (!/^[A-Z0-9_.$-]{1,32}$/.test(assetSymbol) || assetSymbol === 'T3') {
      throw new Error(`Release manifest market ${index} has an invalid symbol`);
    }
    const quoteSymbol = 'T3';
    const marketKey = `spot:${assetSymbol}-${quoteSymbol}`;
    if (seenKeys.has(marketKey)) {
      throw new Error(`Release manifest market key is duplicated: ${marketKey}`);
    }
    seenKeys.add(marketKey);

    const contractModel = `${saleModel[0].toUpperCase()}${saleModel.slice(1)}`;
    const addressFields = [
      ['tokenRoot', 'TokenRoot'],
      ['sale', 'Sale'],
      ['lpVault', 'LpVault'],
      ['pool', 'Pool'],
      ['optionAddress', 'Option'],
    ] as const;
    let marketAddress = '';
    const marketAddresses: Record<string, string> = {};
    for (const [field, suffix] of addressFields) {
      const address = typeof market[field] === 'string' ? market[field].trim() : '';
      let rawAddress: string;
      try {
        rawAddress = Address.parse(address).toRawString();
      } catch {
        throw new Error(`Release manifest market ${index} has an invalid ${field} address`);
      }
      const contractKey = `Launchpad${contractModel}${suffix}`;
      const contractAddress = contracts[contractKey];
      if (
        !contractAddress ||
        Address.parse(contractAddress).toRawString() !== rawAddress
      ) {
        throw new Error(
          `Release manifest market ${index} ${field} does not match contract ${contractKey}`
        );
      }
      if (seenAddresses.has(rawAddress)) {
        throw new Error(`Release manifest market address is duplicated: ${rawAddress}`);
      }
      seenAddresses.add(rawAddress);
      marketAddresses[field] = address;
      if (field === 'pool') marketAddress = address;
    }
    const perpsMarketId = Number(market.perpsMarketId);
    const optionSeriesId =
      typeof market.optionSeriesId === 'string' ? market.optionSeriesId.trim() : '';
    const coverPolicyId =
      typeof market.coverPolicyId === 'string' ? market.coverPolicyId.trim() : '';
    if (
      !Number.isSafeInteger(perpsMarketId) ||
      perpsMarketId <= 0 ||
      seenPerpsMarketIds.has(perpsMarketId)
    ) {
      throw new Error(`Release manifest market ${index} has invalid or duplicate perpsMarketId`);
    }
    if (
      !optionSeriesId ||
      optionSeriesId.length > 128 ||
      seenOptionSeriesIds.has(optionSeriesId)
    ) {
      throw new Error(`Release manifest market ${index} has invalid or duplicate optionSeriesId`);
    }
    if (
      !coverPolicyId ||
      coverPolicyId.length > 128 ||
      seenCoverPolicyIds.has(coverPolicyId)
    ) {
      throw new Error(`Release manifest market ${index} has invalid or duplicate coverPolicyId`);
    }
    seenPerpsMarketIds.add(perpsMarketId);
    seenOptionSeriesIds.add(optionSeriesId);
    seenCoverPolicyIds.add(coverPolicyId);

    const parseDecimals = (raw: unknown, label: string, fallback: number): number => {
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 18) {
        throw new Error(`Release manifest market ${index} has invalid ${label}`);
      }
      return parsed;
    };
    return {
      saleModel: saleModel as 'fixed' | 'bonding' | 'dutch',
      marketKey,
      marketAddress,
      tokenRoot: marketAddresses.tokenRoot,
      sale: marketAddresses.sale,
      lpVault: marketAddresses.lpVault,
      optionAddress: marketAddresses.optionAddress,
      perpsMarketId,
      optionSeriesId,
      coverPolicyId,
      assetSymbol,
      quoteSymbol,
      assetDecimals: parseDecimals(market.decimals, 'decimals', 9),
      quoteDecimals: parseDecimals(market.quoteDecimals, 'quoteDecimals', 9),
    };
  });
  for (const model of ['fixed', 'bonding', 'dutch']) {
    if (!seenModels.has(model)) {
      throw new Error(`Release manifest markets are missing ${model}`);
    }
  }
  return markets.sort((left, right) => left.marketKey.localeCompare(right.marketKey));
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
  expectedNetwork: Network
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
    raw = readFileSync(path, 'utf8');
    parsed = JSON.parse(raw) as CanonicalReleaseManifest;
  } catch (error) {
    throw new Error(`Failed to read release manifest at ${path}: ${(error as Error).message}`);
  }

  if (parsed.schema !== 'tonswap-testnet-release-v1') {
    throw new Error('Release manifest schema must be tonswap-testnet-release-v1');
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
