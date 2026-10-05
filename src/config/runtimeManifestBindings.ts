import type { Config } from './index';
import type { RuntimeReleaseManifest } from './runtimeManifest';
import type { DlmmMarketBinding } from '../ledger/marketTypes';

type LedgerConfig = Pick<Config, 'network' | 'ledgerPerpsEngineCodeHash' | 'ledgerOptionsCodeHashes' |
  'ledgerLaunchpadCodeHashes' | 'ledgerMarketBindings' | 'ledgerT3RedemptionBinding'>;
const compatible = (old: object | undefined, current: object | undefined, label: string) => {
  if (!old) return;
  if (!current || Object.entries(old).some(([key, value]) => (current as Record<string, unknown>)[key] !== value))
    throw Error(`${label} conflicts with the runtime release manifest`);
};

/** Pins come from the configured manifest, never today's observed RPC code.
 * An archive decoder still has to verify these pins against historical states. */
export function applyRuntimeManifestBindings(config: LedgerConfig, manifest: RuntimeReleaseManifest): void {
  if (manifest.network !== `ton:${config.network}`) throw Error('Runtime manifest network conflicts with indexer config');
  const contracts = manifest.contracts, templates = manifest.templates;
  const engine = contracts.PerpsEngine?.codeHash;
  if (config.ledgerPerpsEngineCodeHash && config.ledgerPerpsEngineCodeHash !== engine)
    throw Error('LEDGER_PERPS_ENGINE_CODE_HASH conflicts with the runtime release manifest');
  config.ledgerPerpsEngineCodeHash = engine;
  const options = contracts.OptionFactory && contracts.OptionVault ? {
    factoryCodeHash: contracts.OptionFactory.codeHash, vaultCodeHash: contracts.OptionVault.codeHash,
    shoutCodeHash: templates.ShoutOption, outperformanceCodeHash: templates.OutperformanceOption, walletCodeHash: templates.JettonWallet,
  } : undefined;
  compatible(config.ledgerOptionsCodeHashes, options, 'LEDGER_OPTIONS_CODE_HASHES_JSON');
  config.ledgerOptionsCodeHashes = options;
  const launchpad = contracts.SaleFactory ? { fixedCodeHash: templates.SaleFixed, bondingCodeHash: templates.SaleBonding,
    auctionCodeHash: templates.SaleAuction, walletCodeHash: templates.JettonWallet } : undefined;
  compatible(config.ledgerLaunchpadCodeHashes, launchpad, 'LEDGER_LAUNCHPAD_CODE_HASHES_JSON');
  config.ledgerLaunchpadCodeHashes = launchpad;

  const rootHash = (root: string) => Object.values(contracts).find(c => c?.address === root)?.codeHash;
  const tokenT = manifest.tokens.find(t => t.symbol === 'T3')!.root;
  const derived: DlmmMarketBinding[] = [];
  for (const spot of manifest.spotMarkets) {
    const tokenX = manifest.tokens.find(t => t.symbol === spot.symbol)!.root;
    const tokenTCodeHash = rootHash(tokenT), tokenXCodeHash = rootHash(tokenX);
    // External roots are not deployed singletons. Missing trusted root code
    // remains an explicit qualification gap, rather than RPC enrollment.
    if (!tokenTCodeHash || !tokenXCodeHash) continue;
    derived.push({ network: config.network, pool: spot.pool, poolCodeHash: templates.DlmmPool,
      walletCodeHash: templates.JettonWallet, tokenT, tokenX, tokenTCodeHash, tokenXCodeHash,
      router: contracts.DexRouter?.address ?? null, routerCodeHash: contracts.DexRouter?.codeHash ?? null });
  }
  for (const old of config.ledgerMarketBindings) {
    const spot = manifest.spotMarkets.find(s => s.pool === old.pool);
    const token = manifest.tokens.find(t => t.symbol === spot?.symbol);
    if (!spot || !token || old.network !== config.network || old.tokenT !== tokenT || old.tokenX !== token.root ||
      old.poolCodeHash !== templates.DlmmPool || old.walletCodeHash !== templates.JettonWallet ||
      old.router !== (contracts.DexRouter?.address ?? null) || old.routerCodeHash !== (contracts.DexRouter?.codeHash ?? null) ||
      (rootHash(tokenT) && old.tokenTCodeHash !== rootHash(tokenT)) || (rootHash(token.root) && old.tokenXCodeHash !== rootHash(token.root)))
      throw Error('LEDGER_MARKET_BINDINGS_JSON conflicts with the runtime release manifest');
    if (!derived.some(b => b.pool === old.pool)) derived.push(old);
  }
  config.ledgerMarketBindings = derived;
  const t3 = config.ledgerT3RedemptionBinding;
  if (t3 && (t3.network !== config.network || t3.hub !== contracts.T3?.address || t3.root !== contracts.T3Root?.address ||
    t3.hubCodeHash !== contracts.T3?.codeHash || t3.rootCodeHash !== contracts.T3Root?.codeHash ||
    t3.walletCodeHash !== templates.JettonWallet || t3.receiverCodeHash !== templates.T3Receiver ||
    t3.reserveRoutes.some(route => !manifest.tokens.some(token => ['USDT', 'USDC', 'KUSD'].includes(token.symbol) && token.root === route.root))))
    throw Error('LEDGER_T3_REDEMPTION_BINDING_JSON conflicts with the runtime release manifest');
}
