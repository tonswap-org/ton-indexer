import type { Network } from '../models';
import { canonicalLedgerAddress } from './normalize';
import type { DlmmMarketBinding } from './marketTypes';

export type LedgerOptionsCodeHashes = {
  factoryCodeHash: string;
  vaultCodeHash: string;
  shoutCodeHash: string;
  outperformanceCodeHash: string;
  walletCodeHash: string;
};

export type LedgerLaunchpadCodeHashes = {
  fixedCodeHash: string;
  bondingCodeHash: string;
  auctionCodeHash: string;
  walletCodeHash: string;
};

export type LedgerT3RedemptionBinding = {
  network: Network;
  hub: string;
  root: string;
  hubCodeHash: string;
  rootCodeHash: string;
  walletCodeHash: string;
  receiverCodeHash: string;
  reserveRoutes: Array<{ root: string; vault: string; discovery: string }>;
};

const objectWithKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const address = (value: unknown): value is string => {
  try { return typeof value === 'string' && canonicalLedgerAddress(value) === value; }
  catch { return false; }
};

/** Trusted release inputs only. Historical code must still match these pins;
 * a code hash observed from RPC never enrolls an account into the allowlist. */
export function validatePerpsCodeHash(value: unknown): string {
  if (!hash(value)) throw Error('Perps code hash must be exactly 64 lowercase hexadecimal characters.');
  return value;
}

export function validateOptionsCodeHashes(value: unknown): LedgerOptionsCodeHashes {
  const keys = ['factoryCodeHash', 'vaultCodeHash', 'shoutCodeHash', 'outperformanceCodeHash', 'walletCodeHash'];
  if (!objectWithKeys(value, keys) || !keys.every(key => hash(value[key])))
    throw Error('Options binding requires exactly five qualified lowercase 64-character Cell hashes.');
  return value as LedgerOptionsCodeHashes;
}

export function validateLaunchpadCodeHashes(value: unknown): LedgerLaunchpadCodeHashes {
  const keys = ['fixedCodeHash', 'bondingCodeHash', 'auctionCodeHash', 'walletCodeHash'];
  if (!objectWithKeys(value, keys) || !keys.every(key => hash(value[key])))
    throw Error('Launchpad binding requires exactly fixedCodeHash, bondingCodeHash, auctionCodeHash and walletCodeHash as qualified lowercase 64-character Cell hashes.');
  return value as LedgerLaunchpadCodeHashes;
}

export function validateT3RedemptionBinding(value: unknown, network: Network): LedgerT3RedemptionBinding {
  const keys = ['network', 'hub', 'root', 'hubCodeHash', 'rootCodeHash', 'walletCodeHash', 'receiverCodeHash', 'reserveRoutes'];
  const fail = () => Error('T3 redemption binding must be the exact qualified current-network binding, with canonical addresses, four Cell hashes and three distinct reserve routes.');
  if (!objectWithKeys(value, keys) || value.network !== network || !address(value.hub) || !address(value.root) ||
    value.hub === value.root || !['hubCodeHash', 'rootCodeHash', 'walletCodeHash', 'receiverCodeHash'].every(key => hash(value[key])) ||
    !Array.isArray(value.reserveRoutes) || value.reserveRoutes.length !== 3) throw fail();
  const roots = new Set<string>(), vaults = new Set<string>();
  for (const route of value.reserveRoutes) {
    if (!objectWithKeys(route, ['root', 'vault', 'discovery']) || !address(route.root) || !address(route.vault) ||
      !address(route.discovery) || route.discovery !== route.root || roots.has(route.root) || vaults.has(route.vault)) throw fail();
    roots.add(route.root); vaults.add(route.vault);
  }
  return value as LedgerT3RedemptionBinding;
}

export function validateMarketBindings(values: unknown, network: Network): DlmmMarketBinding[] {
  const keys = ['network', 'pool', 'poolCodeHash', 'walletCodeHash', 'tokenT', 'tokenX', 'tokenTCodeHash', 'tokenXCodeHash', 'router', 'routerCodeHash'];
  const fail = () => Error('Market bindings must be an array of unique canonical pools with exactly network, pool, poolCodeHash, walletCodeHash, tokenT, tokenX, tokenTCodeHash, tokenXCodeHash, router and routerCodeHash; network must match this indexer.');
  if (!Array.isArray(values) || values.length > 256) throw fail();
  const seen = new Set<string>();
  for (const value of values) {
    if (!objectWithKeys(value, keys) || value.network !== network || !address(value.pool) || !address(value.tokenT) ||
      !address(value.tokenX) || value.tokenT === value.tokenX || seen.has(value.pool) ||
      !['poolCodeHash', 'walletCodeHash', 'tokenTCodeHash', 'tokenXCodeHash'].every(key => hash(value[key])) ||
      (value.router === null) !== (value.routerCodeHash === null) ||
      (value.router !== null && (!address(value.router) || !hash(value.routerCodeHash)))) throw fail();
    seen.add(value.pool);
  }
  return values as DlmmMarketBinding[];
}
