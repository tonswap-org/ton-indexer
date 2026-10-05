import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { Cell } from '@ton/core';
import ts from 'typescript';

export const CAPTURE_PRODUCERS = {
  risk: 'tests/perps/PerpsRiskAdmission.spec.ts',
  wallets: 'tests/perps/PerpsExecutionFunding.spec.ts',
  browser: 'tests/perps/PerpsBrowserEvidence.spec.ts',
  directFee: 'tests/referral/PerpsTradeReferralPayout.spec.ts',
  funding: 'tests/perps/PerpsEngineFunding.spec.ts',
  factory: 'tests/dlmm/DlmmPoolFactory.spec.ts',
} as const;
export type CaptureProducer = keyof typeof CAPTURE_PRODUCERS;
export type CaptureBuiltTarget = {
  source: string; codeHash: string; bocBytes: number; cells: number; bits: number; inputs: Record<string, string>;
};
export type CaptureBuildManifest = {
  schema: 'tonswap-build-v1'; tolkVersion: '1.4.2'; buildHash: string; targets: Record<string, CaptureBuiltTarget>;
};
export type CaptureBuildManifestSnapshot = {
  manifest: CaptureBuildManifest; bytes: Buffer; sha256: string;
  registryBytes: Buffer; registrySha256: string;
  artifactRoot?: string;
};
export type CaptureBoundTarget = {
  source: string; codeHash: string; artifact: string; artifactSha256: string;
  inputs: Record<string, string>; inputsSha256: string;
};
export type CaptureBuildBinding = {
  schema: 'tonswap-capture-build-v1'; producer: CaptureProducer; suite: string;
  tolkVersion: '1.4.2'; sandboxVersion: '0.42.0'; manifestSha256: string; buildHash: string;
  targets: Record<string, CaptureBoundTarget>;
  captures: Record<string, { executed: string[]; embedded: string[]; unbuiltCode: string[] }>;
};
export type CaptureBuildOptions = {
  manifest?: CaptureBuildManifestSnapshot;
  /** Original producer basenames, before adoption renames. Absent means all captures. */
  captureFiles?: readonly string[];
};
export const captureSha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

// The exact TreasuryContract shipped by the capture producer's sandbox 0.42.0.
// The installed indexer sandbox 0.43.0 has the same BOC, but does not define capture authority.
const TREASURY_CODE = 'te6cckEBBAEARQABFP8A9KQT9LzyyAsBAgEgAwIAWvLT/+1E0NP/0RK68qL0BNH4AH+OFiGAEPR4b6UgmALTB9QwAfsAkTLiAbPmWwAE0jD+omUe';
export const CAPTURE_SANDBOX_TREASURY_HASH = 'd992502b94ea96e7b34e5d62ffb0c6fc73d78b3e61f11f0848fb3a1eb1afc912';
const FACTORY_NON_EXECUTABLE_HASH = '90aec8965afabb16ebc3cb9b408ebae71b618d78788bc80d09843593cac98da4';
const FACTORY_NEGATIVE_CAPTURES = new Set(['case-17.json', 'case-18.json', 'case-19.json', 'case-27.json']);
const authenticated = new WeakMap<CaptureBuildBinding, CaptureBuildManifestSnapshot>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const roleName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(value);
const relativePath = (value: unknown): value is string => typeof value === 'string'
  && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value)
  && value.split('/').every(part => part !== '.' && part !== '..');
const sourcePath = (value: unknown): value is string => relativePath(value) && value.startsWith('contracts/') && value.endsWith('.tolk');
const exact = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  assert(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label}: invalid fields`);
  return value;
};
const sortedInputs = (value: unknown, label: string): Record<string, string> => {
  assert(object(value) && Object.keys(value).length > 0, `${label}: missing inputs`);
  const keys = Object.keys(value);
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)), `${label}: inputs must be sorted`);
  for (const [file, hash] of Object.entries(value)) assert(sourcePath(file) && digest(hash), `${label}: invalid input ${file}`);
  return value as Record<string, string>;
};

function parseManifest(value: unknown): CaptureBuildManifest {
  const m = exact(value, ['schema', 'tolkVersion', 'buildHash', 'targets'], 'Capture build manifest');
  assert(m.schema === 'tonswap-build-v1' && m.tolkVersion === '1.4.2' && digest(m.buildHash), 'Capture build manifest: invalid identity');
  assert(object(m.targets) && Object.keys(m.targets).length > 0, 'Capture build manifest: no targets');
  for (const [role, value] of Object.entries(m.targets)) {
    assert(roleName(role), `Capture build manifest: invalid target ${role}`);
    const t = exact(value, ['source', 'codeHash', 'bocBytes', 'cells', 'bits', 'inputs'], role);
    assert(sourcePath(t.source) && digest(t.codeHash), `${role}: invalid source/code hash`);
    assert(Number.isSafeInteger(t.bocBytes) && Number(t.bocBytes) > 0
      && Number.isSafeInteger(t.cells) && Number(t.cells) > 0
      && Number.isSafeInteger(t.bits) && Number(t.bits) >= 0, `${role}: invalid artifact dimensions`);
    const inputs = sortedInputs(t.inputs, role);
    assert(Object.hasOwn(inputs, t.source), `${role}: source is absent from inputs`);
  }
  return m as unknown as CaptureBuildManifest;
}

export function readCaptureBuildManifest(path = join(__dirname, 'fixtures/capture-build/manifest.json'),
  registryPath = join(dirname(path), 'targets.txt')): CaptureBuildManifestSnapshot {
  assert(lstatSync(path).isFile() && realpathSync(path) === resolve(path), 'Capture build manifest must be a physical file');
  assert(lstatSync(registryPath).isFile() && realpathSync(registryPath) === resolve(registryPath), 'Capture target registry must be a physical file');
  const bytes = readFileSync(path);
  const registryBytes = readFileSync(registryPath);
  return { manifest: parseManifest(JSON.parse(bytes.toString('utf8'))), bytes, sha256: captureSha256(bytes),
    registryBytes, registrySha256: captureSha256(registryBytes), artifactRoot: join(dirname(resolve(path)), 'artifacts') };
}

function physical(root: string, file: string): Buffer {
  assert(relativePath(file), `Capture source: invalid path ${file}`);
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    assert(!lstatSync(path).isSymbolicLink(), `Capture source must be physical: ${file}`);
  }
  assert(lstatSync(path).isFile() && realpathSync(path) === path, `Capture source must be a physical file: ${file}`);
  return readFileSync(path);
}

/** Parse only the native target data literals; never import native executable build/release code. */
function targetRegistry(snapshot: CaptureBuildManifestSnapshot): { targets: Record<string, string>; deploy: string[] } {
  assert.equal(snapshot.registrySha256, captureSha256(snapshot.registryBytes), 'Retained capture target registry changed');
  const text = snapshot.registryBytes.toString('utf8');
  const source = ts.createSourceFile('targets.ts', text, ts.ScriptTarget.Latest, true);
  const maps: Record<string, Record<string, string>> = {};
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['DEPLOY_TARGETS', 'TEST_TARGETS'].includes(declaration.name.text)) continue;
      let value = declaration.initializer;
      if (value && ts.isAsExpression(value)) value = value.expression;
      assert(value && ts.isObjectLiteralExpression(value), 'Capture target registry requires literal maps');
      const entries: Record<string, string> = {};
      for (const entry of value.properties) {
        assert(ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))
          && ts.isStringLiteral(entry.initializer), 'Capture target registry requires literal paths');
        const role = entry.name.text, path = entry.initializer.text;
        assert(roleName(role) && sourcePath(path) && !Object.hasOwn(entries, role), 'Capture target registry contains invalid/duplicate targets');
        entries[role] = path;
      }
      assert(!Object.hasOwn(maps, declaration.name.text), 'Capture target registry repeats a map');
      maps[declaration.name.text] = entries;
    }
  }
  assert(maps.DEPLOY_TARGETS && maps.TEST_TARGETS && Object.keys(maps.DEPLOY_TARGETS).length > 0, 'Capture target registry is incomplete');
  assert(!Object.keys(maps.TEST_TARGETS).some(role => Object.hasOwn(maps.DEPLOY_TARGETS, role)), 'Capture target registry duplicates a target');
  return { targets: { ...maps.DEPLOY_TARGETS, ...maps.TEST_TARGETS }, deploy: Object.keys(maps.DEPLOY_TARGETS) };
}

function assertManifestIdentity(snapshot: CaptureBuildManifestSnapshot, registry: ReturnType<typeof targetRegistry>): void {
  const parsed = parseManifest(JSON.parse(snapshot.bytes.toString('utf8')));
  assert.deepEqual(snapshot.manifest, parsed, 'Capture build manifest object differs from its retained bytes');
  assert.equal(snapshot.sha256, captureSha256(snapshot.bytes), 'Capture build manifest byte hash changed');
  assert(registry.deploy.every(role => Object.hasOwn(parsed.targets, role)), 'Capture build manifest is missing a deploy target');
  assert(Object.keys(parsed.targets).every(role => Object.hasOwn(registry.targets, role)), 'Capture build manifest contains an unknown target');
  const lines = registry.deploy.map(role => `${role}:${parsed.targets[role].codeHash}`).sort();
  assert.equal(parsed.buildHash, captureSha256(lines.join('\n')), 'Capture build manifest buildHash is invalid');
}

// Preserve strings while removing comments, so an import inside a comment cannot enlarge the closure.
function withoutComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (match, quoted: string | undefined) => quoted ?? match.replace(/[^\r\n]/g, ' '));
}

function sourceClosure(root: string, source: string): Record<string, string> {
  assert(realpathSync(root) === root && lstatSync(root).isDirectory(), 'Capture native root must be a canonical physical directory');
  const inputs = new Map<string, string>();
  let opcodes: Record<string, unknown> | undefined;
  const read = (file: string): string => {
    if (!file.startsWith('contracts/generated/opcodes/')) return physical(root, file).toString('utf8');
    // Pure build serves this source virtually from the current physical config.
    opcodes ??= JSON.parse(physical(root, 'config/opcodes.json').toString('utf8')) as Record<string, unknown>;
    assert(object(opcodes), 'Capture opcode configuration must be an object');
    const module = 'contracts/' + file.slice('contracts/generated/opcodes/'.length).replace(/_opcodes\.tolk$/, '.tolk');
    const values = opcodes[module];
    assert(object(values) && Object.keys(values).every(name => /^OP_[A-Z0-9_]+$/.test(name)
      && typeof values[name] === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(values[name] as string)), `Capture opcode module is unavailable: ${module}`);
    const lines = ['tolk 1.4.2', '', '// Auto-generated. Do not edit manually.'];
    for (const name of Object.keys(values).sort()) {
      const value = values[name] as string;
      lines.push(`const ${name}: int = ${value.startsWith('0x') ? '0x' + value.slice(2).toUpperCase() : value.toUpperCase()};`);
    }
    lines.push('');
    return lines.join('\n') + '\n';
  };
  const visit = (file: string): void => {
    assert(sourcePath(file), `Capture import escapes the contract tree: ${file}`);
    if (inputs.has(file)) return;
    const text = read(file);
    inputs.set(file, captureSha256(text));
    for (const match of withoutComments(text).matchAll(/\bimport\s+(["'])([^"']+)\1/g)) {
      const spec = match[2];
      if (spec.startsWith('@stdlib/')) {
        assert(/^@stdlib\/[A-Za-z0-9_-]+\.tolk$/.test(spec), `Capture import has an invalid stdlib path: ${spec}`);
        continue; // Compiler 1.4.2 owns stdlib; it is not in sourcesSnapshot.inputs.
      }
      assert(!spec.startsWith('/') && !spec.includes('\\') && !spec.includes('@'), `Capture import has an invalid path: ${spec}`);
      visit(posix.normalize(posix.join(posix.dirname(file), spec.endsWith('.tolk') ? spec : `${spec}.tolk`)));
    }
  };
  visit(source);
  return Object.fromEntries([...inputs].sort(([a], [b]) => a.localeCompare(b)));
}

/** Authenticate a manifest-backed compiler role without claiming it ran in a capture. */
export function assertCaptureTargetClosure(role: string, nativeRoot: string,
  snapshot = readCaptureBuildManifest()): CaptureBuiltTarget {
  const registry = targetRegistry(snapshot);
  assertManifestIdentity(snapshot, registry);
  const target = snapshot.manifest.targets[role];
  assert(roleName(role) && target && registry.targets[role] === target.source, `${role}: unregistered capture build target`);
  assert.deepEqual(sourceClosure(nativeRoot, target.source), target.inputs, `${role}: current source closure differs from the capture build`);
  return target;
}

/** Capture maps are reviewed evidence, not authority supplied by a mutable receipt.
 * Pin them independently so removing a role everywhere cannot skip its closure. */
export function assertRetainedCaptureBinding(value: unknown, producer: CaptureProducer): void {
  assert(Object.hasOwn(CAPTURE_PRODUCERS, producer), 'Unknown capture producer');
  const bytes = physical(resolve(__dirname, 'fixtures/capture-build'), `${producer}/build-binding.json`);
  assert.deepEqual(value, JSON.parse(bytes.toString('utf8')), 'Capture differs from reviewed producer binding');
}

export function assertCaptureBuildBinding(value: unknown, producer: CaptureProducer, nativeRoot: string,
  options: CaptureBuildOptions = {}): CaptureBuildBinding {
  const binding = exact(value, ['schema', 'producer', 'suite', 'tolkVersion', 'sandboxVersion', 'manifestSha256', 'buildHash', 'targets', 'captures'], 'Capture build binding');
  assert(binding.schema === 'tonswap-capture-build-v1' && binding.producer === producer && binding.suite === CAPTURE_PRODUCERS[producer]
    && binding.tolkVersion === '1.4.2' && binding.sandboxVersion === '0.42.0', 'Capture build binding: invalid producer/toolchain');
  assert(digest(binding.manifestSha256) && digest(binding.buildHash), 'Capture build binding: invalid manifest hashes');
  const snapshot = options.manifest ?? readCaptureBuildManifest();
  const registry = targetRegistry(snapshot);
  assertManifestIdentity(snapshot, registry);
  assert.equal(binding.manifestSha256, snapshot.sha256, 'Capture binding does not match retained manifest bytes');
  assert.equal(binding.buildHash, snapshot.manifest.buildHash, 'Capture binding buildHash mismatch');
  assert(object(binding.targets) && Object.keys(binding.targets).length > 0 && object(binding.captures)
    && Object.keys(binding.captures).length > 0, 'Capture build binding requires targets and captures');
  const targets = binding.targets as Record<string, unknown>, captures = binding.captures as Record<string, unknown>;
  const covered = new Set<string>();
  assert.equal(Cell.fromBase64(TREASURY_CODE).hash().toString('hex'), CAPTURE_SANDBOX_TREASURY_HASH, 'Captured sandbox Treasury pin differs from its code');
  for (const [file, value] of Object.entries(captures)) {
    assert(relativePath(file), `Capture build binding: invalid capture path ${file}`);
    const c = exact(value, ['executed', 'embedded', 'unbuiltCode'], `Capture ${file}`);
    for (const field of ['executed', 'embedded', 'unbuiltCode'] as const) {
      const rows = c[field];
      assert(Array.isArray(rows) && rows.every(field === 'unbuiltCode' ? digest : roleName), `Capture ${file}: invalid ${field}`);
      assert.deepEqual(rows, [...new Set(rows)].sort(), `Capture ${file}: ${field} must be sorted and unique`);
      if (field === 'unbuiltCode') assert(rows.every(hash => hash === CAPTURE_SANDBOX_TREASURY_HASH
        || (producer === 'factory' && FACTORY_NEGATIVE_CAPTURES.has(file) && hash === FACTORY_NON_EXECUTABLE_HASH)), `Capture ${file}: unknown unbuilt code`);
      else rows.forEach(role => covered.add(role));
    }
    assert((c.executed as unknown[]).length + (c.embedded as unknown[]).length + (c.unbuiltCode as unknown[]).length > 0, `Capture ${file}: empty map`);
  }
  assert.deepEqual(Object.keys(targets).sort(), [...covered].sort(), 'Capture target coverage differs from executed/embedded maps');
  const selected = options.captureFiles ?? Object.keys(captures);
  assert(selected.length > 0 && new Set(selected).size === selected.length && selected.every(file => Object.hasOwn(captures, file)), 'Capture selection is missing, repeated or unknown');
  const current = new Set<string>();
  for (const file of selected) {
    const c = captures[file] as { executed: string[]; embedded: string[] };
    [...c.executed, ...c.embedded].forEach(role => current.add(role));
  }
  for (const [role, value] of Object.entries(targets)) {
    const t = exact(value, ['source', 'codeHash', 'artifact', 'artifactSha256', 'inputs', 'inputsSha256'], `Bound target ${role}`);
    const target = snapshot.manifest.targets[role];
    assert(roleName(role) && target && registry.targets[role] === target.source, `${role}: unregistered capture target`);
    assert(t.source === target.source && t.codeHash === target.codeHash && t.artifact === `build/${role}.boc`
      && digest(t.artifactSha256) && digest(t.inputsSha256), `${role}: invalid artifact/source/code binding`);
    const inputs = sortedInputs(t.inputs, role);
    assert.deepEqual(inputs, target.inputs, `${role}: compiler inputs differ from the retained build`);
    assert.equal(t.inputsSha256, captureSha256(JSON.stringify(inputs)), `${role}: inputsSha256 mismatch`);
    if (current.has(role)) assert.deepEqual(sourceClosure(nativeRoot, target.source), inputs, `${role}: current source closure differs from the capture build`);
  }
  const result = binding as unknown as CaptureBuildBinding;
  authenticated.set(result, snapshot);
  return result;
}

export function assertCaptureCode(role: string, boc: string | Buffer | Cell, binding: CaptureBuildBinding): void {
  const snapshot = authenticated.get(binding);
  assert(snapshot, 'Capture build binding must be authenticated before its code');
  const target = binding.targets[role], manifest = snapshot.manifest.targets[role];
  assert(target && manifest && target.codeHash === manifest.codeHash, `${role}: code is absent from the authenticated capture binding`);
  const artifactRoot = snapshot.artifactRoot ?? join(__dirname, 'fixtures/capture-build/artifacts');
  assert(realpathSync(artifactRoot) === artifactRoot && lstatSync(artifactRoot).isDirectory(), 'Capture artifact root must be a canonical physical directory');
  const artifact = physical(artifactRoot, `${role}.boc`);
  assert.equal(artifact.length, manifest.bocBytes, `${role}: captured build artifact size differs`);
  assert.equal(captureSha256(artifact), target.artifactSha256, `${role}: captured build artifact digest differs`);
  const artifactRoots = Cell.fromBoc(artifact);
  assert(artifactRoots.length === 1 && !artifactRoots[0].isExotic, `${role}: build artifact must have one ordinary root`);
  assert.equal(artifactRoots[0].hash().toString('hex'), manifest.codeHash, `${role}: build artifact code hash differs`);
  const roots = boc instanceof Cell ? [boc] : Cell.fromBoc(typeof boc === 'string' ? Buffer.from(boc, 'base64') : boc);
  assert(roots.length === 1 && !roots[0].isExotic, `${role}: code must have one ordinary root`);
  assert.equal(roots[0].hash().toString('hex'), target.codeHash, `${role}: captured code hash differs from its build`);
}
