import assert from 'node:assert/strict';
import { originalProductCaptureAdapter } from '../current-launchpad-native-evidence-test';
import { archiveCheckpointTestStore } from './archiveCheckpointTestStore';
/** Actual native originals/current envelopes/getters. Only the sandbox block
 * identity and transport adapter are synthetic; no missing getter is invented. */
export function currentOwedNativeAdapter(c:any,stage:string='after'){
 const snapshot=c.stages[stage],head=snapshot.head;
 const observations=c.readSnapshots.filter((s:any)=>s.response.head.seqno===head.seqno&&s.response.head.utime===head.utime&&s.response.head.rootHashHex===head.rootHashHex);
 assert(observations.length,'Original same-head observations required');
 const calls=observations.flatMap((s:any)=>s.calls.map((call:any)=>call.kind==='getter'?{...call,args:(call.args??[]).map((a:any)=>a.type==='int'?a:{...a,cell:a.cell??a.cellBoc})}:call));
 const results=observations.flatMap((s:any)=>s.response.results.map((r:any)=>r.kind==='account'?{...r,code:r.codeBoc,data:r.dataBoc}:r));
 const originalCurrentAccounts=snapshot.currentAccounts.map((a:any)=>({address:a.address,head,shardAccountBoc:a.originalShardAccountBoc}));
 // The immutable corpus retains every setup transaction. This bounded
 // transport advertises only its exact captured current accounts, so eagerly
 // validate every original lifetime row for those accounts (including all
 // frozen provenance), without replaying unrelated setup accounts. Any causal
 // destination outside this envelope set remains explicitly unavailable.
 const accounts=new Set(originalCurrentAccounts.map((a:any)=>a.address));
 const adapter=originalProductCaptureAdapter({head,calls,results,originalCurrentAccounts,completeTransactions:c.completeTransactions.slice(0,snapshot.transactionCount).filter((row:any)=>accounts.has(row.account))});
 assert.equal(adapter.refusedAccounts.length,0,JSON.stringify(adapter.refusedAccounts));
 return{...adapter,manifest:c.manifest,store:{...adapter.store,...archiveCheckpointTestStore()}};
}
