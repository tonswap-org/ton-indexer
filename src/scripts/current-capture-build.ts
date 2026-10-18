import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { Cell } from '@ton/core';
import ts from 'typescript';
import { CAPTURE_SANDBOX_TREASURY_HASH, type CaptureBuiltTarget, type CaptureBoundTarget } from './capture-build';

/** Explicit 1.5 producer qualification. The retained 1.4.2 verifier stays unchanged.
 * Neither a manifest nor this verification enables a runtime business decoder. */
export const CURRENT_CAPTURE_COMPILER = {
  version: '1.5.0', source: 'https://codeload.github.com/ton-blockchain/tolk-js/tar.gz/50d69ab6678de0607db03a7e0e8e3e1c62e07dce',
} as const;
export const currentCaptureSha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const relative = (v: unknown): v is string => typeof v === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(v) && v.split('/').every(s => s !== '.' && s !== '..');
const sourcePath = (v: unknown): v is string => relative(v) && v.startsWith('contracts/') && v.endsWith('.tolk');
const roleName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(v);
function exact(v: unknown, keys: string[], at: string): asserts v is Record<string, any> {
  assert(object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), `${at}: invalid fields`);
}
function json(bytes: Buffer, at: string): any {
  // JSON.parse otherwise hides duplicate fields in manifests and source registries.
  const ast = ts.parseJsonText(at, bytes.toString('utf8'));
  const walk = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set<string>();
      for (const p of node.properties) {
        assert(ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.name) || ts.isIdentifier(p.name)), `${at}: invalid JSON property`);
        assert(!names.has(p.name.text), `${at}: duplicate JSON key ${p.name.text}`); names.add(p.name.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(ast); return JSON.parse(bytes.toString('utf8'));
}
function physical(root: string, file: string): Buffer {
  assert(realpathSync(root) === root && lstatSync(root).isDirectory(), 'Current capture root must be a canonical physical directory');
  assert(relative(file), `Current capture: invalid path ${file}`);
  let path = root;
  for (const part of file.split('/')) { path = join(path, part); assert(!lstatSync(path).isSymbolicLink(), `Current capture source must be physical: ${file}`); }
  assert(lstatSync(path).isFile() && realpathSync(path) === path, `Current capture file must be physical: ${file}`);
  return readFileSync(path);
}
function inputs(value: unknown, at: string): asserts value is Record<string, string> {
  assert(object(value) && Object.keys(value).length > 0, `${at}: missing compiler inputs`);
  assert.deepEqual(Object.keys(value), Object.keys(value).sort((a,b) => a.localeCompare(b)), `${at}: inputs must be sorted`);
  for (const [file, hash] of Object.entries(value)) assert(sourcePath(file) && digest(hash), `${at}: invalid input ${file}`);
}
export type CurrentCaptureManifest = {
  schema: 'tonswap-build-v1'; tolkVersion: '1.5.0'; tolkSource: string; buildHash: string;
  targets: Record<string, CaptureBuiltTarget>; vendor: Record<string, { sha256: string; cellHash: string; bocBytes: number }>;
};
export type CurrentCaptureSnapshot = {
  manifest: CurrentCaptureManifest; bytes: Buffer; sha256: string; registryBytes: Buffer;
  nativeRoot: string; artifactRoot: string;
};
export type CurrentCaptureBinding = {
  schema: 'tonswap-capture-build-v1'; producer: string; suite: string; tolkVersion: '1.5.0'; sandboxVersion: '0.42.0';
  manifestSha256: string; buildHash: string; targets: Record<string, CaptureBoundTarget>;
  captures: Record<string, { executed: string[]; embedded: string[]; unbuiltCode: string[] }>;
};
function parseManifest(value: unknown): CurrentCaptureManifest {
  exact(value, ['schema','tolkVersion','tolkSource','buildHash','targets','vendor'], 'Current capture manifest');
  assert(value.schema === 'tonswap-build-v1' && value.tolkVersion === CURRENT_CAPTURE_COMPILER.version && value.tolkSource === CURRENT_CAPTURE_COMPILER.source && digest(value.buildHash), 'Current capture compiler/build identity differs');
  assert(object(value.targets) && Object.keys(value.targets).length > 0 && object(value.vendor), 'Current capture targets/vendor are absent');
  for (const [role, target] of Object.entries(value.targets)) {
    exact(target, ['source','codeHash','bocBytes','cells','bits','inputs'], role);
    assert(roleName(role) && sourcePath(target.source) && digest(target.codeHash), `${role}: invalid source/code identity`);
    assert(['bocBytes','cells','bits'].every(k => Number.isSafeInteger(target[k]) && target[k] >= (k === 'bits' ? 0 : 1)), `${role}: invalid dimensions`);
    inputs(target.inputs, role); assert(Object.hasOwn(target.inputs, target.source), `${role}: source is not in compiler inputs`);
  }
  for (const [file, v] of Object.entries(value.vendor)) {
    exact(v, ['sha256','cellHash','bocBytes'], file);
    assert(relative(file) && file.endsWith('.boc') && digest(v.sha256) && digest(v.cellHash) && Number.isSafeInteger(v.bocBytes) && v.bocBytes > 0, 'Invalid vendored cell');
  }
  return value as CurrentCaptureManifest;
}
function targetRegistry(bytes: Buffer) {
  const source = ts.createSourceFile('targets.ts', bytes.toString('utf8'), ts.ScriptTarget.Latest, true), maps: Record<string, Record<string,string>> = {};
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
    if (!ts.isIdentifier(d.name) || !['DEPLOY_TARGETS','TEST_TARGETS'].includes(d.name.text)) continue;
    const init = d.initializer && ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer;
    assert(init && ts.isObjectLiteralExpression(init) && !maps[d.name.text], 'Current target registry requires unique literal maps');
    const entries: Record<string,string> = {};
    for (const p of init.properties) {
      assert(ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ts.isStringLiteral(p.initializer), 'Current target registry requires literal paths');
      assert(roleName(p.name.text) && sourcePath(p.initializer.text) && !Object.hasOwn(entries,p.name.text), 'Current target registry has invalid/duplicate target');
      entries[p.name.text] = p.initializer.text;
    }
    maps[d.name.text] = entries;
  }
  assert(maps.DEPLOY_TARGETS && maps.TEST_TARGETS && Object.keys(maps.DEPLOY_TARGETS).length, 'Current target registry is incomplete');
  assert(!Object.keys(maps.TEST_TARGETS).some(k => Object.hasOwn(maps.DEPLOY_TARGETS,k)), 'Current target registry duplicates a target');
  return { targets: {...maps.DEPLOY_TARGETS,...maps.TEST_TARGETS}, deploy: Object.keys(maps.DEPLOY_TARGETS) };
}
export function readCurrentCaptureManifest(options: { nativeRoot: string; manifestPath: string; artifactRoot: string; expectedManifestSha256: string; registryPath?: string }): CurrentCaptureSnapshot {
  const nativeRoot = resolve(options.nativeRoot), file = resolve(options.manifestPath), registry = options.registryPath ? resolve(options.registryPath) : join(nativeRoot,'contracts/targets.ts');
  const bytes = physical(dirname(file),posix.basename(file));
  assert(digest(options.expectedManifestSha256) && currentCaptureSha256(bytes) === options.expectedManifestSha256, 'Current capture manifest differs from the independently retained digest');
  return { manifest:parseManifest(json(bytes,file)),bytes,sha256:options.expectedManifestSha256,registryBytes:physical(dirname(registry),posix.basename(registry)),nativeRoot,artifactRoot:resolve(options.artifactRoot) };
}
function manifestIdentity(snapshot: CurrentCaptureSnapshot) {
  assert.equal(currentCaptureSha256(snapshot.bytes), snapshot.sha256, 'Retained current manifest bytes changed');
  assert.deepEqual(snapshot.manifest, parseManifest(json(snapshot.bytes,'manifest.json')), 'Current manifest object differs from retained bytes');
  const registry = targetRegistry(snapshot.registryBytes), m = snapshot.manifest;
  assert(registry.deploy.every(k => Object.hasOwn(m.targets,k)), 'Current manifest is missing a deploy target');
  for (const [role,t] of Object.entries(m.targets)) assert(registry.targets[role] === t.source, `${role}: unregistered source`);
  assert.equal(m.buildHash,currentCaptureSha256(registry.deploy.map(k => `${k}:${m.targets[k].codeHash}`).sort().join('\n')), 'Current manifest buildHash differs');
}
function artifact(snapshot: CurrentCaptureSnapshot, role: string) {
  const t = snapshot.manifest.targets[role]; assert(t, `${role}: missing compiled target`);
  const bytes = physical(snapshot.artifactRoot,`${role}.boc`), roots = Cell.fromBoc(bytes);
  assert.equal(bytes.length,t.bocBytes,`${role}: artifact size differs`); assert(roots.length === 1 && !roots[0].isExotic, `${role}: expected one ordinary compiled root`);
  assert.equal(roots[0].hash().toString('hex'),t.codeHash,`${role}: artifact code hash differs`);
  const seen = new Set<string>(); let bits = 0;
  const visit = (c: Cell) => { const h=c.hash().toString('hex'); if(seen.has(h))return; seen.add(h);bits+=c.bits.length;c.refs.forEach(visit); };visit(roots[0]);
  assert.equal(seen.size,t.cells,`${role}: artifact cell count differs`);assert.equal(bits,t.bits,`${role}: artifact bits differ`);return bytes;
}
function opcodeSources(root: string): Record<string,string> {
  const registry = json(physical(root,'config/opcodes.json'),'opcodes.json');
  exact(registry,['schema','reserved','constants','ops','held','legacy'],'Current opcode registry');
  assert(registry.schema === 'tonswap-opcodes-v2' && object(registry.ops) && object(registry.legacy), 'Current opcode registry schema differs');
  const out: Record<string,string> = {}, groups = new Map<string,string[]>();
  const render = (lines:string[]) => ['tolk 1.5.0','','// Auto-generated. Do not edit manually.',...lines,''].join('\n')+'\n';
  for(const [file,rows] of Object.entries(registry.legacy)) {
    assert(sourcePath(file) && object(rows), 'Invalid legacy opcode source');
    const {dir,name} = posix.parse(file.slice('contracts/'.length));
    const lines = Object.keys(rows).sort().map(k => { const v=rows[k]; assert(/^OP_[A-Z0-9_]+$/.test(k) && typeof v === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v),'Invalid legacy opcode');return `const ${k}: int = ${v.startsWith('0x')?'0x'+v.slice(2).toUpperCase():v.toUpperCase()};`; });
    out[posix.join('contracts/generated/opcodes',dir,`${name}_opcodes.tolk`)] = render(lines);
  }
  for(const [name,row] of Object.entries(registry.ops)) {
    assert(/^[a-z][a-z0-9_]*$/.test(name) && object(row) && /^0x[0-9a-f]{8}$/.test(row.tag), 'Invalid current opcode');
    const constant=`const OP_${name.toUpperCase()}: int = ${row.tag};`;
    if(row.allow === undefined) { assert(/^[a-z][a-z0-9]*$/.test(row.group),'Invalid opcode group');groups.set(row.group,[...(groups.get(row.group)??[]),constant]); }
    else { assert(Array.isArray(row.allow) && row.allow.every(sourcePath) && new Set(row.allow).size === row.allow.length,'Invalid restricted opcode paths');if(row.allow.length)out[`contracts/generated/op/restricted_${name}.tolk`]=render([constant]); }
  }
  for(const [group,lines] of groups)out[`contracts/generated/op/${group}.tolk`]=render(lines.sort());return out;
}
function virtualSources(snapshot: CurrentCaptureSnapshot) {
  const root=snapshot.nativeRoot, virtual=opcodeSources(root), vendorRoot='contracts/vendor/jetton-v2.1';
  const provenance=json(physical(root,`${vendorRoot}/PROVENANCE.json`),'jetton-v2.1/PROVENANCE.json');
  assert(provenance.schema==='tonswap-vendored-source-v1' && object(provenance.files) && object(provenance.targets),'Invalid vendored source provenance');
  assert.deepEqual(provenance.compiler,CURRENT_CAPTURE_COMPILER,'Vendored compiler identity differs');
  assert.deepEqual(readdirSync(join(root,vendorRoot)).filter(n=>n!=='PROVENANCE.json'&&!n.startsWith('.')).sort(),Object.keys(provenance.files).sort(),'Vendored source file inventory differs');
  for(const [file,hash] of Object.entries(provenance.files))assert(digest(hash)&&currentCaptureSha256(physical(root,`${vendorRoot}/${file}`))===hash,`Vendored source bytes differ: ${file}`);
  const dependencies: string[]=[];
  for(const [role,row] of Object.entries(provenance.targets)) {
    assert(roleName(role)&&object(row)&&relative(row.source)&&sourcePath(row.module)&&row.module.startsWith('contracts/generated/')&&/^[A-Za-z][A-Za-z0-9]*$/.test(row.function),'Invalid vendored module');
    const target=snapshot.manifest.targets[role];assert(target&&target.source===`${vendorRoot}/${row.source}`&&target.codeHash===row.codeHash,`${role}: vendored target identity differs`);
    assert(!Object.hasOwn(virtual,row.module),`${role}: duplicate virtual source`);
    const bytes=artifact(snapshot,role);virtual[row.module]=`fun ${row.function}(): cell asm "B{${bytes.toString('hex')}} B>boc PUSHREF";\n`;dependencies.push(role);
  }
  return {virtual,dependencies};
}
function sourceClosure(snapshot: CurrentCaptureSnapshot, source: string, virtual: Record<string,string>) {
  const result=new Map<string,string>();
  const visit=(file:string)=>{
    assert(sourcePath(file),`Current capture import escapes contracts: ${file}`);if(result.has(file))return;
    const text=Object.hasOwn(virtual,file)?virtual[file]:physical(snapshot.nativeRoot,file).toString('utf8');
    assert(!file.startsWith('contracts/generated/')||Object.hasOwn(virtual,file),`Unknown virtual source: ${file}`);
    result.set(file,currentCaptureSha256(text));
    const stripped=text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,(match,quoted)=>quoted??match.replace(/[^\r\n]/g,' '));
    for(const match of stripped.matchAll(/\bimport\s+(["'])([^"']+)\1/g)) {
      const spec=match[2];
      if(spec.startsWith('@stdlib/')) {assert(/^@stdlib\/[A-Za-z0-9_-]+(?:\.tolk)?$/.test(spec),'Invalid stdlib import');continue;}
      if(spec.startsWith('@gen/')) {assert(/^@gen\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(spec),'Invalid virtual import');visit('contracts/generated/'+spec.slice(5)+(spec.endsWith('.tolk')?'':'.tolk'));continue;}
      assert(!spec.startsWith('/')&&!spec.includes('\\')&&!spec.includes('@'),'Invalid current import');visit(posix.normalize(posix.join(posix.dirname(file),spec.endsWith('.tolk')?spec:`${spec}.tolk`)));
    }
  };visit(source);return Object.fromEntries([...result].sort(([a],[b])=>a.localeCompare(b)));
}
export function assertCurrentCaptureTargets(snapshot: CurrentCaptureSnapshot, roles: readonly string[]) {
  manifestIdentity(snapshot);assert(roles.length>0&&new Set(roles).size===roles.length,'Current target selection is empty/repeated');
  const {virtual,dependencies}=virtualSources(snapshot);
  for(const role of new Set([...roles,...dependencies])) {
    assert(roleName(role)&&snapshot.manifest.targets[role],`${role}: unknown current target`);const target=snapshot.manifest.targets[role];
    assert.deepEqual(sourceClosure(snapshot,target.source,virtual),target.inputs,`${role}: current producer source closure differs`);artifact(snapshot,role);
  }
  // Stablecoin executable libraries are not compiler targets; authenticate their original bytes separately.
  for(const [file,expected] of Object.entries(snapshot.manifest.vendor)) {
    const bytes=physical(snapshot.nativeRoot,`contracts/vendor/${file}`),roots=Cell.fromBoc(bytes);
    assert.equal(bytes.length,expected.bocBytes,`${file}: vendor size differs`);assert.equal(currentCaptureSha256(bytes),expected.sha256,`${file}: vendor bytes differ`);
    assert(roots.length===1&&roots[0].hash().toString('hex')===expected.cellHash,`${file}: vendor code differs`);
  }
  return Object.fromEntries(roles.map(role=>[role,snapshot.manifest.targets[role]]));
}
const authenticated = new WeakMap<CurrentCaptureBinding,{snapshot:CurrentCaptureSnapshot; bytes:string}>();
export function assertCurrentCaptureBinding(value:unknown,snapshot:CurrentCaptureSnapshot,expected:{producer:string;suite:string;bindingSha256:string}):CurrentCaptureBinding {
  exact(value,['schema','producer','suite','tolkVersion','sandboxVersion','manifestSha256','buildHash','targets','captures'],'Current capture binding');
  assert.equal(currentCaptureSha256(JSON.stringify(value,null,2)+'\n'),expected.bindingSha256,'Current capture differs from reviewed binding bytes');
  assert(value.schema==='tonswap-capture-build-v1'&&value.producer===expected.producer&&value.suite===expected.suite&&value.tolkVersion==='1.5.0'&&value.sandboxVersion==='0.42.0','Current capture producer/toolchain differs');
  assert.equal(value.manifestSha256,snapshot.sha256,'Current capture requires its original producer manifest');assert.equal(value.buildHash,snapshot.manifest.buildHash,'Current capture buildHash differs');
  assert(object(value.targets)&&object(value.captures)&&Object.keys(value.captures).length>0,'Current capture maps are absent');
  const covered=new Set<string>(), permitted=new Set([CAPTURE_SANDBOX_TREASURY_HASH,...Object.values(snapshot.manifest.vendor).map(v=>v.cellHash)]);
  for(const [file,c] of Object.entries(value.captures)) {
    assert(relative(file),'Invalid capture path');exact(c,['executed','embedded','unbuiltCode'],file);
    for(const field of ['executed','embedded','unbuiltCode']) {const rows: unknown=c[field];assert(Array.isArray(rows)&&rows.every(field==='unbuiltCode'?digest:roleName),'Invalid capture role list');assert.deepEqual(rows,[...new Set(rows)].sort(),'Capture roles must be sorted and unique');
      if(field==='unbuiltCode')assert(rows.every(h=>permitted.has(h)),'Unknown unbuilt current capture code');else rows.forEach(r=>covered.add(r));}
    assert(c.executed.length+c.embedded.length+c.unbuiltCode.length>0,'Empty capture map');
  }
  assert.deepEqual(Object.keys(value.targets).sort(),[...covered].sort(),'Current capture target coverage differs');
  assertCurrentCaptureTargets(snapshot,[...covered]);
  for(const [role,t] of Object.entries(value.targets)) {
    exact(t,['source','codeHash','artifact','artifactSha256','inputs','inputsSha256'],role);const target=snapshot.manifest.targets[role];
    assert(t.source===target.source&&t.codeHash===target.codeHash&&t.artifact===`build/${role}.boc`,`${role}: capture identity differs`);
    inputs(t.inputs,role);assert.deepEqual(t.inputs,target.inputs,`${role}: retained compiler inputs differ`);assert.equal(t.inputsSha256,currentCaptureSha256(JSON.stringify(t.inputs)),`${role}: input digest differs`);
    assert.equal(t.artifactSha256,currentCaptureSha256(artifact(snapshot,role)),`${role}: captured artifact bytes differ`);
  }
  const result=value as CurrentCaptureBinding;authenticated.set(result,{snapshot,bytes:JSON.stringify(result)});return result;
}
export function assertCurrentCaptureCode(role:string,boc:string|Buffer|Cell,binding:CurrentCaptureBinding) {
  const auth=authenticated.get(binding);assert(auth&&auth.bytes===JSON.stringify(binding),'Current binding must remain authenticated');
  const t=binding.targets[role];assert(t,'Code is absent from current capture binding');const bytes=artifact(auth.snapshot,role);assert.equal(currentCaptureSha256(bytes),t.artifactSha256,'Current retained artifact changed');
  const roots=boc instanceof Cell?[boc]:Cell.fromBoc(typeof boc==='string'?Buffer.from(boc,'base64'):boc);assert(roots.length===1&&!roots[0].isExotic&&roots[0].hash().toString('hex')===t.codeHash,`${role}: captured executable code differs`);
}

/** Authenticate the original completed producer and every retained artifact.
 * No TypeScript producer-source lock or compiler-binary lock is invented: the
 * receipt records neither. Business state and physical cash proofs remain separate. */
export function assertCurrentCaptureProducer(snapshot: CurrentCaptureSnapshot, options: {
  directory: string; log: Buffer; producer: string; suite: string; tests: number;
  receiptSha256: string; bindingSha256: string;
}) {
  const directory=resolve(options.directory),receiptBytes=physical(directory,'producer-receipt.json'),bindingBytes=physical(directory,'build-binding.json');
  assert.equal(currentCaptureSha256(receiptBytes),options.receiptSha256,'Current producer receipt differs from reviewed bytes');
  assert.equal(currentCaptureSha256(bindingBytes),options.bindingSha256,'Current producer binding differs from reviewed bytes');
  const receipt=json(receiptBytes,'producer-receipt.json');
  exact(receipt,['schema','producer','suite','tests','captureDirectory','exitCode','runtime','logSha256','build','compiled','artifacts'],'Current producer receipt');
  assert(receipt.schema==='tonswap-capture-producer-v1'&&receipt.producer===options.producer&&receipt.suite===options.suite&&receipt.tests===options.tests&&receipt.exitCode===0,'Current producer identity/completion differs');
  assert(typeof receipt.captureDirectory==='string'&&receipt.captureDirectory.startsWith('/'),'Current producer original directory is absent');
  assert.deepEqual(receipt.runtime,{node:'v22.23.3',tolk:'1.5.0',sandbox:'0.42.0'},'Current producer runtime differs');
  assert.equal(receipt.logSha256,currentCaptureSha256(options.log),'Current producer log differs');
  const log=options.log.toString('utf8'),lines=log.split(/\r?\n/),escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  assert.doesNotMatch(log,/^(?:FAIL\s|(?:Test Suites|Tests):.*(?:failed|skipped|pending|todo))/mi,'Current producer did not fully pass');
  const summary=(prefix:RegExp,expected:RegExp)=>{const matches=lines.flatMap((line,index)=>prefix.test(line)?[{line,index}]:[]);assert(matches.length===1&&expected.test(matches[0].line),'Missing/duplicate current producer terminal result');return matches[0].index;};
  const passed=summary(/^(?:PASS|FAIL)\s/,new RegExp(`^PASS\\s+(?:[^\\s/]+\\s+)?${escape(options.suite)}($|\\s)`));
  const suites=summary(/^Test Suites:/,/^Test Suites:\s+1 passed, 1 total$/),tests=summary(/^Tests:/,new RegExp(`^Tests:\\s+${options.tests} passed, ${options.tests} total$`)),time=summary(/^Time:/,/^Time:\s+[0-9]+(?:\.[0-9]+)? s(?:, estimated [0-9]+ s)?$/);
  assert(passed<suites&&suites<tests&&tests<time,'Current producer terminal results are out of order');
  const binding=assertCurrentCaptureBinding(json(bindingBytes,'build-binding.json'),snapshot,options);
  assert.deepEqual(receipt.build,{file:'build-binding.json',sha256:options.bindingSha256,manifestSha256:snapshot.sha256,buildHash:snapshot.manifest.buildHash},'Current producer build binding differs');
  assert(object(receipt.artifacts)&&object(receipt.compiled),'Current producer inventory is absent');
  for(const [file,hash] of Object.entries(receipt.artifacts))assert(relative(file)&&digest(hash)&&currentCaptureSha256(physical(directory,file))===hash,`Current producer artifact differs: ${file}`);
  for(const file of Object.keys(binding.captures))assert(Object.hasOwn(receipt.artifacts,file),`Current producer capture is absent: ${file}`);
  assert.deepEqual(Object.keys(receipt.compiled).sort(),Object.keys(binding.targets).sort(),'Current producer compiled target coverage differs');
  for(const [role,target] of Object.entries(binding.targets)) {
    const entry=receipt.compiled[role];exact(entry,['file','sha256','codeHash','boc','bocSha256'],`${role} compiled receipt`);
    assert(entry.file===`current-compiled/${role}.json`&&entry.boc===`compiler/${role}.boc`&&entry.codeHash===target.codeHash&&entry.bocSha256===target.artifactSha256,'Current compiled receipt identity differs');
    assert(entry.sha256===receipt.artifacts[entry.file]&&entry.bocSha256===receipt.artifacts[entry.boc],'Current compiled inventory digest differs');
    const compiled=json(physical(directory,entry.file),entry.file);assert(compiled.hash===entry.codeHash&&typeof compiled.hex==='string'&&/^(?:[a-f0-9]{2})+$/.test(compiled.hex),'Current compiled JSON code differs');
    assertCurrentCaptureCode(role,Buffer.from(compiled.hex,'hex'),binding);assertCurrentCaptureCode(role,physical(directory,entry.boc),binding);
  }
  return {binding,receipt};
}
