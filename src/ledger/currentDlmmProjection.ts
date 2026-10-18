import { decodeCurrentDlmmOrders } from './currentDlmmOrderProof';
import { decodeCurrentDlmmOperations, type CurrentDlmmEconomics } from './currentDlmmEconomics';
import type { CurrentDlmmProofBinding } from './currentDlmmPhysical';
import { currentT3OriginalBoundary } from './currentT3Proof';
import { canonicalLedgerHash } from './normalize';
import { chainCoversTransaction, type Node, type ProjectionInput } from './project';
import type { OrderTransactionEvidence } from '../orders/evidence';
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from './types';
export type CurrentDlmmLedgerOperation={anchor:Node;kind:'swap'|'lp_deposit'|'lp_withdraw'|'dlmm_operation';pool:string;queryId:string;confirmed:boolean;evidence:LedgerEvidenceRef[];settlement:NonNullable<LedgerEvent['settlement']>&{currentDlmm:CurrentDlmmEconomics};issue?:string};
const ref=(n:Node):LedgerEvidenceRef=>({account:n.account,lt:n.raw.lt,hash:canonicalLedgerHash(n.raw.hash),utime:n.raw.utime});
/** T3 cash stays with its protected-token projection. Independently proved X
 * wallet legs may replace generic hints; fees and shares are never extra cash. */
export async function projectCurrentDlmm(input:ProjectionInput&{currentDlmmBinding?:CurrentDlmmProofBinding},nodes:Node[],attach:(a:Node,b:Node)=>void):Promise<CurrentDlmmLedgerOperation[]>{
 const binding=input.currentDlmmBinding;if(!binding)return[];
 const evidence:OrderTransactionEvidence[]=[],byHash=new Map(nodes.map(n=>[Buffer.from(canonicalLedgerHash(n.raw.hash),'base64').toString('hex'),n]));
 for(const n of nodes){if(!n.raw.rawBoc||!n.raw.prevTransactionLt||!n.raw.prevTransactionHash)continue;try{const before=await input.stateAt(n.account,n.raw.prevTransactionLt,n.raw.prevTransactionHash),after=await input.stateAt(n.account,n.raw.lt,n.raw.hash);if(!before||!after)continue;currentT3OriginalBoundary(n,before,after);evidence.push({account:n.account,transactionBoc:n.raw.rawBoc,beforeShardAccountBoc:before.state.shardAccountBoc!,afterShardAccountBoc:after.state.shardAccountBoc!});}catch{/* Missing original archive remains unavailable. */}}
 const result:CurrentDlmmLedgerOperation[]=[];
 for(const operation of [...decodeCurrentDlmmOperations(input.owner,binding,evidence),...decodeCurrentDlmmOrders(input.owner,binding,evidence)]){
  const {request,economics}=operation,anchor=byHash.get(request.dispatch.hash);if(!anchor?.event)continue;
  const hashes=[...new Set(economics.evidenceHashes)],related=hashes.map(h=>byHash.get(h)).filter((n):n is Node=>!!n),covered=related.length===hashes.length&&related.every(n=>chainCoversTransaction(input.chains.get(n.account),n.raw)),refs=related.map(ref);let cashProjected=true;
  for(const n of related)attach(anchor,n);
  for(const leg of economics.cash){
   const node=byHash.get(leg.ownerTransaction),debit=byHash.get(leg.debitTransaction),credit=byHash.get(leg.creditTransaction);
   if(!node?.event||!debit||!credit){cashProjected=false;continue;}
   const from=leg.direction==='out'?input.owner:leg.otherOwner,to=leg.direction==='in'?input.owner:leg.otherOwner;
   const hasHash=(m:LedgerMovement,h:string)=>(m.evidence.transactions??[]).some(r=>Buffer.from(canonicalLedgerHash(r.hash),'base64').toString('hex')===h);
   const matching=node.event.movements.filter(m=>m.asset.master===leg.root&&m.direction===leg.direction&&m.amountRaw===leg.amountRaw&&m.source===from&&m.destination===to&&hasHash(m,leg.ownerTransaction)&&(m.evidence.kind==='jetton_internal_transfer'||m.evidence.kind==='jetton_transfer'&&hasHash(m,leg.debitTransaction)&&hasHash(m,leg.creditTransaction)));
   if(matching.length){
    if(matching.length!==1){cashProjected=false;continue;}
    // Upgrade the exact generic pair in place, never append a second payment.
    matching[0].evidence={kind:'jetton_internal_transfer',requestBodyHash:request.bodyHash,transactions:[ref(debit),ref(credit)]};continue;
   }
   if(leg.root===binding.release.contracts.T3Hub!.address){cashProjected=false;continue;}
   // The product proof binds the approved X family, canonical wallets, complete
   // message identity and both original balance changes before reaching here.
   const asset=input.wallets.get(leg.wallet);
   node.event.movements.push({id:`${node.id}:current-dlmm-cash:${leg.direction}:${leg.originTransaction}`,direction:leg.direction,amountRaw:leg.amountRaw,
    asset:{...(asset??{}),kind:'jetton',id:`${input.network}:jetton:${leg.root}`,master:leg.root,wallet:leg.wallet,owner:input.owner},source:from,destination:to,
    evidence:{kind:'jetton_internal_transfer',requestBodyHash:request.bodyHash,transactions:[ref(debit),ref(credit)]}});
  }
  for(const share of economics.shares){const delta=BigInt(share.deltaRaw),direction=delta>0n?'in':'out',id=`${anchor.id}:current-dlmm-position:${request.pool}:${share.binId}:${direction}`;if(!anchor.event.movements.some(m=>m.id===id))anchor.event.movements.push({id,direction,amountRaw:String(delta<0n?-delta:delta),asset:{kind:'lp_position',id:`${input.network}:dlmm-position:${request.pool}:${share.binId}`,pool:request.pool,binId:share.binId,owner:input.owner,decimals:0,symbol:'DLMM shares'},source:direction==='in'?request.pool:input.owner,destination:direction==='in'?input.owner:request.pool,evidence:{kind:'lp_position_delta',requestBodyHash:request.bodyHash,transactions:refs}});}
  const complete=covered&&cashProjected&&economics.outcome!=='unresolved'&&economics.pendingOutT3Raw==='0'&&economics.pendingOutXRaw==='0';const kind=request.kind==='swap'?'swap':request.kind==='add'?'lp_deposit':request.kind==='remove'?'lp_withdraw':'dlmm_operation';
  result.push({anchor,kind,pool:request.pool,queryId:request.queryId,confirmed:complete,evidence:refs,settlement:{status:complete?'confirmed':'incomplete',protocol:'dlmm',operation:kind,pool:request.pool,queryId:request.queryId,evidence:refs,currentDlmm:economics},...(!complete?{issue:economics.pendingOutT3Raw!=='0'||economics.pendingOutXRaw!=='0'?'dlmm_physical_payout_pending':'dlmm_current_evidence_incomplete'}:{})});
 }
 return result;
}
