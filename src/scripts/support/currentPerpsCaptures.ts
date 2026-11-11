import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readCurrentCaptureManifest, assertCurrentCaptureTargets, currentCaptureSha256 as sha } from '../current-capture-build';
/** Original captures are decoded one at a time; retaining every parsed Cell
 * graph across all scenarios needlessly exhausts the ordinary Node heap. */
export function* currentPerpsCaptures(directory?:string):Generator<{file:string;capture:any}>{
 if(directory){for(const file of readdirSync(directory).filter(f=>f.endsWith('.json')).sort()){if(process.env.PERPS_CASE&&file!==process.env.PERPS_CASE)continue;yield{file,capture:JSON.parse(readFileSync(join(directory,file),'utf8'))};}return;}
 const root=join(__dirname,'../fixtures/current-perps-native'),build=join(__dirname,'../fixtures/current-capture-build'),bytes=readFileSync(join(root,'index.json')),index=JSON.parse(bytes.toString());
 assert.equal(sha(bytes),'067ea721df6559501bd3200873eca87d681adf1177c3477456056e33c015a277');assert.equal(index.schema,'tonswap-current-perps-fixtures-v1');
 const snapshot=readCurrentCaptureManifest({nativeRoot:join(build,'source'),artifactRoot:join(build,'artifacts'),manifestPath:join(build,'manifest.json'),expectedManifestSha256:'9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5'});assertCurrentCaptureTargets(snapshot,Object.keys(snapshot.manifest.targets));assert.equal(index.manifestSha256,snapshot.sha256);
 const receiptBytes=readFileSync(join(root,'producer-receipt.json')),receipt=JSON.parse(receiptBytes.toString()),log=readFileSync(join(root,'producer.log')),inventory=readFileSync(join(root,'source-inventory.json'));
 assert.equal(sha(receiptBytes),index.producerReceiptSha256);assert.equal(sha(log),index.logSha256);assert.equal(sha(inventory),index.sourceInventorySha256);assert.equal(receipt.artifacts['source-inventory.json'],sha(inventory));assert.equal(receipt.manifestSha256,snapshot.sha256);assert.equal(receipt.exitCode,0);assert.equal(receipt.completed,true);assert.equal(receipt.sourcePrePostEqual,true);assert.equal(receipt.tests,18);assert.equal(receipt.captureCount,66);assert.equal(index.files.length,66);assert.match(log.toString(),/^ Test Files\s+1 passed \(1\)$/m);assert.match(log.toString(),/^\s+Tests\s+18 passed \(18\)$/m);assert.doesNotMatch(log.toString(),/\b(?:failed|skipped)\b/i);
 const packed=readFileSync(join(root,index.pooledFile));assert.equal(sha(packed),index.pooledSha256);const pooled=JSON.parse(gunzipSync(packed).toString());assert.equal(pooled.schema,'tonswap-current-perps-originals-pooled-v1');assert.equal(pooled.cases.length,66);
 const expand=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(expand):Object.keys(v).length===1&&'originalString'in v?pooled.strings[v.originalString]:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,expand(v)])):v;
 for(const entry of pooled.cases){const f=index.files.find((f:any)=>f.originalFile===entry.file);assert(f);const c=expand(entry.capture),raw=Buffer.from(JSON.stringify(c));assert.equal(raw.length,f.originalBytes);assert.equal(sha(raw),f.originalSha256);assert.equal(receipt.artifacts['captures/'+f.originalFile],f.originalSha256);if(process.env.PERPS_CASE&&f.originalFile!==process.env.PERPS_CASE)continue;
  for(const [key,role]of Object.entries({engineHash:'PerpsEngine',t3MasterHash:'T3Hub',t3WalletHash:'T3Wallet',poolHash:'DlmmPool'}))assert.equal(c.binding[key],snapshot.manifest.targets[role].codeHash);
  yield{file:f.originalFile,capture:c};
 }
}
