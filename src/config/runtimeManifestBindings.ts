import { currentOptionsBindingFromManifest, type NativeOptionProofBinding } from '../ledger/currentOptionsProof';
import { currentPerpsBindingFromManifest, type NativePerpsProofBinding } from '../ledger/currentPerpsProof';
import { currentDlmmBindingFromManifest, type CurrentDlmmConfigBinding } from '../ledger/currentDlmmPhysical';
import { currentDlmmMarketBindingsFromManifest, type CurrentDlmmMarketBinding } from '../ledger/currentDlmmMarketTypes';
import { currentLaunchpadBindingFromManifest, type CurrentLaunchpadBinding } from '../ledger/currentLaunchpadProof';
import type { Network } from './index';
import type { RuntimeReleaseManifest, JettonWalletBudget } from './runtimeManifest';
import type { DlmmMarketBinding } from '../ledger/marketTypes';
import type { LedgerOptionsCodeHashes, LedgerLaunchpadCodeHashes } from '../ledger/bindings';

export type CurrentSpotMarketBinding = {
  network: Network; pool: string; poolCodeHash: string; symbol: string; binSpacing: number; feePips: number;
  tokenT: RuntimeReleaseManifest['tokens'][number]; tokenX: RuntimeReleaseManifest['tokens'][number];
  xDecimals: number; walletGasX: number; walletGramX: string; walletBudgetX: JettonWalletBudget;
};
export type RuntimeManifestBindings = {
  network: Network;
  jettonRoots: Array<{ master: string; symbol: string; decimals: number; masterCodeHash: string; walletCodeHash: string }>;
  currentSpotMarkets: CurrentSpotMarketBinding[];
  currentLedgerDecodersQualified: boolean;
  currentOptionsBinding: NativeOptionProofBinding;
  currentPerpsBinding: NativePerpsProofBinding;
  currentDlmmBinding: CurrentDlmmConfigBinding;
  currentMarketBindings: CurrentDlmmMarketBinding[];
  currentLaunchpadBinding: CurrentLaunchpadBinding;
  walletTemplateCodeHash: string | null;
  dlmmRegistry?: string;
  optionFactory?: string;
  optionVault?: string;
  optionCodeHashes?: LedgerOptionsCodeHashes;
  launchpadControllers: string[];
  launchpadCodeHashes?: LedgerLaunchpadCodeHashes;
  t3Hub?: string;
  perpsEngine?: string;
  perpsEngineCodeHash?: string;
  marketBindings: DlmmMarketBinding[];
};

/** Current discovery identities are not authorization for an older business-state decoder. */
export function deriveRuntimeManifestBindings(manifest: RuntimeReleaseManifest): RuntimeManifestBindings {
  const contracts = manifest.contracts, network = manifest.network.slice(4) as Network;
  const tokenT = manifest.tokens.find(token => token.symbol === 'T3');
  if (!tokenT) throw Error('Release manifest T3 token binding is unavailable');
  const currentSpotMarkets = manifest.spotMarkets.map(spot => {
    const tokenX = manifest.tokens.find(token => token.symbol === spot.symbol);
    if (!tokenX) throw Error('Release manifest spot token binding is unavailable');
    return { ...structuredClone(spot), network, poolCodeHash: manifest.templates.DlmmPool,
      tokenT: { ...tokenT }, tokenX: { ...tokenX } };
  });
  return {
    network,
    jettonRoots: manifest.tokens.map(token => ({ master: token.root, symbol: token.symbol, decimals: token.decimals,
      masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash })),
    currentSpotMarkets,
    // Current product gates authenticate original source, economics and physical cash.
    // Canonical storage, exact live identities and native execution qualification remain required.
    currentLedgerDecodersQualified: true,
    currentOptionsBinding: currentOptionsBindingFromManifest(manifest),
    currentPerpsBinding: currentPerpsBindingFromManifest(manifest),
    currentDlmmBinding: currentDlmmBindingFromManifest(manifest),
    currentMarketBindings: currentDlmmMarketBindingsFromManifest(manifest),
    currentLaunchpadBinding: currentLaunchpadBindingFromManifest(manifest),
    walletTemplateCodeHash: null, marketBindings: [], launchpadControllers: [],
    t3Hub: contracts.T3Hub?.address,
    optionFactory: contracts.OptionFactory?.address, optionVault: contracts.OptionVault?.address,
    perpsEngine: contracts.PerpsEngine?.address, perpsEngineCodeHash: contracts.PerpsEngine?.codeHash,
  };
}
