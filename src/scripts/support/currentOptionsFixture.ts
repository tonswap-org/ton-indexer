import { Address, Cell, beginCell, contractAddress } from '@ton/core';
import { boundaryState, boundaryTransaction } from '../../runtime/physicalEvidence';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../../orders/evidence';
import { readCurrentT3Hub, readCurrentT3Wallet } from '../../ledger/currentT3State';
import { canonicalLedgerHash } from '../../ledger/normalize';
import type { LedgerStateSnapshot } from '../../ledger/archive';
import type { LedgerT3RedemptionBinding } from '../../ledger/bindings';
import type { ProjectionInput, LedgerChain } from '../../ledger/project';
import type { LedgerAsset } from '../../ledger/types';
import type { NativeOptionProofBinding } from '../../ledger/currentOptionsProof';
import { loadOpcodes } from '../../utils/opcodes';
import assert from 'node:assert/strict';
/** Adapt original native envelopes into the ordinary archive/chain interface.
 * The publication sequence is a sandbox mock. All financial cells stay original. */
export function currentOptionsProjectionFixture(c: {
    binding: NativeOptionProofBinding;
    request: {
        owner: string;
    };
    completeTransactions: OrderTransactionEvidence[];
}): ProjectionInput {
    const states = new Map<string, LedgerStateSnapshot>(), after = new Set<string>(), latest = new Map<string, ReturnType<typeof verifyOrderTransaction>>(), chains = new Map<string, LedgerChain>(), wallets = new Map<string, LedgerAsset>();
    const key = (a: string, l: string, h: string) => `${a}:${l}:${canonicalLedgerHash(h)}`;
    for (const e of c.completeTransactions) {
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
    for (const [account, t] of latest) {
        const active = code(account);
        if (active?.type !== 'active' || !active.state.code || !active.state.data || active.state.code.hash().toString('hex') !== c.binding.walletCodeHash)
            continue;
        const state = readCurrentT3Wallet(active.state.data);
        assert.equal(state.master, c.binding.options.t3Root.toRawString());
        wallets.set(account, { kind: 'jetton', id: `localnet:jetton:${state.master}`, master: state.master, owner: state.owner, wallet: account, decimals: 9, symbol: 'T3' });
        if (state.owner === c.request.owner)
            chains.get(account)!.role = 'owned_jetton_wallet';
    }
    for (const chain of chains.values()) {
        chain.transactions.sort((a, b) => BigInt(a.lt) < BigInt(b.lt) ? -1 : 1);
        chain.headLt = chain.transactions.at(-1)!.lt;
        chain.headHash = chain.transactions.at(-1)!.hash;
    }
    const hub = c.binding.options.t3Root.toRawString(), active = code(hub);
    assert(active?.type === 'active' && active.state.data && active.state.code);
    assert.equal(active.state.code.hash().toString('hex'), c.binding.options.t3MasterHash);
    const state = readCurrentT3Hub(active.state.data);
    const binding: LedgerT3RedemptionBinding = { network: 'localnet', hub, root: hub, governance: state.governance, hubCodeHash: c.binding.options.t3MasterHash, walletCodeHash: c.binding.walletCodeHash, proofCodeHash: c.binding.proofCodeHash, configHash: state.configHash, reserveRoutes: [] };
    // Reserve routes are not used to prove these T3-to-T3 physical transfers. The
    // fixture deliberately admits no reserve-wallet or reserve-master decoder.
    const config = { address: hub, root: hub, codeHash: binding.hubCodeHash, redemptionBinding: binding, reserveRoots: [], vaults: [] };
    return { network: 'localnet', owner: c.request.owner, chains, wallets, pools: new Map(), t3Hubs: new Map([[hub, config]]), currentOptionsBinding: c.binding, optionControllers: [c.binding.options.factory.toRawString(), c.binding.options.vault.toRawString()], opcodes: loadOpcodes(), stateAt: async (a, l, h) => states.get(key(a, l, h)) ?? null };
}
export async function currentOptionsGraphFixture(input: ProjectionInput, override: {
    missingAccount?: string;
    maxAccounts?: number;
} = {}) {
    const { LedgerGraphBuilder } = await import('../../ledger/graph');
    const { fakeChainSource } = await import('./fakeChainSource');
    const { fixtureHead } = await import('./chainFixture');
    const boundary = fixtureHead(1), signal = new AbortController().signal;
    const source = fakeChainSource({ getAccountState: async (account, options) => {
            assert.deepEqual(options?.at, boundary);
            assert.equal(options?.signal, signal);
            if (account === override.missingAccount)
                throw Error('fixture archive unavailable');
            const row = input.chains.get(account)?.transactions.at(-1);
            if (!row)
                throw Error('fixture account unavailable');
            const state = await input.stateAt(account, row.lt, row.hash);
            assert(state);
            return state.state;
        } });
    const identities = { resolve: async (wallet: string) => input.wallets.get(wallet) ?? null, known: async () => null, reader: { wallet: async (root: string, owner: string, options: any) => {
                assert.deepEqual(options.at, boundary);
                assert.equal(options.signal, signal);
                const wallet = [...input.wallets].find(([, a]) => a.master === root && a.owner === owner);
                return wallet ? { status: 'ok', root, wallet: wallet[0], balanceRaw: '0' } : { status: 'unavailable', root, wallet: null };
            } } } as unknown as import('../../ledger/identities').WalletIdentityStore;
    const store = { pool: { query: async (sql: string, params: any[]) => {
                if (sql.includes('ledger_runs')) {
                    const c = input.chains.get(params[0]);
                    return { rows: c ? [{ source_complete: c.historyComplete, complete: c.historyComplete, head_lt: c.headLt, head_hash: c.headHash }] : [] };
                }
                if (sql.includes('ledger_account_states')) {
                    const snapshot = await input.stateAt(params[1], params[2], params[3]);
                    return { rows: snapshot ? [{ snapshot }] : [] };
                }
                throw Error('Unexpected graph store query');
            } }, rawHistory: async (generation: string) => (input.chains.get(generation)?.transactions ?? []).map(raw => ({ raw })) } as unknown as import('../../ledger/store').PostgresLedgerStore;
    const refresh: import('../../ledger/cycle').RefreshDependency = async (account) => { const c = input.chains.get(account); return { account, generation: account, head: c?.headLt && c.headHash ? { lt: c.headLt, hash: c.headHash } : null, complete: !!c?.historyComplete, atBoundary: !!c?.atBoundary, errorCode: null }; };
    return new LedgerGraphBuilder('localnet', source, store, [], undefined, identities, refresh, override.maxAccounts ?? 256, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], [], input.currentOptionsBinding).build(input.owner, input.owner, { boundary, signal });
}
