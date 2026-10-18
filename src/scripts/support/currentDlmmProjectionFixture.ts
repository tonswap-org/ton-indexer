import { Cell } from '@ton/core';
import { boundaryState, boundaryTransaction } from '../../runtime/physicalEvidence';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../../orders/evidence';
import { readCurrentT3Hub, readCurrentT3Wallet } from '../../ledger/currentT3State';
import { canonicalLedgerHash } from '../../ledger/normalize';
import type { LedgerStateSnapshot } from '../../ledger/archive';
import type { LedgerT3RedemptionBinding } from '../../ledger/bindings';
import type { ProjectionInput, LedgerChain } from '../../ledger/project';
import type { LedgerAsset } from '../../ledger/types';
import type { CurrentDlmmProofBinding } from '../../ledger/currentDlmmPhysical';
import { loadOpcodes } from '../../utils/opcodes';
import assert from 'node:assert/strict';
/** Adapt original native envelopes into the ordinary archive/chain interface.
 * The publication sequence is a sandbox mock. All financial cells stay original. */
export function currentDlmmProjectionFixture(c: {
    binding: CurrentDlmmProofBinding;
    request: {
        owner: string;
    };
    transactions: OrderTransactionEvidence[];
}): ProjectionInput {
    const p=c.binding.pools[0],t3=p.t3;
    const states = new Map<string, LedgerStateSnapshot>(), after = new Set<string>(), latest = new Map<string, ReturnType<typeof verifyOrderTransaction>>(), chains = new Map<string, LedgerChain>(), wallets = new Map<string, LedgerAsset>();
    const key = (a: string, l: string, h: string) => `${a}:${l}:${canonicalLedgerHash(h)}`;
    for (const e of c.transactions) {
        const t = verifyOrderTransaction(e), raw = boundaryTransaction({ evidence: e, seqno: 1 });
        latest.set(e.account, t);
        for (const [side, boc] of [['before', e.beforeShardAccountBoc], ['after', e.afterShardAccountBoc]] as const) {
            const state = boundaryState(e.account, boc, 1), k = key(e.account, state.state.lastTxLt!, state.state.lastTxHash!);
            if (side === 'after' || !after.has(k))
                states.set(k, state);
            if (side === 'after')
                after.add(k);
        }
        let chain = chains.get(e.account);
        if (!chain) {
            chain = { account: e.account, generation: null, historyComplete: true, atBoundary: true, role: e.account === c.request.owner ? 'owner' : 'counterparty', transactions: [] };
            chains.set(e.account, chain);
        }
        chain.transactions.push(raw);
    }
    const code = (a: string) => latest.get(a)?.after.account?.storage.state;
    const activeWallet = (a: string) => c.transactions.filter(t=>t.account===a).flatMap(e=>{const t=verifyOrderTransaction(e);return [t.before.account?.storage.state,t.after.account?.storage.state];}).filter(s=>s?.type==='active').at(-1);
    for (const [account, t] of latest) {
        const active = activeWallet(account);
        if (active?.type !== 'active' || !active.state.code || !active.state.data || active.state.code.hash().toString('hex') !== t3.walletCodeHash)
            continue;
        const state = readCurrentT3Wallet(active.state.data);
        assert.equal(state.master, t3.root);
        wallets.set(account, { kind: 'jetton', id: `localnet:jetton:${state.master}`, master: state.master, owner: state.owner, wallet: account, decimals: 9, symbol: 'T3' });
        if (state.owner === c.request.owner)
            chains.get(account)!.role = 'owned_jetton_wallet';
    }
    for (const chain of chains.values()) {
        chain.transactions.sort((a, b) => BigInt(a.lt) < BigInt(b.lt) ? -1 : 1);
        chain.headLt = chain.transactions.at(-1)!.lt;
        chain.headHash = chain.transactions.at(-1)!.hash;
    }
    const hub = t3.root, active = code(hub);
    assert(active?.type === 'active' && active.state.data && active.state.code);
    assert.equal(active.state.code.hash().toString('hex'), t3.masterCodeHash);
    const state = readCurrentT3Hub(active.state.data);
    const binding: LedgerT3RedemptionBinding = { network: 'localnet', hub, root: hub, governance: state.governance, hubCodeHash: t3.masterCodeHash, walletCodeHash: t3.walletCodeHash, proofCodeHash: c.binding.release.templates.T3RecoveryProof, configHash: state.configHash, reserveRoutes: [] };
    // Reserve routes are not used to prove these T3-to-T3 physical transfers. The
    // fixture deliberately admits no reserve-wallet or reserve-master decoder.
    for(const identity of p.wallets){if(!identity.address)continue;const token=identity.root===p.t3.root?p.t3:p.x;
        wallets.set(identity.address,{kind:'jetton',id:`localnet:jetton:${identity.root}`,master:identity.root,owner:identity.owner,wallet:identity.address,decimals:token.decimals,symbol:token.symbol});
        if(identity.owner===c.request.owner&&chains.has(identity.address))chains.get(identity.address)!.role='owned_jetton_wallet';
    }
    const config = { address: hub, root: hub, codeHash: binding.hubCodeHash, redemptionBinding: binding, reserveRoots: [], vaults: [] };
    return { network: 'localnet', owner: c.request.owner, chains, wallets, pools: new Map(), t3Hubs: new Map([[hub, config]]), currentDlmmBinding: c.binding, opcodes: loadOpcodes(), stateAt: async (a, l, h) => states.get(key(a, l, h)) ?? null };
}
