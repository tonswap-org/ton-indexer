import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell, contractAddress } from '@ton/core';
import { decodeOriginalTransaction } from '../../data/transactionEvidence';
import { verifyOrderTransaction } from '../../orders/evidence';
import { readCurrentT3Hub, readCurrentT3Wallet } from '../../ledger/currentT3State';
import { t3ReceiptLog } from '../../ledger/currentT3Wire';
import type { ProjectionInput, LedgerChain } from '../../ledger/project';
import type { LedgerAsset } from '../../ledger/types';
import type { RawMessage, RawTransaction } from '../../data/dataSource';
import { loadOpcodes } from '../../utils/opcodes';
import type { LedgerT3RedemptionBinding } from '../../ledger/bindings';
import type { LedgerStateSnapshot } from '../../ledger/archive';
import { canonicalLedgerHash } from '../../ledger/normalize';
import { assertCurrentCaptureProducer, readCurrentCaptureManifest } from '../current-capture-build';
const sha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const producers = {
    hub: { producer: 'hub', suite: 'tests/system/ReleaseUserSmoke.spec.ts', tests: 2,
        receiptSha256: 'd495ae80936273751a10d6f2243e17cb4e6b0c6288901ff2b2df67397c15502c',
        bindingSha256: 'ba53be0c33d58a8b64905043056d56bfd501f32fe612e624f9de07870dd57077' },
    recovery: { producer: 't3Recovery', suite: 'tests/system/T3RecoveryCapture.spec.ts', tests: 6,
        receiptSha256: '74acbd059b2a4e4c35a85f36748e23b0c93c572cc7e1d666b09864dfa7fee295',
        bindingSha256: '9be45cd6c2429512aec47c21c120caa314a7cadb6747541b9a37996484d3b365' },
} as const;
export function currentT3Fixture(name = 'case-01.json', directory = 'hub') {
    assert(directory === 'hub' || directory === 'recovery', 'Unknown current T3 producer');
    const root = join(__dirname, '../fixtures/current-t3', directory), bytes = (name: string) => readFileSync(join(root, name));
    const closure = join(root, '../source-closure'), inventoryBytes = readFileSync(join(closure, 'inventory.json'));
    assert.equal(sha(inventoryBytes), '6ffd0e2f27380bc1dfe112fe4cc5e66cd2c18c6a4bde21b53a79652e725afbf8');
    const inventory = JSON.parse(inventoryBytes.toString());
    for (const entry of inventory.files) {
        const original = readFileSync(join(closure, entry.file));
        assert.equal(original.length, entry.bytes);
        assert.equal(sha(original), entry.sha256, `${entry.file}: original T3 source/artifact bytes`);
    }
    const snapshot = readCurrentCaptureManifest({ nativeRoot: join(closure, 'source'),
        manifestPath: join(closure, 'manifest.json'), artifactRoot: join(closure, 'artifacts'),
        expectedManifestSha256: '366e72a3593a321128bb6744018e51599980c9d7f40af9c063417f23d1320a4b' });
    const { binding } = assertCurrentCaptureProducer(snapshot, {
        ...producers[directory], directory: root, log: bytes('producer.log'),
    });
    assert(Object.hasOwn(binding.captures, name), 'T3 case must belong to the authenticated original producer');
    const captured = JSON.parse(bytes(name).toString()), states = new Map<string, LedgerStateSnapshot>(), ambiguousStates = new Set<string>(), afterStates = new Set<string>();
    const key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
    const rows = captured.transactions.map((row: any) => {
        const verified = verifyOrderTransaction({ account: row.account, transactionBoc: row.boc, beforeShardAccountBoc: row.before.originalShardAccount, afterShardAccountBoc: row.after.originalShardAccount });
        assert.equal(verified.hash, row.hash);
        assert.equal(verified.tx.lt.toString(), row.lt);
        for (const [side, shard] of [['before', verified.before], ['after', verified.after]] as const) {
            const saved = row[side], active = shard.account?.storage.state;
            const code = active?.type === 'active' ? active.state.code?.toBoc().toString('base64') : undefined, data = active?.type === 'active' ? active.state.data?.toBoc().toString('base64') : undefined;
            assert.equal(code, saved.codeBoc ?? undefined);
            assert.equal(data, saved.dataBoc ?? undefined);
            const snapshot: LedgerStateSnapshot = { seqno: 1, state: { accountState: active?.type === 'active' ? 'active' : active?.type === 'frozen' ? 'frozen' : 'uninitialized', balance: String(saved.balance ?? 0), shardAccountBoc: saved.originalShardAccount, codeBoc: code, dataBoc: data, lastTxLt: saved.lastTxLt, lastTxHash: saved.lastTxHash } };
            const k = key(row.account, saved.lastTxLt, saved.lastTxHash), old = states.get(k);
            if (old && JSON.stringify(old) !== JSON.stringify(snapshot))
                ambiguousStates.add(k);
            // A transaction's own committed after-state remains authoritative.
            // A later synthetic before-state cannot rewrite that historical row;
            // verification of the later transaction fails at its exact boundary.
            if (side === 'after' || !afterStates.has(k))
                states.set(k, snapshot);
            if (side === 'after')
                afterStates.add(k);
        }
        return { account: row.account, raw: decodeOriginalTransaction(Cell.fromBase64(row.boc), Address.parse(row.account)), row };
    });
    const hubCodeHash = binding.targets.T3Hub.codeHash, hubRows = rows.filter((r: any) => r.row.after.codeBoc && Cell.fromBase64(r.row.after.codeBoc).hash().toString('hex') === hubCodeHash), hub = hubRows[0].account;
    const state = readCurrentT3Hub(hubRows.at(-1)!.row.after.dataBoc), v21 = binding.targets.JettonV21Wallet?.codeHash;
    const stablecoinWallet = Cell.fromBoc(readFileSync(join(root, '../stablecoin/JettonWallet.code.boc')))[0];
    const stablecoinMaster = Cell.fromBoc(readFileSync(join(root, '../stablecoin/JettonMinter.code.boc')))[0];
    const t3Binding: LedgerT3RedemptionBinding = { network: 'localnet', hub, root: hub, governance: state.governance, hubCodeHash, walletCodeHash: state.walletCodeHash, proofCodeHash: state.proofCodeHash, configHash: state.configHash,
        reserveRoutes: [0, 1, 2].map(slot => {
            const profile = state.slots.get(slot)!, policy = state.policies.get(slot)!;
            const walletStorage = policy.codeHash === v21 ? 'jetton-v21' : policy.codeHash === stablecoinWallet.hash().toString('hex') ? 'stablecoin' : null;
            assert(walletStorage, 'capture reserve uses an explicitly qualified wallet code');
            const masterCodeHash = walletStorage === 'stablecoin' ? stablecoinMaster.hash().toString('hex') : binding.targets.JettonV21Minter.codeHash;
            const masterRows = rows.filter((r: any) => r.account === profile.master && r.row.after.codeBoc);
            for (const row of masterRows)
                assert.equal(Cell.fromBase64(row.row.after.codeBoc).hash().toString('hex'), masterCodeHash, 'captured reserve master code');
            assert(profile.wallet || walletStorage === 'jetton-v21', 'capture must retain a configured stablecoin vault');
            return { slot, root: profile.master, vault: profile.wallet ?? contractAddress(0, { code: Cell.fromBoc(bytes('compiler/JettonV21Wallet.boc'))[0], data: beginCell().storeCoins(0).storeAddress(Address.parse(hub)).storeAddress(Address.parse(profile.master)).endCell() }).toRawString(), masterCodeHash, walletCodeHash: policy.codeHash, decimals: 9 - Math.log10(policy.scale), walletStorage, scale: policy.scale, lockExit: policy.lockExit, balanceExit: policy.balanceExit, profile };
        }) };
    return { captured, rows, hubRows, hub, state, binding: t3Binding, states, ambiguousStates, key, stateAt: async (account: string, lt: string, hash: string) => states.get(key(account, lt, hash)) ?? null };
}
/** Financial rows are original native captures. The tx helper adds only empty
 * publication-refresh triggers and cannot qualify a product settlement. Sandbox
 * setup balance injections stay explicit unavailable archive boundaries. */
export function currentT3MintFixture(name = 'case-01.json') {
    const f = currentT3Fixture(name, 'recovery');
    const receipt = f.hubRows.flatMap((r: any) => r.raw.outMessages.map(t3ReceiptLog)).find((r: any) => r?.kind === 'credit' && r.mint);
    assert(receipt?.kind === 'credit');
    const owner = receipt.credit.owner;
    const wallets = new Map<string, LedgerAsset>(), latest = new Map<string, any>();
    for (const r of f.rows)
        latest.set(r.account, r);
    for (const [account, row] of latest) {
        const boc = row.row.after.codeBoc, data = row.row.after.dataBoc;
        if (!boc || !data)
            continue;
        const codeHash = Cell.fromBase64(boc).hash().toString('hex');
        if (codeHash === f.binding.walletCodeHash) {
            const state = readCurrentT3Wallet(data);
            assert.equal(state.master, f.hub);
            wallets.set(account, { kind: 'jetton', id: `localnet:jetton:${f.hub}`, master: f.hub, owner: state.owner, wallet: account, decimals: 9, symbol: 'T3' });
            continue;
        }
        const route = f.binding.reserveRoutes.find(r => r.walletCodeHash === codeHash);
        if (!route)
            continue;
        const s = Cell.fromBase64(data).beginParse();
        if (route.walletStorage === 'stablecoin')
            s.loadUint(4);
        s.loadCoins();
        const walletOwner = s.loadAddress().toRawString(), master = s.loadAddress().toRawString();
        s.endParse();
        const reserve = f.binding.reserveRoutes.find(r => r.root === master && r.walletCodeHash === codeHash);
        assert(reserve);
        wallets.set(account, { kind: 'jetton', id: `localnet:jetton:${master}`, master, owner: walletOwner, wallet: account, decimals: reserve.decimals, symbol: ['USDT', 'USDC', 'KUSD'][reserve.slot] });
    }
    const chains = new Map<string, LedgerChain>();
    for (const r of f.rows) {
        let chain = chains.get(r.account);
        if (!chain) {
            chain = { account: r.account, generation: null, historyComplete: true, atBoundary: true, role: r.account === owner ? 'owner' : wallets.get(r.account)?.owner === owner ? 'owned_jetton_wallet' : 'counterparty', transactions: [] };
            chains.set(r.account, chain);
        }
        chain.transactions.push(r.raw);
    }
    for (const chain of chains.values()) {
        chain.transactions.sort((a, b) => BigInt(a.lt) < BigInt(b.lt) ? -1 : 1);
        chain.headLt = chain.transactions.at(-1)!.lt;
        chain.headHash = chain.transactions.at(-1)!.hash;
    }
    const config = { address: f.hub, root: f.hub, codeHash: f.binding.hubCodeHash, redemptionBinding: f.binding, reserveRoots: f.binding.reserveRoutes.map(r => r.root), vaults: f.binding.reserveRoutes.map(r => r.vault) };
    const input: ProjectionInput = { network: 'localnet', owner, chains, wallets, pools: new Map(), t3Hubs: new Map([[f.hub, config]]), opcodes: loadOpcodes(), stateAt: f.stateAt };
    let nextLt = f.rows.reduce((n: bigint, r: any) => BigInt(r.raw.lt) > n ? BigInt(r.raw.lt) : n, 0n), nextTime = f.rows.reduce((n: number, r: any) => Math.max(n, r.raw.utime), 0);
    const tx = (account: string, inMessage?: RawMessage, outMessages: RawMessage[] = []): RawTransaction => {
        assert(!inMessage && !outMessages.length, 'refresh trigger cannot invent financial messages');
        const chain = chains.get(account);
        assert(chain, 'create the explicit test account chain first');
        const previous = chain.transactions.at(-1);
        nextLt++;
        nextTime++;
        const raw: RawTransaction = { lt: String(nextLt), hash: createHash('sha256').update(`nonfinancial-refresh:${nextLt}`).digest('base64'), prevTransactionLt: previous?.lt ?? '0', prevTransactionHash: previous?.hash ?? Buffer.alloc(32).toString('base64'), utime: nextTime, success: true, status: 'success', totalFeesRaw: '7', outMessages: [] };
        chain.transactions.push(raw);
        chain.headLt = raw.lt;
        chain.headHash = raw.hash;
        return raw;
    };
    return { ...f, input, config, tx };
}
