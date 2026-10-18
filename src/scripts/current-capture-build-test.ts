import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginCell } from '@ton/core';
import { assertCurrentCaptureBinding, assertCurrentCaptureCode, assertCurrentCaptureTargets, assertCurrentCaptureProducer, currentCaptureSha256 as sha,
  CURRENT_CAPTURE_COMPILER, readCurrentCaptureManifest, type CurrentCaptureManifest, type CurrentCaptureBinding } from './current-capture-build';

// Synthetic adversarial metadata exercises the verifier. It never qualifies a
// native execution, business decoder or deployment. Real capture runs are separate.
const root=realpathSync(mkdtempSync(join(tmpdir(),'tonswap-current-capture-verifier-'))), build=join(root,'artifacts');
const native=join(root,'native');
const write=(path:string,bytes:Buffer|string)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,bytes);};
const file=(path:string,bytes:Buffer|string)=>write(join(native,path),bytes);
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const sorted=(o:Record<string,string>)=>Object.fromEntries(Object.entries(o).sort(([a],[b])=>a.localeCompare(b)));
const module=(fn:string,boc:Buffer)=>`fun ${fn}(): cell asm "B{${boc.toString('hex')}} B>boc PUSHREF";\n`;
const code={Engine:beginCell().storeUint(1,8).endCell(),JettonV21Wallet:beginCell().storeUint(2,8).endCell(),JettonV21Minter:beginCell().storeUint(3,8).endCell()};
const bocs=Object.fromEntries(Object.entries(code).map(([role,c])=>[role,c.toBoc({idx:false,crc32:false})]));
const walletSource='tolk 1.5.0\nimport "@stdlib/gas-payments";\n', minterSource='tolk 1.5.0\nimport "../../generated/JettonWallet.code.tolk";\n';
const engineSource='tolk 1.5.0\nimport "./helper";\nimport "@gen/op/t3";\nimport "@gen/op/restricted_receipt";\nimport "@gen/JettonMinter.code";\n';
const helper='tolk 1.5.0\n// import "./unused.tolk";\nconst x=1;\n';
const include=(lines:string[])=>['tolk 1.5.0','','// Auto-generated. Do not edit manually.',...lines,''].join('\n')+'\n';
const opcodes={schema:'tonswap-opcodes-v2',reserved:[],constants:{},ops:{one:{tag:'0x01020304',group:'t3'},receipt:{tag:'0x01020305',allow:['contracts/engine.tolk']}},held:{},legacy:{}};
const sourceMap={
  'contracts/engine.tolk':engineSource,'contracts/helper.tolk':helper,
  'contracts/vendor/jetton-v2.1/JettonWallet.tolk':walletSource,'contracts/vendor/jetton-v2.1/JettonMinter.tolk':minterSource,
  'contracts/generated/op/t3.tolk':include(['const OP_ONE: int = 0x01020304;']),
  'contracts/generated/op/restricted_receipt.tolk':include(['const OP_RECEIPT: int = 0x01020305;']),
  'contracts/generated/JettonWallet.code.tolk':module('jettonWalletCompiledCode',bocs.JettonV21Wallet),
  'contracts/generated/JettonMinter.code.tolk':module('jettonMinterCompiledCode',bocs.JettonV21Minter),
};
const input=(paths:(keyof typeof sourceMap)[])=>sorted(Object.fromEntries(paths.map(p=>[p,sha(sourceMap[p])])));
const manifest:CurrentCaptureManifest={schema:'tonswap-build-v1',tolkVersion:'1.5.0',tolkSource:CURRENT_CAPTURE_COMPILER.source,buildHash:'',targets:{
  Engine:{source:'contracts/engine.tolk',codeHash:code.Engine.hash().toString('hex'),bocBytes:bocs.Engine.length,cells:1,bits:8,inputs:input(['contracts/engine.tolk','contracts/helper.tolk','contracts/generated/op/t3.tolk','contracts/generated/op/restricted_receipt.tolk','contracts/generated/JettonMinter.code.tolk'])},
  JettonV21Wallet:{source:'contracts/vendor/jetton-v2.1/JettonWallet.tolk',codeHash:code.JettonV21Wallet.hash().toString('hex'),bocBytes:bocs.JettonV21Wallet.length,cells:1,bits:8,inputs:input(['contracts/vendor/jetton-v2.1/JettonWallet.tolk'])},
  JettonV21Minter:{source:'contracts/vendor/jetton-v2.1/JettonMinter.tolk',codeHash:code.JettonV21Minter.hash().toString('hex'),bocBytes:bocs.JettonV21Minter.length,cells:1,bits:8,inputs:input(['contracts/vendor/jetton-v2.1/JettonMinter.tolk','contracts/generated/JettonWallet.code.tolk'])},
},vendor:{}};
manifest.buildHash=sha(Object.entries(manifest.targets).map(([role,t])=>`${role}:${t.codeHash}`).sort().join('\n'));
const provenance={schema:'tonswap-vendored-source-v1',files:{'JettonWallet.tolk':sha(walletSource),'JettonMinter.tolk':sha(minterSource)},compiler:CURRENT_CAPTURE_COMPILER,targets:{
  JettonV21Wallet:{source:'JettonWallet.tolk',codeHash:manifest.targets.JettonV21Wallet.codeHash,module:'contracts/generated/JettonWallet.code.tolk',function:'jettonWalletCompiledCode'},
  JettonV21Minter:{source:'JettonMinter.tolk',codeHash:manifest.targets.JettonV21Minter.codeHash,module:'contracts/generated/JettonMinter.code.tolk',function:'jettonMinterCompiledCode'},
}};
let checks=0;
try {
  for(const [path,source] of Object.entries(sourceMap))if(!path.startsWith('contracts/generated/'))file(path,source);
  file('contracts/targets.ts',"export const DEPLOY_TARGETS = { Engine:'contracts/engine.tolk', JettonV21Wallet:'contracts/vendor/jetton-v2.1/JettonWallet.tolk', JettonV21Minter:'contracts/vendor/jetton-v2.1/JettonMinter.tolk' } as const; export const TEST_TARGETS={} as const;");
  file('config/opcodes.json',JSON.stringify(opcodes));file('contracts/vendor/jetton-v2.1/PROVENANCE.json',JSON.stringify(provenance));
  for(const [role,bytes] of Object.entries(bocs))write(join(build,`${role}.boc`),bytes);
  const snapshot=(m=manifest)=>{const bytes=JSON.stringify(m,null,2)+'\n';write(join(root,'manifest.json'),bytes);return readCurrentCaptureManifest({nativeRoot:native,manifestPath:join(root,'manifest.json'),artifactRoot:build,expectedManifestSha256:sha(bytes)});};
  const valid=snapshot();assert.deepEqual(Object.keys(assertCurrentCaptureTargets(valid,['Engine'])),['Engine']);checks++;
  const binding:CurrentCaptureBinding={schema:'tonswap-capture-build-v1',producer:'fixture',suite:'tests/Fixture.spec.ts',tolkVersion:'1.5.0',sandboxVersion:'0.42.0',manifestSha256:valid.sha256,buildHash:manifest.buildHash,
    targets:{Engine:{source:manifest.targets.Engine.source,codeHash:manifest.targets.Engine.codeHash,artifact:'build/Engine.boc',artifactSha256:sha(bocs.Engine),inputs:manifest.targets.Engine.inputs,inputsSha256:sha(JSON.stringify(manifest.targets.Engine.inputs))}},
    captures:{'case-01.json':{executed:['Engine'],embedded:[],unbuiltCode:[]}}};
  const verify=(b:any=clone(binding),s=valid)=>assertCurrentCaptureBinding(b,s,{producer:'fixture',suite:'tests/Fixture.spec.ts',bindingSha256:sha(JSON.stringify(b,null,2)+'\n')});
  const authorized=verify();assertCurrentCaptureCode('Engine',code.Engine,authorized);checks++;
  const reject=(fn:()=>unknown,pattern:RegExp)=>{assert.throws(fn,pattern);checks++;};
  reject(()=>assertCurrentCaptureCode('Engine',code.Engine,clone(binding)),/authenticated/);
  reject(()=>assertCurrentCaptureCode('Engine',code.JettonV21Wallet,authorized),/executable code/);
  authorized.targets.Engine.inputsSha256='0'.repeat(64);reject(()=>assertCurrentCaptureCode('Engine',code.Engine,authorized),/authenticated/);
  reject(()=>readCurrentCaptureManifest({nativeRoot:native,manifestPath:join(root,'manifest.json'),artifactRoot:build,expectedManifestSha256:'0'.repeat(64)}),/retained digest/);
  const badBinding=(change:(b:any)=>void,pattern:RegExp)=>{const b=clone(binding);change(b);reject(()=>verify(b),pattern);};
  badBinding(b=>b.manifestSha256='0'.repeat(64),/original producer manifest/);badBinding(b=>b.tolkVersion='1.4.2',/toolchain/);
  badBinding(b=>b.suite='tests/Other.spec.ts',/toolchain/);badBinding(b=>b.targets.Engine.artifactSha256='0'.repeat(64),/artifact bytes/);
  badBinding(b=>b.targets.Engine.inputsSha256='0'.repeat(64),/input digest/);badBinding(b=>b.captures['case-01.json'].executed=[],/Empty capture/);
  badBinding(b=>b.captures['case-01.json'].unbuiltCode=['0'.repeat(64)],/Unknown unbuilt/);
  badBinding(b=>b.captures['../escape.json']=b.captures['case-01.json'],/Invalid capture path/);
  badBinding(b=>b.captures['case-01.json'].executed.push('Engine'),/sorted and unique/);
  for(const mode of ['omit','change'] as const) {const m=clone(manifest);if(mode==='omit')delete m.targets.Engine.inputs['contracts/helper.tolk'];else m.targets.Engine.inputs['contracts/helper.tolk']='0'.repeat(64);reject(()=>assertCurrentCaptureTargets(snapshot(m),['Engine']),/source closure/);}
  const badVersion=clone(manifest);(badVersion as any).tolkVersion='1.4.2';reject(()=>snapshot(badVersion),/compiler\/build identity/);
  const missing=clone(manifest);delete missing.targets.JettonV21Wallet;reject(()=>assertCurrentCaptureTargets(snapshot(missing),['Engine']),/missing a deploy target/);
  file('contracts/helper.tolk',helper+'\n');reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/source closure/);file('contracts/helper.tolk',helper);
  const changed=clone(opcodes);changed.ops.one.tag='0x01020306';file('config/opcodes.json',JSON.stringify(changed));reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/source closure/);file('config/opcodes.json',JSON.stringify(opcodes));
  file('contracts/generated/op/t3.tolk','malicious stale generated bytes');assertCurrentCaptureTargets(valid,['Engine']);checks++;
  write(join(build,'JettonV21Wallet.boc'),bocs.Engine);reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/artifact code hash/);write(join(build,'JettonV21Wallet.boc'),bocs.JettonV21Wallet);
  const alternate=code.JettonV21Wallet.toBoc({idx:true,crc32:true}),alternateManifest=clone(manifest);alternateManifest.targets.JettonV21Wallet.bocBytes=alternate.length;write(join(build,'JettonV21Wallet.boc'),alternate);
  reject(()=>assertCurrentCaptureTargets(snapshot(alternateManifest),['Engine']),/source closure/);write(join(build,'JettonV21Wallet.boc'),bocs.JettonV21Wallet);
  file('contracts/vendor/jetton-v2.1/JettonWallet.tolk',walletSource+'\n');reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/Vendored source bytes/);file('contracts/vendor/jetton-v2.1/JettonWallet.tolk',walletSource);
  const saved=join(root,'helper.saved'),helperPath=join(native,'contracts/helper.tolk');renameSync(helperPath,saved);symlinkSync(saved,helperPath);reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/physical/);unlinkSync(helperPath);renameSync(saved,helperPath);
  file('config/opcodes.json',JSON.stringify(opcodes).replace('"ops":','"ops":{},"ops":'));reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/duplicate JSON key/);file('config/opcodes.json',JSON.stringify(opcodes));
  file('contracts/engine.tolk',engineSource+'import "@other/unsafe";\n');reject(()=>assertCurrentCaptureTargets(valid,['Engine']),/Invalid current import/);file('contracts/engine.tolk',engineSource);
  assertCurrentCaptureTargets(valid,['Engine']);checks++;
  const capture=join(root,'capture'),bindingBytes=JSON.stringify(binding,null,2)+'\n',compiledBytes=JSON.stringify({hash:manifest.targets.Engine.codeHash,hex:bocs.Engine.toString('hex')})+'\n';
  const log=Buffer.from('PASS default tests/Fixture.spec.ts\nTest Suites: 1 passed, 1 total\nTests: 1 passed, 1 total\nTime: 1.25 s\n');
  const artifacts={'build-binding.json':bindingBytes,'current-compiled/Engine.json':compiledBytes,'compiler/Engine.boc':bocs.Engine,'case-01.json':'{"original":"fixture"}\n'};
  for(const [name,bytes]of Object.entries(artifacts))write(join(capture,name),bytes);
  const receipt={schema:'tonswap-capture-producer-v1',producer:'fixture',suite:'tests/Fixture.spec.ts',tests:1,captureDirectory:'/retained/original/producer',exitCode:0,
    runtime:{node:'v22.23.3',tolk:'1.5.0',sandbox:'0.42.0'},logSha256:sha(log),
    build:{file:'build-binding.json',sha256:sha(bindingBytes),manifestSha256:valid.sha256,buildHash:manifest.buildHash},
    compiled:{Engine:{file:'current-compiled/Engine.json',sha256:sha(compiledBytes),codeHash:manifest.targets.Engine.codeHash,boc:'compiler/Engine.boc',bocSha256:sha(bocs.Engine)}},
    artifacts:Object.fromEntries(Object.entries(artifacts).map(([file,bytes])=>[file,sha(bytes)]))};
  const producer=(r:any=clone(receipt),output=log)=>{const bytes=JSON.stringify(r,null,2)+'\n';write(join(capture,'producer-receipt.json'),bytes);return assertCurrentCaptureProducer(valid,{directory:capture,log:output,producer:'fixture',suite:'tests/Fixture.spec.ts',tests:1,receiptSha256:sha(bytes),bindingSha256:sha(bindingBytes)});};
  assert.equal(producer().receipt.captureDirectory,receipt.captureDirectory);checks++;
  const badReceipt=(change:(r:any)=>void,pattern:RegExp)=>{const r=clone(receipt);change(r);reject(()=>producer(r),pattern);};
  badReceipt(r=>r.exitCode=1,/completion/);badReceipt(r=>r.tests=2,/completion/);
  badReceipt(r=>r.runtime.tolk='1.4.2',/runtime/);badReceipt(r=>r.build.manifestSha256='0'.repeat(64),/build binding/);
  badReceipt(r=>delete r.artifacts['case-01.json'],/capture is absent/);badReceipt(r=>delete r.compiled.Engine,/compiled target coverage/);
  badReceipt(r=>r.compiled.Engine.bocSha256='0'.repeat(64),/compiled receipt identity/);
  for(const malformed of [log.toString().replace('1 passed, 1 total','1 failed, 1 total'),log.toString().replace('Tests: 1 passed, 1 total\n',''),log.toString()+'Tests: 1 passed, 1 total\n',log.toString().replace('Time: 1.25 s','Time: incomplete')]) {
    const output=Buffer.from(malformed),r=clone(receipt);r.logSha256=sha(output);reject(()=>producer(r,output),/fully pass|terminal result/);
  }
  write(join(capture,'case-01.json'),'changed original bytes');reject(()=>producer(),/artifact differs/);write(join(capture,'case-01.json'),artifacts['case-01.json']);
  reject(()=>producer(receipt,Buffer.from('other log')),/log differs/);
  assert.equal(producer().binding.producer,'fixture');checks++;
  console.log(`Current 1.5 capture verifier: ${checks} virtual opcode/vendor closure, original manifest, artifact and adversarial checks passed; synthetic verifier test only`);
} finally {rmSync(root,{recursive:true,force:true});}
