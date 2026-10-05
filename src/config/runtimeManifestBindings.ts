import type { Network } from './index';
import type { RuntimeReleaseManifest } from './runtimeManifest';
import type { DlmmMarketBinding } from '../ledger/marketTypes';
import type { LedgerOptionsCodeHashes, LedgerLaunchpadCodeHashes, LedgerT3RedemptionBinding } from '../ledger/bindings';

export type RuntimeManifestBindings = {
  network: Network;
  jettonRoots: Array<{ master: string; symbol: string }>;
  dlmmRegistry?: string;
  optionFactory?: string;
  optionVault?: string;
  optionCodeHashes?: LedgerOptionsCodeHashes;
  launchpadControllers: string[];
  launchpadCodeHashes?: LedgerLaunchpadCodeHashes;
  t3Hub?: string;
  t3Root?: string;
  t3CodeHashes?: Pick<LedgerT3RedemptionBinding, 'hubCodeHash' | 'rootCodeHash' | 'walletCodeHash' | 'receiverCodeHash'>;
  perpsEngine?: string;
  perpsEngineCodeHash?: string;
  marketBindings: DlmmMarketBinding[];
};

/** Every trust pin comes from the parsed manifest, never current RPC code or
 * environment overrides. Actual archived state and custody remain independent. */
export function deriveRuntimeManifestBindings(manifest: RuntimeReleaseManifest): RuntimeManifestBindings {
  const contracts = manifest.contracts, templates = manifest.templates;
  const network = manifest.network.slice(4) as Network;
  const rootHash = (root: string) => Object.entries(contracts).find(([role, c]) =>
    ['T3Root', 'TSRoot', 'USDT', 'USDC', 'KUSD'].includes(role) && c?.address === root)?.[1]?.codeHash;
  const tokenT = manifest.tokens.find(t => t.symbol === 'T3')!.root;
  const marketBindings: DlmmMarketBinding[] = [];
  for (const spot of manifest.spotMarkets) {
    const token = manifest.tokens.find(t => t.symbol === spot.symbol);
    if (!token) throw Error('Release manifest spot token binding is unavailable');
    const tokenX = token.root;
    const tokenTCodeHash = rootHash(tokenT), tokenXCodeHash = rootHash(tokenX);
    // External roots are not deployed singletons. Their omitted trusted code
    // hash remains a qualification gap; today's RPC code is never enrolled.
    if (!tokenTCodeHash || !tokenXCodeHash) continue;
    marketBindings.push({ network, pool: spot.pool, poolCodeHash: templates.DlmmPool,
      walletCodeHash: templates.JettonWallet, tokenT, tokenX, tokenTCodeHash, tokenXCodeHash,
      router: contracts.DexRouter?.address ?? null, routerCodeHash: contracts.DexRouter?.codeHash ?? null });
  }
  return {
    network,
    jettonRoots: manifest.tokens.map(token => ({ master: token.root, symbol: token.symbol })),
    dlmmRegistry: contracts.DlmmRegistry?.address,
    optionFactory: contracts.OptionFactory?.address,
    optionVault: contracts.OptionVault?.address,
    optionCodeHashes: contracts.OptionFactory && contracts.OptionVault ? {
      factoryCodeHash: contracts.OptionFactory.codeHash, vaultCodeHash: contracts.OptionVault.codeHash,
      shoutCodeHash: templates.ShoutOption, outperformanceCodeHash: templates.OutperformanceOption,
      walletCodeHash: templates.JettonWallet,
    } : undefined,
    launchpadControllers: contracts.SaleFactory ? [contracts.SaleFactory.address] : [],
    launchpadCodeHashes: contracts.SaleFactory ? { fixedCodeHash: templates.SaleFixed, bondingCodeHash: templates.SaleBonding,
      auctionCodeHash: templates.SaleAuction, walletCodeHash: templates.JettonWallet } : undefined,
    t3Hub: contracts.T3?.address,
    t3Root: contracts.T3Root?.address,
    t3CodeHashes: contracts.T3 && contracts.T3Root ? { hubCodeHash: contracts.T3.codeHash,
      rootCodeHash: contracts.T3Root.codeHash, walletCodeHash: templates.JettonWallet, receiverCodeHash: templates.T3Receiver } : undefined,
    perpsEngine: contracts.PerpsEngine?.address,
    perpsEngineCodeHash: contracts.PerpsEngine?.codeHash,
    marketBindings,
  };
}
