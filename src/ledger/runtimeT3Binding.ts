import { Cell, Dictionary } from '@ton/core';
import type { ChainSource, ReadOptions } from '../data/dataSource';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { createJettonWalletReader } from '../data/jettonWallet';
import { validateT3RedemptionBinding, type LedgerT3RedemptionBinding } from './bindings';
import { readCurrentT3Hub } from './currentT3State';
/** A canonical cold optional wallet carries no assets. The exact current owed
 * book total includes both direct entries and sparse-archive liabilities. */
function noOwedLiability(cell: Cell | undefined): boolean {
    if (!cell) return true;
    if (cell.isExotic) return false;
    const s = cell.beginParse(), total = s.loadCoins(), count = s.loadUint(16);
    const entries = s.loadDict(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)), archive = s.loadMaybeRef(); s.endParse();
    if (total !== 0n || count !== 0 || entries.size !== 0) return false;
    if (!archive) return true;
    if (archive.isExotic) return false;
    const a = archive.beginParse(), appended = a.loadUintBig(65); a.loadUintBig(256);
    const archivedTotal = a.loadCoins(), frontier = a.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256)); a.endParse();
    return appended > 0n && appended <= 1n << 64n && archivedTotal === 0n && [...frontier.keys()].every(level => level < 64);
}
/** Manifest pins are authority; observed code never enrolls an implementation.
 * Every account and getter in this derivation uses one authenticated chain head. */
export async function deriveT3RedemptionBinding(manifest: RuntimeReleaseManifest, source: ChainSource, readOptions: ReadOptions = {}): Promise<LedgerT3RedemptionBinding | undefined> {
    const hub = manifest.contracts.T3Hub;
    if (!hub)
        return undefined;
    const options = { ...readOptions, at: readOptions.at ?? await source.head(readOptions) };
    const state = await source.getAccountState(hub.address, options);
    if (state.accountState !== 'active' || !state.codeBoc || !state.dataBoc || Cell.fromBase64(state.codeBoc).isExotic || Cell.fromBase64(state.codeBoc).hash().toString('hex') !== hub.codeHash)
        throw Error('T3 hub state does not match the runtime manifest');
    const parsed = readCurrentT3Hub(state.dataBoc);
    if (parsed.governance !== manifest.contracts.Governance?.address || parsed.walletCodeHash !== manifest.templates.T3Wallet || parsed.proofCodeHash !== manifest.templates.T3RecoveryProof)
        throw Error('T3 immutable authority or template mismatch');
    const tokens = ['USDT', 'USDC', 'KUSD'].map(symbol => manifest.tokens.find(t => t.symbol === symbol));
    if (tokens.some(t => !t))
        throw Error('T3 requires all three declared reserve roots');
    const reader = createJettonWalletReader({ source, tokens: tokens.map(t => ({ ...t!, master: t!.root })) });
    if (parsed.slots.size !== 3 || [0, 1, 2].some(slot => !parsed.slots.has(slot)) || [...parsed.owed.keys()].some(slot => slot > 2))
        throw Error('T3 requires exactly three current reserve slots');
    const reserveRoutes = [];
    for (const [slot, t] of tokens.entries()) {
        const token = t!, profile = parsed.slots.get(slot), policy = parsed.policies.get(slot)!;
        if (!profile || profile.optional !== (slot === 2) || profile.master !== token.root || (!profile.wallet && slot !== 2) || policy.scale !== 10 ** (9 - token.decimals) || policy.codeHash !== token.walletCodeHash)
            throw Error('T3 reserve identity, precision or wallet pin mismatch');
        const verified = await reader.wallet(token.root, hub.address, options);
        const coldOptional = verified.status === 'not_deployed' && slot === 2 && profile.optional
            && (parsed.admitted & 4) === 0 && (parsed.frozen & 4) === 0
            && parsed.backing[2] === 0n && parsed.pending[2] === 0n && noOwedLiability(parsed.owed.get(2));
        if (verified.status === 'unavailable' || (verified.status !== 'ok' && !coldOptional)
            || (profile.wallet !== null && verified.wallet !== profile.wallet))
            throw Error('T3 reserve wallet is not authenticated at the pinned head');
        const walletStorage = token.walletCodeHash === manifest.vendor.stablecoin.wallet.codeHash ? 'stablecoin' : token.walletCodeHash === manifest.templates.JettonV21Wallet ? 'jetton-v21' : null;
        if (!walletStorage)
            throw Error('Unqualified reserve wallet storage decoder');
        reserveRoutes.push({ slot, walletStorage, root: token.root, vault: verified.wallet, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash, decimals: token.decimals,
            scale: policy.scale, lockExit: policy.lockExit, balanceExit: policy.balanceExit, profile });
    }
    return validateT3RedemptionBinding({ network: manifest.network.slice(4), hub: hub.address, root: hub.address, governance: parsed.governance, hubCodeHash: hub.codeHash,
        walletCodeHash: parsed.walletCodeHash, proofCodeHash: parsed.proofCodeHash, configHash: parsed.configHash, reserveRoutes }, manifest.network.slice(4) as LedgerT3RedemptionBinding['network']);
}
