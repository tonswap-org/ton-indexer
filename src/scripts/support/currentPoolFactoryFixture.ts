import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { Address, Cell, beginCell, storeMessage } from '@ton/core';
import { verifyOrderTransaction, activeOrderAccount, type OrderTransactionEvidence } from '../../orders/evidence';
import { decodeOriginalTransaction } from '../../data/transactionEvidence';
import { assertCurrentCaptureTargets, currentCaptureSha256 as sha, readCurrentCaptureManifest } from '../current-capture-build';

/** Original native messages and state boundaries remain unchanged. Release/head
 * metadata in the producer is a sandbox adapter, not a deployment attestation. */
export function currentPoolFactoryFixture(directory?: string) {
  const root=join(__dirname,'../fixtures/current-pool-factory/v3'),build=join(__dirname,'../fixtures/current-capture-build');
  const snapshot=readCurrentCaptureManifest({nativeRoot:join(build,'source'),artifactRoot:join(build,'artifacts'),manifestPath:join(build,'manifest.json'),
    expectedManifestSha256:'9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5'});
  assertCurrentCaptureTargets(snapshot,['DlmmPoolFactory','DlmmPool']);
  const indexBytes=directory?null:readFileSync(join(root,'index.json'));
  if(indexBytes)assert.equal(sha(indexBytes),'d1dd5870c2bda453cd4a9587d3db6c02d81f78d4cc55036ef789c1464a0aee23');
  const index=indexBytes?JSON.parse(indexBytes.toString()):null;
  if(index){
    assert.equal(index.schema,'tonswap-current-pool-factory-fixtures-v3');assert.equal(index.manifestSha256,snapshot.sha256);
    const receiptBytes=readFileSync(join(root,'producer-provenance.json')),log=readFileSync(join(root,'producer-log.txt'));
    assert.equal(sha(receiptBytes),index.producerReceiptSha256);assert.equal(sha(log),index.logSha256);
    const receipt=JSON.parse(receiptBytes.toString());assert.equal(receipt.result.logSha256,index.logSha256);assert.equal(receipt.result.selectedTestsPassed,2);
    assert.match(log.toString(),/Test Files\s+1 passed \(1\)/);assert.match(log.toString(),/Tests\s+2 passed \| 12 skipped \(14\)/);
    for(const role of ['DlmmPoolFactory','DlmmPool']){
      const entry=Object.entries(receipt.buildBocs).filter(([file])=>file.endsWith(`/build/${role}.boc`));assert.equal(entry.length,1);
      assert.equal(entry[0][1],sha(readFileSync(join(build,'artifacts',role+'.boc'))));
    }
    for(const f of index.files)assert.equal(receipt.captures[f.originalFile],f.originalSha256);
  }
  const originals=['default','x6'].map(scope=>{
    const file=`public-outside-add-1-${scope}.json`;
    if(directory)return {scope,bytes:readFileSync(join(directory,file))};
    const entry=index.files.find((row:any)=>row.originalFile===file);assert(entry);
    const compressed=readFileSync(join(root,entry.file));assert.equal(sha(compressed),entry.sha256);
    const bytes=brotliDecompressSync(compressed);assert.equal(sha(bytes),entry.originalSha256);assert.equal(bytes.length,entry.originalBytes);return {scope,bytes};
  });
  const cases=[];
  for(const {scope,bytes} of originals){
    const c=JSON.parse(bytes.toString()),identity=c.binding.identity,release=identity.release,factory=release.contracts.DlmmPoolFactory.address;
    assert.equal(release.contracts.DlmmPoolFactory.codeHash,snapshot.manifest.targets.DlmmPoolFactory.codeHash);
    assert.equal(release.templates.DlmmPool,snapshot.manifest.targets.DlmmPool.codeHash);
    const rows=(c.completeTransactions as OrderTransactionEvidence[]).map(e=>({evidence:e,checked:verifyOrderTransaction(e)}));
    const accepted=rows.filter(row=>row.evidence.account===factory&&row.checked.succeeded&&row.checked.tx.inMessage?.body.bits.length!>=32
      &&row.checked.tx.inMessage!.body.beginParse().preloadUint(32)===0x50524459);
    assert.equal(accepted.length,2);
    for(const row of accepted){
      const incoming=row.checked.tx.inMessage!;assert(incoming.info.type==='internal'&&!incoming.info.bounced);const pool=incoming.info.src.toRawString();
      for(const shard of [row.checked.before,row.checked.after])activeOrderAccount(shard,snapshot.manifest.targets.DlmmPoolFactory.codeHash);
      const normalized=(m:typeof incoming)=>beginCell().store(storeMessage(m,{forceRef:true})).endCell();
      const emitters=rows.filter(r=>r.evidence.account===pool&&r.checked.succeeded&&[...r.checked.tx.outMessages.values()].some(m=>normalized(m).equals(normalized(incoming))));
      assert.equal(emitters.length,1);const emitter=emitters[0];activeOrderAccount(emitter.checked.after,snapshot.manifest.targets.DlmmPool.codeHash);
      const attempt=rows.find(r=>r.evidence.account===factory&&r.checked.tx.lt<row.checked.tx.lt&&[...r.checked.tx.outMessages.values()].some(m=>m.info.type==='internal'&&m.info.dest.toRawString()===pool&&m.init));assert(attempt);
      const raw=decodeOriginalTransaction(Cell.fromBase64(row.evidence.transactionBoc),Address.parse(factory));
      cases.push({capture:{name:`${scope}-${pool===identity.pool?'public-project':'listed'}`,factory,pool,
        accepted:row.evidence,emitter:emitter.evidence,attempt:attempt.evidence},raw,parsed:row.checked.tx,
        attempt:decodeOriginalTransaction(Cell.fromBase64(attempt.evidence.transactionBoc),Address.parse(factory)),sourceSha256:sha(bytes)});
    }
  }
  assert.equal(cases.length,4);return {cases,snapshot};
}
