import type { ChainHead, ChainSource, AccountStateResponse, RawTransaction } from '../data/dataSource';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { verifyFrozenProductHistory } from '../runtime/productEvidence';
import { readBoundCurrentPerpsEngine, decodeNativePerpsRiskState, type NativePerpsProofBinding } from './currentPerpsProof';
import { readCurrentT3Hub, readCurrentT3Wallet } from './currentT3State';
import { canonicalLedgerHash } from './normalize';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from './project';
import type { LedgerAsset } from './types';
import type { Network } from '../models';
import type { OpcodeSets } from '../utils/opcodes';

type Bounds={fromUtime:number;toUtime:number};
type Capture={transactions:RawTransaction[];headTransactions:RawTransaction[];boundary:RawTransaction|null};
/** The range scheduler owns persistence and budgets. This adapter uses only the
 * current release peers, original archive boundaries and physical T3 protocol. */
export async function collectCurrentPerpsRange(input:{network:Network;owner:string;generation:string;source:ChainSource;head:ChainHead;binding:NativePerpsProofBinding;bounds:Bounds;opcodes:OpcodeSets;stateAt:ProjectionInput['stateAt'];capture:(account:string,state:AccountStateResponse,bounds:Bounds)=>Promise<Capture>}){
 const {network,owner,generation,source,head,binding:b,bounds,stateAt}=input,p=b.perps,root=p.t3Root.toRawString(),engine=p.engine.toRawString(),risk=p.riskVault.toRawString();
 if(network!==b.network)throw Error('perps_range_binding_unconfigured');
 const options={at:head},states=new Map<string,AccountStateResponse>();
 const current=async(account:string)=>{let state=states.get(account);if(!state){state=await source.getAccountState(account,options);states.set(account,state);}return state;};
 const original=async(account:string)=>{const state=await current(account);if(!state.shardAccountBoc)throw Error('perps_range_original_state_unavailable');return orderShard(state.shardAccountBoc,account).shard;};
 const engineState=readBoundCurrentPerpsEngine(activeOrderAccount(await original(engine),p.engineHash).data,b),hub=readCurrentT3Hub(activeOrderAccount(await original(root),p.t3MasterHash).data);
 const reader=createJettonWalletReader({source,tokens:[{master:root,masterCodeHash:p.t3MasterHash,walletCodeHash:p.t3WalletHash}]}),wallets=new Map<string,LedgerAsset>();
 const selected=await Promise.all([owner,engine,risk].map(async party=>{const w=await reader.identity(root,party,options);if(w.walletCode.hash().toString('hex')!==p.t3WalletHash)throw Error('perps_range_wallet_identity_unverified');wallets.set(w.wallet,{kind:'jetton',id:`${network}:jetton:${root}`,master:root,owner:party,wallet:w.wallet,symbol:'T3',decimals:9});return w.wallet;}));
 const [ownerWallet,engineWallet,riskWallet]=selected,accounts=[owner,ownerWallet,engine,engineWallet],oraclePools=[...new Set([...engineState.book.markets.values()].map(m=>m.pool.toRawString()))],protocolPeers=[risk,riskWallet,root];
 if(new Set([...accounts,...oraclePools,...protocolPeers]).size!==accounts.length+oraclePools.length+protocolPeers.length)throw Error('perps_range_account_identity_conflict');
 const chains=new Map<string,LedgerChain&Capture&{headLt:string|null;headHash:string|null}>();
 for(const account of [...accounts,...oraclePools,...protocolPeers]){
  const state=await current(account),frozen=state.accountState==='frozen',captured=await input.capture(account,state,frozen?{fromUtime:0,toUtime:bounds.toUtime}:bounds);
  chains.set(account,{account,generation,role:account===owner?'owner':account===ownerWallet?'owned_jetton_wallet':'counterparty',historyComplete:false,verifiedRange:bounds,checkedAt:new Date(head.utime*1000).toISOString(),...captured,transactions:captured.transactions.filter(t=>t.utime>=bounds.fromUtime&&t.utime<bounds.toUtime),headLt:state.lastTxLt??null,headHash:state.lastTxHash?canonicalLedgerHash(state.lastTxHash):null});
 }
 const pinned=async(account:string,pin:string)=>{
  const shard=await original(account);if(shard.account?.storage.state.type==='active')return activeOrderAccount(shard,pin).data;
  const rows=await Promise.all(chains.get(account)!.headTransactions.map(async raw=>{
   if(!raw.rawBoc||!raw.prevTransactionLt||!raw.prevTransactionHash)throw Error('perps_range_original_state_unavailable');
   const before=await stateAt(account,raw.prevTransactionLt,raw.prevTransactionHash),after=await stateAt(account,raw.lt,raw.hash);if(!before?.state.shardAccountBoc||!after?.state.shardAccountBoc)throw Error('perps_range_original_state_unavailable');
   return{evidence:{account,transactionBoc:raw.rawBoc,beforeShardAccountBoc:before.state.shardAccountBoc,afterShardAccountBoc:after.state.shardAccountBoc}};
  }));
  verifyFrozenProductHistory(rows,shard,pin);
  const last=rows.map(r=>verifyOrderTransaction(r.evidence)).sort((a,b)=>a.tx.lt<b.tx.lt?-1:1).flatMap(t=>[t.before,t.after]).filter(s=>s.account?.storage.state.type==='active').at(-1);if(!last)throw Error('perps_range_original_state_unavailable');return activeOrderAccount(last,pin).data;
 };
 const riskState=decodeNativePerpsRiskState(await pinned(risk,b.riskVaultHash),b);
 if(engineState.ledger.slots.get(0)?.wallet?.toRawString()!==engineWallet||riskState.slots.get(0)?.wallet?.toRawString()!==riskWallet)throw Error('perps_range_wallet_identity_unverified');
 for(const [index,party]of [owner,engine,risk].entries()){
  const wallet=readCurrentT3Wallet(await pinned(selected[index],p.t3WalletHash));if(wallet.owner!==party||wallet.master!==root||wallet.proofCodeHash!==b.proofCodeHash)throw Error('perps_range_wallet_identity_unverified');
 }
 for(const pool of oraclePools)activeOrderAccount(await original(pool),p.poolHash);
 const redemptionBinding={network,hub:root,root,governance:hub.governance,hubCodeHash:p.t3MasterHash,walletCodeHash:p.t3WalletHash,proofCodeHash:b.proofCodeHash,configHash:hub.configHash,reserveRoutes:[]};
 const projection=await projectOwnerLedger({network,owner,opcodes:input.opcodes,chains,wallets,pools:new Map(),stateAt,currentPerpsBinding:b,t3Hubs:new Map([[root,{address:root,root,codeHash:p.t3MasterHash,redemptionBinding,reserveRoots:[],vaults:[]}]])});
 projection.events=projection.events.filter(e=>e.kind==='perps_operation'||e.settlement?.protocol==='perps').sort((a,b)=>BigInt(a.lt)===BigInt(b.lt)?b.hash.localeCompare(a.hash):BigInt(a.lt)>BigInt(b.lt)?-1:1);
 return{projection,oraclePools,protocolPeers,chains:[...chains.values()]};
}
