import assert from 'node:assert/strict';
import { activeOrderAccount } from '../orders/evidence';
import { verifyCurrentLaunchpadLiquidity } from '../ledger/currentLaunchpadLiquidity';
import { currentLaunchpadBindingFromManifest, verifyLaunchpadTransaction, launchpadChild, raw, maybe, type LaunchpadToken } from '../ledger/currentLaunchpadProof';
import { currentLaunchpadCaptures } from './support/currentLaunchpadCaptures';
let checks=0;
for(const {file,capture:original,requests,refund} of currentLaunchpadCaptures()){
 if(refund)continue;
 const txs=original.completeTransactions.map(verifyLaunchpadTransaction);
 for(const request of requests.filter((r:any)=>['lp-seed','lp-release'].includes(r.kind))){
 const row={file:`${file}:${request.kind}`,request,manifest:original.release};
 const manifest=structuredClone(row.manifest);
 const binding=currentLaunchpadBindingFromManifest(manifest);
 const executed=txs.find((t:any)=>t.account===row.request.target&&t.tx.inMessage?.body.hash().toString('hex')===row.request.bodyHash);
 assert(executed,row.file); const child=launchpadChild(executed,binding);
 const tokens=new Map<string,LaunchpadToken>();
 for(const slot of child.slots.values()){
  const root=raw(slot.master)!;
  if(root===row.manifest.contracts.T3Hub.address)tokens.set(root,{root,family:'t3',walletCodeHash:row.manifest.templates.T3Wallet});
  else {const pairs=[['jetton-v21',row.manifest.templates.JettonV21Minter,row.manifest.templates.JettonV21Wallet],['stablecoin',row.manifest.vendor.stablecoin.minter.codeHash,row.manifest.vendor.stablecoin.wallet.codeHash]] as const;
   const pins=pairs.filter(([,master])=>txs.some((t:any)=>t.account===root&&t.tx.lt<=executed.tx.lt&&maybe(()=>{activeOrderAccount(t.after,master);return true;})));
   assert.equal(pins.length,1);tokens.set(root,{root,family:pins[0][0],walletCodeHash:pins[0][2]});
  }
 }
 const result=verifyCurrentLaunchpadLiquidity(executed,binding,txs,tokens);
 assert.equal(result.status,'confirmed',row.file);assert(result.shares.length>0);assert.equal(result.cash.length,2);
 const noFactory=txs.filter((t:ReturnType<typeof verifyLaunchpadTransaction>)=>t.account!==manifest.contracts.DlmmPoolFactory.address);
 assert.equal(verifyCurrentLaunchpadLiquidity(executed,binding,noFactory,tokens).status,'unavailable','Original factory deployment is required');
 const missingCredit=txs.filter((t:ReturnType<typeof verifyLaunchpadTransaction>)=>t.hash!==result.cash[0].creditTransaction);
 assert.notEqual(verifyCurrentLaunchpadLiquidity(executed,binding,missingCredit,tokens).status,'confirmed','A share event cannot replace physical wallet credit');
 const wrong=structuredClone(manifest);wrong.templates.DlmmPool='00'.repeat(32);
 assert.equal(verifyCurrentLaunchpadLiquidity(executed,currentLaunchpadBindingFromManifest(wrong),txs,tokens).status,'unavailable','Exact current pool code is required');
 console.log(row.file,result.status,{shares:result.shares.length,cash:result.cash.length,negativeChecks:3});checks++;
}
}
assert.equal(checks,12,'All original default/x6 LP seed and release cases must run');
console.log(`Current Launchpad liquidity ${checks} original native cases passed.`);
