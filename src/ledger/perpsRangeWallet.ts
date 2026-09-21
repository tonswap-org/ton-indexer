import { Cell } from '@ton/core';
import type { Network } from '../models';
import type { AccountStateResponse } from '../data/dataSource';
import type { LedgerAsset } from './types';
import { canonicalLedgerAddress } from './normalize';
import { perpsWalletAddress } from './perpsWire';
import { readT3RecoveryWallet } from './t3RecoveryState';

/** Identity belongs to the range's captured master, not a latest-head getter.
 * Decode the sole current JettonWalletStorage, including both journals and both mandatory receipt dictionaries.
 * Display metadata and balances from independent reads are never proof inputs. */
export function qualifyPerpsRangeWallet(network: Network, wallet: string, owner: string,
  root: string, walletCode: Cell, state: AccountStateResponse): LedgerAsset {
  try {
    wallet = canonicalLedgerAddress(wallet);
    owner = canonicalLedgerAddress(owner);
    root = canonicalLedgerAddress(root);
    if (perpsWalletAddress(walletCode, root, owner) !== wallet || state.accountState !== 'active' ||
        !state.codeBoc || !state.dataBoc ||
        Cell.fromBase64(state.codeBoc).hash().toString('hex') !== walletCode.hash().toString('hex')) throw Error('Wallet binding');
    const decoded = readT3RecoveryWallet(state.dataBoc);
    if (decoded.owner !== owner || decoded.root !== root) throw Error('Wallet owner/root');
    return { kind: 'jetton', id: `${network}:jetton:${root}`, master: root, wallet, owner };
  } catch {
    throw Error('perps_range_wallet_identity_unverified');
  }
}
