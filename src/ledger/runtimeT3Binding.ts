import { Cell } from '@ton/core';
import type { ChainSource } from '../data/dataSource';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { LedgerT3RedemptionBinding } from './bindings';
import { readT3RecoveryRoot } from './t3RecoveryState';
import { perpsWalletAddress } from './perpsWire';

/** Use the manifest's approved code hashes and the root's authenticated wallet
 * Cell. Discovery never enrolls today's observed code as a trusted decoder. */
export async function deriveT3RedemptionBinding(manifest: RuntimeReleaseManifest, source: Pick<ChainSource, 'getAccountState'>): Promise<LedgerT3RedemptionBinding | undefined> {
  const hub = manifest.contracts.T3, root = manifest.contracts.T3Root;
  if (!hub || !root) return undefined;
  const roots = ['USDT', 'USDC', 'KUSD'].map(symbol => manifest.tokens.find(token => token.symbol === symbol)?.root);
  if (roots.some(address => !address)) throw Error('T3 recovery requires all three declared reserve roots');
  const state = await source.getAccountState(root.address);
  if (state.accountState !== 'active' || !state.codeBoc || !state.dataBoc ||
      Cell.fromBase64(state.codeBoc).hash().toString('hex') !== root.codeHash)
    throw Error('T3 root state does not match the runtime manifest');
  const storage = readT3RecoveryRoot(state.dataBoc, root.address, hub.address, hub.address, '0', '0');
  if (storage.summary.emitter !== hub.address || storage.summary.walletCodeHash !== manifest.templates.JettonWallet)
    throw Error('T3 root emitter or wallet template does not match the runtime manifest');
  return { network: manifest.network.slice(4) as LedgerT3RedemptionBinding['network'], hub: hub.address, root: root.address,
    hubCodeHash: hub.codeHash, rootCodeHash: root.codeHash, walletCodeHash: manifest.templates.JettonWallet,
    receiverCodeHash: manifest.templates.T3Receiver,
    reserveRoutes: roots.map(address => ({ root: address!, discovery: address!,
      vault: perpsWalletAddress(storage.walletCode, address!, hub.address) })) as LedgerT3RedemptionBinding['reserveRoutes'] };
}
