import { Address } from '@ton/core';
import type { Network } from '../models';
export type LedgerSccpBinding = {
  master: string;
  soraAssetId: string;
  masterCodeHash: string;
  verifier?: string;
  verifierCodeHash?: string;
};
/** Backend release inputs pin identities. A self-described token symbol or
 * get_sccp_config result alone cannot establish an authentic bridge mapping. */
export function parseLedgerSccpBindings(
  raw: string | undefined,
  network: Network,
): LedgerSccpBinding[] {
  if (!raw?.trim()) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 16)
    throw new Error(
      'LEDGER_SCCP_ASSETS_JSON must contain at most 16 pinned asset bindings.',
    );
  const seen = new Set<string>();
  const address = (v: unknown) => {
    if (typeof v !== 'string') throw new Error('SCCP binding address missing');
    if (
      network === 'mainnet' &&
      !v.includes(':') &&
      Address.parseFriendly(v).isTestOnly
    )
      throw new Error('SCCP binding uses a testnet-only address');
    return Address.parse(v).toRawString();
  };
  const hash = (v: unknown) => {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
      throw new Error('SCCP binding requires a lowercase 32-byte code hash');
    return v;
  };
  return values.map((v: any) => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).some(
        (k) =>
          ![
            'network',
            'master',
            'soraAssetId',
            'masterCodeHash',
            'verifier',
            'verifierCodeHash',
          ].includes(k),
      ) ||
      v.network !== network
    )
      throw new Error('SCCP binding network or fields are invalid');
    const master = address(v.master);
    if (seen.has(master)) throw new Error('Duplicate SCCP master binding');
    seen.add(master);
    if (
      typeof v.soraAssetId !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(v.soraAssetId)
    )
      throw new Error(
        'SCCP asset ID must be lowercase 0x-prefixed 32-byte hex',
      );
    if ((v.verifier === undefined) !== (v.verifierCodeHash === undefined))
      throw new Error(
        'SCCP verifier address and code hash must be supplied together',
      );
    return {
      master,
      soraAssetId: v.soraAssetId,
      masterCodeHash: hash(v.masterCodeHash),
      ...(v.verifier === undefined
        ? {}
        : {
            verifier: address(v.verifier),
            verifierCodeHash: hash(v.verifierCodeHash),
          }),
    };
  });
}
