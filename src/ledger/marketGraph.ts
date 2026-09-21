import { resolveHistoricalJettonPrecision, type HistoricalRootArchive } from './jettonPrecision';
import type { TonDataSource } from '../data/dataSource';
import type { LedgerService } from './service';
import type { DlmmMarketBinding, MarketDependency, MarketNode } from './marketTypes';
import { findTransactionState, type LedgerStateSnapshot } from './archive';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { bodyCell, NOTIFY, opcode as messageOpcode, SWAP, tokenWire } from './wire';
import { readDlmmMarketState } from './dlmmState';
import { parseDlmmSwapForward } from '../utils/dlmmSettlementEvidence';
import { perpsWalletAddress } from './perpsWire';

/** A pool-seeded, ownership-independent graph over durable physical chains. */
export class DlmmMarketGraphBuilder {
  constructor(private ledger: LedgerService, private source: TonDataSource, private maxAccounts = 256) {}

  async build(binding: DlmmMarketBinding) {
    if (binding.network !== this.ledger.network) throw new Error('market_network_mismatch');
    const nodes: MarketNode[] = [], dependencies: MarketDependency[] = [], issues = new Set<string>(), loaded = new Set<string>();
    const snapshots = new Map<string, Promise<LedgerStateSnapshot | null>>();
    const rootStates = new Map<string,Promise<{state:HistoricalRootArchive['before']['state'];observedAt:string}>>();
    const rootStateAt = (root:string,seqno:number) => {
      const id=`${root}:${seqno}`;let promise=rootStates.get(id);
      if(!promise){promise=(async()=>{
        const cached=(await this.ledger.store.pool.query('SELECT snapshot,observed_at FROM market_root_archive_states WHERE network=$1 AND root=$2 AND seqno=$3',[binding.network,root,seqno])).rows[0];
        if(cached)return {state:cached.snapshot,observedAt:new Date(cached.observed_at).toISOString()};
        if(!this.source.getAccountStateAtSeqno || this.source.network!==binding.network)throw Error('root_archive_provider_unavailable');
        const state=await this.source.getAccountStateAtSeqno(root,seqno),observedAt=new Date().toISOString();
        if(state.accountState!=='active' || !state.codeBoc || !state.dataBoc || !state.lastTxLt || !state.lastTxHash)throw Error('root_archive_state_unavailable');
        const inserted=await this.ledger.store.pool.query('INSERT INTO market_root_archive_states(network,root,seqno,snapshot,observed_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING snapshot,observed_at',[binding.network,root,seqno,JSON.stringify(state),observedAt]);
        // Concurrent readers must use the one immutable stored snapshot, not
        // each caller's competing provider response after a publication race.
        const stored=inserted.rows[0] ?? (await this.ledger.store.pool.query('SELECT snapshot,observed_at FROM market_root_archive_states WHERE network=$1 AND root=$2 AND seqno=$3',[binding.network,root,seqno])).rows[0];
        if(!stored)throw Error('root_archive_publication_unavailable');
        return {state:stored.snapshot,observedAt:new Date(stored.observed_at).toISOString()};
      })();rootStates.set(id,promise);}return promise;
    };
    const precisionAt = async (node:MarketNode,root:string,rootCodeHash:string) => {
      const execution={account:binding.pool,lt:node.raw.lt,hash:Buffer.from(canonicalLedgerHash(node.raw.hash),'base64').toString('hex'),utime:node.raw.utime};
      let archive:HistoricalRootArchive|null=null;
      try {
        const seqno=node.after?.seqno;if(!Number.isSafeInteger(seqno) || !seqno || seqno<1)throw Error('execution_archive_missing');
        const [before,after]=await Promise.all([rootStateAt(root,seqno-1),rootStateAt(root,seqno)]);
        archive={kind:'masterchain-execution-bracket',provider:'configured-ton-data-source',observedAt:before.observedAt>after.observedAt?before.observedAt:after.observedAt,executionSeqno:seqno,before:{seqno:seqno-1,state:before.state},after:{seqno,state:after.state}};
      } catch { /* Precision is a separate prerequisite; preserve the atomic execution. */ }
      return resolveHistoricalJettonPrecision({network:binding.network,root,rootCodeHash,walletCodeHash:binding.walletCodeHash},execution,archive);
    };
    const stateAt = (account: string, lt: string, hash: string) => {
      const normalized = canonicalLedgerHash(hash), id = `${account}:${lt}:${normalized}`;
      let promise = snapshots.get(id);
      if (!promise) {
        promise = (async () => {
          const cached = (await this.ledger.store.pool.query('SELECT snapshot FROM ledger_account_states WHERE network=$1 AND account=$2 AND lt=$3 AND hash=$4', [binding.network, account, lt, normalized])).rows[0];
          if (cached) return cached.snapshot as LedgerStateSnapshot;
          const snapshot = await findTransactionState(this.source, account, { lt, hash: normalized });
          if (snapshot) await this.ledger.store.pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
            [binding.network, account, lt, normalized, JSON.stringify(snapshot)]);
          return snapshot;
        })();
        snapshots.set(id, promise);
      }
      return promise;
    };
    const hydrate = async (node: MarketNode) => {
      try {
        node.after = await stateAt(node.account, node.raw.lt, node.raw.hash);
        if (node.raw.prevTransactionLt && node.raw.prevTransactionHash) {
          node.before = await stateAt(node.account, node.raw.prevTransactionLt, node.raw.prevTransactionHash);

        }
      } catch { issues.add('market_archive_unavailable'); }
    };
    const load = async (account: string) => {
      if (loaded.has(account)) return nodes.filter(node => node.account === account);
      if (loaded.size >= this.maxAccounts) { issues.add('market_related_account_limit'); return []; }
      loaded.add(account);
      try { await this.ledger.syncAccount(account, false); } catch { issues.add('market_chain_refresh_unavailable'); }
      const state = await this.ledger.store.account(binding.network, account);
      const generation = state?.latest_generation ?? state?.current_generation;
      if (!generation) { issues.add('market_related_history_unavailable'); return []; }
      const run = (await this.ledger.store.pool.query('SELECT generation,network,account,head_lt::text,head_hash,complete,source_complete,head_observed_at,verified_through FROM ledger_runs WHERE generation=$1', [generation])).rows[0];
      if (!run || run.network !== binding.network || run.account !== account || !run.head_lt || !run.head_hash || !run.head_observed_at) {
        issues.add('market_related_history_unavailable'); return [];
      }
      const checkedThrough = generation === state.current_generation && state.checked_at ? state.checked_at : run.verified_through ?? run.head_observed_at;
      dependencies.push({ account, generation, historyComplete: Boolean(run.complete && run.source_complete), headLt: run.head_lt,
        headHash: Buffer.from(canonicalLedgerHash(run.head_hash), 'base64').toString('hex'), checkedThrough: new Date(checkedThrough).toISOString() });
      const rows: MarketNode[] = await this.ledger.store.rawHistory(generation); nodes.push(...rows); return rows;
    };
    const poolNodes = await load(binding.pool), needed = new Set<string>();
    for (const node of poolNodes) {
      if (node.raw.success && (!node.raw.status || node.raw.status === 'success') && !bodyCell(node.raw.inMessage)) issues.add('market_pool_input_undecodable');
      const notice = tokenWire(node.raw.inMessage), payload = notice?.op === NOTIFY ? notice.forward : null;
      if ((node.raw.inMessage?.op === NOTIFY || messageOpcode(node.raw.inMessage) === NOTIFY) && (!notice || notice.forward.bits.length < 32)) issues.add('market_pool_notification_undecodable');
      const swap = payload && payload.bits.length >= 32 && payload.beginParse().preloadUint(32) === SWAP ? parseDlmmSwapForward(payload) : null;
      const op = bodyCell(node.raw.inMessage)?.beginParse();
      const opcode = op && op.remainingBits >= 32 ? op.preloadUint(32) : null;
      if (!swap && ![0x4a535543, 0x4a53464b, 0x44535259].includes(opcode ?? -1)) continue;
      await hydrate(node);
      if (!swap || !notice) continue;
      const [tPrecision,xPrecision]=await Promise.all([precisionAt(node,binding.tokenT,binding.tokenTCodeHash),precisionAt(node,binding.tokenX,binding.tokenXCodeHash)]);
      node.assetPrecision=swap.zeroForOne===1?{input:tPrecision,output:xPrecision}:{input:xPrecision,output:tPrecision};
      if (notice.owner) needed.add(notice.owner);
      if (notice.senderWallet) needed.add(notice.senderWallet);
      if (node.raw.inMessage?.source) try { needed.add(canonicalLedgerAddress(node.raw.inMessage.source)); } catch { issues.add('market_wallet_address_invalid'); }
      try {
        if (!node.after?.state.dataBoc) throw new Error();
        const state = readDlmmMarketState(node.after.state.dataBoc);
        if (state.tokenT !== binding.tokenT || state.tokenX !== binding.tokenX || state.walletCodeHash !== binding.walletCodeHash) throw new Error();
        const inputRoot = swap.zeroForOne === 1 ? binding.tokenT : binding.tokenX;
        needed.add(perpsWalletAddress(state.walletCode, inputRoot, binding.pool));
        if (notice.owner) needed.add(perpsWalletAddress(state.walletCode, inputRoot, notice.owner));
        for (const record of state.settlements.values()) { needed.add(record.sourceWallet); needed.add(record.destinationWallet); }
      } catch { issues.add('market_historical_wallet_derivation_unavailable'); }
    }
    for (const account of [...needed].sort()) {
      const related = await load(account);
      for (const node of related) {
        const cell = bodyCell(node.raw.inMessage), op = cell && cell.bits.length >= 32 ? cell.beginParse().preloadUint(32) : null;
        if ([0x0f8a7ea5, 0x178d4519, 0x4a534954, 0x4a534143, 0x4a53464e].includes(op ?? -1)) await hydrate(node);
      }
    }
    return { nodes, dependencies, issues: [...issues].sort() };
  }
}
