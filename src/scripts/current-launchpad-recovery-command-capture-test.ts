import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {readLaunchpadOperationRequest,collectLaunchpadOperationEvidence} from '../runtime/launchpadOperationEvidence';
import {canonicalPhysicalMessage} from '../runtime/physicalEvidence';
import {t3Attempt} from '../ledger/currentT3Wire';
import {originalProductCaptureAdapter} from './current-launchpad-native-evidence-test';
async function main(){
 const[input,output]=process.argv.slice(2);assert(isAbsolute(input)&&isAbsolute(output));const cases:unknown[]=[],now=Date.now;
 try{for(const folder of readdirSync(input).sort()){
  if(!folder.endsWith('-delivered'))continue;const dir=join(input,folder),file=readdirSync(dir).find(f=>f.endsWith('-complete.json'))!;assert(file);
  const bytes=readFileSync(join(dir,file)),c=JSON.parse(bytes.toString()),original=JSON.parse(readFileSync(join(dir,'original.json'),'utf8'));
  const a=originalProductCaptureAdapter(c),manifest=c.release;Date.now=()=>a.head.utime*1000;
  const commands=a.checked.filter(r=>r.evidence.account===original.wallet&&(r.checked.tx.inMessage?.body.bits.length??0)>=32&&[0x5433574b,0x54335759].includes(r.checked.tx.inMessage!.body.beginParse().preloadUint(32)));
  assert.equal(commands.length,2);
  for(const command of commands){
   const incoming=command.checked.tx.inMessage!;assert(incoming.info.type==='internal'&&!incoming.info.bounced&&command.checked.succeeded);
   const emitters=a.checked.filter(row=>row.evidence.account===original.request.owner&&row.checked.succeeded&&[...row.checked.outgoing.values()].some(cell=>canonicalPhysicalMessage(cell).equals(canonicalPhysicalMessage(command.checked.incoming!))));assert.equal(emitters.length,1);
   const body=incoming.body,s=body.beginParse(),kind=s.loadUint(32)===0x5433574b?'wallet-mark':'wallet-retry',record=s.loadRef().beginParse();record.loadBit();record.loadBit();const attempt=t3Attempt(record.loadRef());record.endParse();
   const root=manifest.tokens.find((t:any)=>t.symbol==='T3');assert(root);
   const request={...original.request,kind,target:attempt.owner,sourceWallet:command.evidence.account,tokenRoot:root.root,amountRaw:attempt.amount.toString(),minTokensRaw:null,
    assets:[{root:root.root,masterCodeHash:root.masterCodeHash,walletCodeHash:root.walletCodeHash,amountRaw:attempt.amount.toString(),recipient:attempt.recipient}],
    bodyBoc:body.toBoc().toString('base64'),bodyHash:body.hash().toString('hex'),valueNano:incoming.info.value.coins.toString(),createdAt:emitters[0].checked.tx.now*1000,
    dispatch:{lt:emitters[0].checked.tx.lt.toString(),hash:emitters[0].checked.hash,valueNano:incoming.info.value.coins.toString()}};
   const parsed=readLaunchpadOperationRequest(request,manifest),response=await collectLaunchpadOperationEvidence(manifest,a.source,a.store,parsed);
   assert(response.coverage.complete,folder+':'+kind+':'+JSON.stringify(response.coverage));
   assert(response.transactions.some(row=>row.transactionBoc===command.evidence.transactionBoc));
   cases.push({folder,kind,sourceSha256:createHash('sha256').update(bytes).digest('hex'),manifest,request,response});console.log(folder,kind,response.transactions.length,'original transactions');
  }
 }
 assert.equal(cases.length,12);writeFileSync(output,JSON.stringify({schema:'tonswap-launchpad-native-control-command-test-v1',qualification:'Derived exact request metadata for original native owner mark/retry dispatches. Synthetic sandbox head/release adapter; command execution is separate from original financial settlement.',cases},null,2)+'\n',{flag:'wx'});
 }finally{Date.now=now;}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
