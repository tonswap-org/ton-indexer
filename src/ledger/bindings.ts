import { validJettonWalletProfile } from '../config/runtimeManifest';
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
  network: Network; hub: string; root: string; governance: string;
  hubCodeHash: string; walletCodeHash: string; proofCodeHash: string; configHash: string;
  reserveRoutes: Array<{ slot: number; root: string; vault: string; masterCodeHash: string; walletCodeHash: string; decimals: number; walletStorage: 'stablecoin' | 'jetton-v21';
    scale: number; lockExit: number; balanceExit: number; profile: import('./currentT3State').CurrentT3Slot }>;
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
  const keys=['network','hub','root','governance','hubCodeHash','walletCodeHash','proofCodeHash','configHash','reserveRoutes'];
  const fail=()=>Error('T3 binding requires the exact current hub/master, immutable config and per-reserve wallet pins.');
  if(!objectWithKeys(value,keys)||value.network!==network||!address(value.hub)||value.root!==value.hub||!address(value.governance)||
    !['hubCodeHash','walletCodeHash','proofCodeHash','configHash'].every(k=>hash(value[k]))||!Array.isArray(value.reserveRoutes)||value.reserveRoutes.length!==3) throw fail();
  const roots=new Set(),vaults=new Set();
  for(const [slot,r] of value.reserveRoutes.entries()) {
    if(!objectWithKeys(r,['slot','root','vault','masterCodeHash','walletCodeHash','decimals','walletStorage','scale','lockExit','balanceExit','profile'])||r.slot!==slot||!address(r.root)||!address(r.vault)||roots.has(r.root)||vaults.has(r.vault)||
      !['stablecoin','jetton-v21'].includes(String(r.walletStorage))||!hash(r.masterCodeHash)||!hash(r.walletCodeHash)||!Number.isInteger(r.decimals)||Number(r.decimals)<0||Number(r.decimals)>9||r.scale!==10**(9-Number(r.decimals))||
      !['lockExit','balanceExit'].every(k=>Number.isInteger(r[k])&&Number(r[k])>=0&&Number(r[k])<=65535)) throw fail();
    const p=r.profile as import('./currentT3State').CurrentT3Slot;
    if(!p||p.master!==r.root||(p.wallet!==r.vault&&!(slot===2&&p.wallet===null))||p.optional!==(slot===2)||!validJettonWalletProfile(p.walletGas,p.walletGram,p.budget))throw fail();
    roots.add(r.root);vaults.add(r.vault);
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
