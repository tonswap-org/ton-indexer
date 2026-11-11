import { decodeCurrentPerpsOperations } from './currentPerps';
import { currentT3OriginalBoundary } from './currentT3Proof';
import { canonicalLedgerHash } from './normalize';
import { chainCoversTransaction, type Node, type ProjectionInput } from './project';
import type { OrderTransactionEvidence } from '../orders/evidence';
import type { LedgerEvent, LedgerEvidenceRef, LedgerMovement } from './types';
export type CurrentPerpsLedgerOperation={anchor:Node;kind:'perps_operation';queryId:string;confirmed:boolean;evidence:LedgerEvidenceRef[];settlement:NonNullable<LedgerEvent['settlement']>;issue?:string};
const ref=(n:Node):LedgerEvidenceRef=>({account:n.account,lt:n.raw.lt,hash:canonicalLedgerHash(n.raw.hash),utime:n.raw.utime});
export async function projectCurrentPerps(input:ProjectionInput,nodes:Node[],attach:(a:Node,b:Node)=>void):Promise<CurrentPerpsLedgerOperation[]>{
 const binding=input.currentPerpsBinding;if(!binding)return[];
 const evidence:OrderTransactionEvidence[]=[],byHash=new Map(nodes.map(n=>[Buffer.from(canonicalLedgerHash(n.raw.hash),'base64').toString('hex'),n]));
 for(const n of nodes){if(!n.raw.rawBoc||!n.raw.prevTransactionLt||!n.raw.prevTransactionHash)continue;
  try{const before=await input.stateAt(n.account,n.raw.prevTransactionLt,n.raw.prevTransactionHash),after=await input.stateAt(n.account,n.raw.lt,n.raw.hash);if(!before||!after)continue;currentT3OriginalBoundary(n,before,after);evidence.push({account:n.account,transactionBoc:n.raw.rawBoc,beforeShardAccountBoc:before.state.shardAccountBoc!,afterShardAccountBoc:after.state.shardAccountBoc!});}catch{/* An absent original boundary cannot be supplied by a current getter. */}
 }
 const result:CurrentPerpsLedgerOperation[]=[];
 for(const{request,economics}of decodeCurrentPerpsOperations(input.owner,binding,evidence)){
  const anchor=byHash.get(request.dispatch.hash);if(!anchor?.event)continue;
  const hashes=[...new Set(economics.evidenceHashes)],related=hashes.map(h=>byHash.get(h)).filter((n):n is Node=>!!n),covered=related.length===hashes.length&&related.every(n=>chainCoversTransaction(input.chains.get(n.account),n.raw)),refs=related.map(ref);let cashProjected=true;
  for(const n of related)attach(anchor,n);
  for(const leg of economics.cash){const node=byHash.get(leg.ownerTransaction);const purpose:LedgerMovement['purpose']=leg.direction==='out'?'perps_collateral':leg.otherOwner===request.riskVault?'perps_counterparty_profit':'perps_payout';
   const movement=node?.event?.movements.find(m=>m.asset.master===binding.perps.t3Root.toRawString()&&m.direction===leg.direction&&m.amountRaw===leg.amountRaw&&m.evidence.kind==='jetton_internal_transfer');
   if(movement){movement.purpose=purpose;movement.evidence.requestBodyHash=request.bodyHash;}else cashProjected=false;
  }
  // Margin, entry principal and LP backing are overlapping accounting facts;
  // none creates an additional owner cash movement or freely spendable asset.
  const complete=covered&&cashProjected&&economics.outcome!=='unresolved'&&economics.pendingOutRaw==='0';
  result.push({anchor,kind:'perps_operation',queryId:request.queryId,confirmed:complete,evidence:refs,settlement:{status:complete?'confirmed':'incomplete',protocol:'perps',operation:'perps_operation',queryId:request.queryId,evidence:refs,currentPerps:economics},...(!complete?{issue:economics.pendingOutRaw!=='0'?'perps_physical_payout_pending':'perps_current_evidence_incomplete'}:{})});
 }
 return result;
}
