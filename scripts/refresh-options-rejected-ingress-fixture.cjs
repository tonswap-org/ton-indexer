'use strict';

// Local fixture preparation only: run the complete native producer, or consume
// an explicitly pinned closed run. Never authorize a release or replace the
// retained canonical fixtures implicitly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { Cell } = require('@ton/core');

const TEST = 'tests/options/OptionFactory.spec.ts';
const CAPTURE_TEST = 'refunds the complete deposit when a buy sends more than the quoted premium';
const ROLES = ['OptionFactory', 'JettonWallet', 'JettonRoot', 'ShoutOption', 'OutperformanceOption',
  'OptionSeriesManager', 'OptionVault', 'VolIndex'];
const HASH = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ENTRYPOINTS = {
  OptionFactory: 'contracts/options/factory.tolk',
  JettonWallet: 'contracts/shared/jetton/jetton_wallet.generated.tolk',
  JettonRoot: 'contracts/shared/jetton/jetton_root.generated.tolk',
  ShoutOption: 'contracts/options/shout_option.tolk',
  OutperformanceOption: 'contracts/options/outperformance_option.tolk',
  OptionSeriesManager: 'contracts/options/series_manager.tolk',
  OptionVault: 'contracts/options/vault.tolk',
  VolIndex: 'contracts/volatility/vol_index.tolk',
};

function physical(file) {
  assert(path.isAbsolute(file) && path.normalize(file) === file, 'Absolute canonical file path required');
  const before = fs.lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && fs.realpathSync(file) === file, 'Physical file required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    for (const row of [after, current]) {
      assert(before.ino === row.ino && before.dev === row.dev && before.mode === row.mode &&
        before.size === row.size && before.mtimeMs === row.mtimeMs && before.ctimeMs === row.ctimeMs,
      'Input changed during read');
    }
    return { bytes, ref: { path: file, sha256: sha(bytes), bytes: bytes.length, mode: before.mode & 0o777 } };
  } finally { fs.closeSync(fd); }
}
function directory(value) {
  assert(path.isAbsolute(value) && path.normalize(value) === value && fs.realpathSync(value) === value,
    'Absolute physical directory required');
  const stat = fs.lstatSync(value);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Physical directory required');
  return value;
}
function pinned(ref) {
  assert(ref && HASH.test(ref.sha256), 'Hashed input reference required');
  const read = physical(ref.path);
  assert.equal(read.ref.sha256, ref.sha256, `Input hash changed: ${ref.path}`);
  if (ref.bytes !== undefined) assert.equal(read.ref.bytes, ref.bytes);
  if (ref.mode !== undefined) assert.equal(read.ref.mode, ref.mode);
  return read;
}
function closed(terminal) {
  assert.equal(terminal.exitCode, 0, 'Producer did not exit successfully');
  assert.equal(terminal.childSignal, null);
  assert.equal(terminal.timedOut, false);
  assert.equal(terminal.wrapperError, null);
  for (const key of ['childReaped', 'processGroupDrained', 'processGroupEmptyAtLeaderExit', 'ownedExecutionClosed'])
    assert.equal(terminal[key], true, `Unclosed producer: ${key}`);
  assert.deepEqual(terminal.receivedSignals, []);
  assert.equal(terminal.drainSignalForwarded, false);
  assert(Number.isSafeInteger(terminal.pid) && terminal.pid > 0, 'Actual producer PID required');
  assert(Number.isFinite(Date.parse(terminal.startedAt)) &&
    Date.parse(terminal.finishedAt) >= Date.parse(terminal.startedAt), 'Invalid producer interval');
}
function completeRun(report, log, nativeRoot) {
  assert.equal(report.success, true, 'Failed Jest report');
  for (const [key, value] of Object.entries({ numTotalTestSuites: 1, numPassedTestSuites: 1,
    numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 55, numPassedTests: 55,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 })) assert.equal(report[key], value, key);
  assert.equal(report.testResults.length, 1);
  const suite = report.testResults[0];
  assert.equal(suite.name, path.join(nativeRoot, TEST));
  assert.equal(suite.status, 'passed');
  assert.equal(suite.assertionResults.length, 55);
  assert(suite.assertionResults.every(row => row.status === 'passed' && typeof row.fullName === 'string' && row.fullName),
    'Every actual test must pass');
  assert.equal(new Set(suite.assertionResults.map(row => row.fullName)).size, 55, 'Duplicate test results');
  assert.equal(suite.assertionResults.filter(row => row.title === CAPTURE_TEST).length, 1, 'Capture case absent');
  // Require both the structured report and the complete terminal summary. An
  // appended failing summary, filtered run, or repeated capture is not evidence.
  assert.deepEqual(log.match(/^Test Suites:.*$/gm), ['Test Suites: 1 passed, 1 total']);
  assert.deepEqual(log.match(/^Tests:.*$/gm)?.map(line => line.replace(/\s+/g, ' ')), ['Tests: 55 passed, 55 total']);
  assert(!/^FAIL\s/m.test(log), 'Failed suite in complete log');
  const states = [...log.matchAll(/OPTIONS_REFUND_FACTORY_STATE\s+([A-Za-z0-9+/=]+)/g)];
  const hashes = [...log.matchAll(/OPTIONS_REFUND_FACTORY_CODE_HASH\s+([a-f0-9]{64})/g)];
  assert.equal(states.length, 1, 'Exactly one complete native state capture required');
  assert.equal(hashes.length, 1, 'Exactly one native code capture required');
  const boc = Buffer.from(states[0][1], 'base64');
  assert.equal(boc.toString('base64'), states[0][1], 'Noncanonical captured BOC encoding');
  const cells = Cell.fromBoc(boc);
  assert.equal(cells.length, 1, 'One captured state root required');
  assert(!cells[0].isExotic, 'Ordinary captured state required');
  return { boc, state: cells[0], factoryCodeHash: hashes[0][1] };
}
function validateState(capture, artifacts, readOptionFactoryConfig) {
  assert.equal(capture.factoryCodeHash, artifacts.OptionFactory.hash, 'Captured Factory code differs');
  const config = capture.state.refs[0].refs[1];
  assert.equal(config.refs[2].refs[0].hash().toString('hex'), artifacts.JettonWallet.hash, 'Collateral Wallet code differs');
  assert.equal(config.refs[3].refs[0].hash().toString('hex'), artifacts.JettonWallet.hash, 'Fee Wallet code differs');
  assert.equal(config.refs[1].refs[0].hash().toString('hex'), artifacts.ShoutOption.hash, 'Shout code differs');
  assert.equal(config.refs[1].refs[1].hash().toString('hex'), artifacts.OutperformanceOption.hash, 'Outperformance code differs');
  const actual = readOptionFactoryConfig(capture.boc.toString('base64'));
  assert.equal(actual.series.size, 1);
  assert.equal(actual.series.get('1')?.expiryRegistered, true);
  assert.equal(actual.series.get('1')?.writer.nativeEscrow.admitted, true);
  assert.equal(actual.series.get('1')?.writer.nativeEscrow.requiredReserveRaw, '11830000000');
  assert.equal(actual.ingressReceipts.size, 2);
  const receipts = [...actual.ingressReceipts.values()];
  assert.equal(receipts.filter(row => !row.accepted && row.buyKey === 0n && row.acceptedAmountRaw === '0' && row.refunds.size === 0).length, 1);
  assert.equal(receipts.filter(row => row.accepted && row.buyKey === 0n && row.acceptedAmountRaw === '112500000000' && row.refunds.size === 0).length, 1);
}
function producerCommand(node, captureDir) {
  return [node, '--no-turbo-fast-api-calls', 'node_modules/jest/bin/jest.js', '--config', 'jest.config.cjs',
    '--runInBand', '--json', '--outputFile', path.join(captureDir, 'producer-result.json'), '--cacheDirectory',
    path.join(captureDir, 'jest-cache'), '--runTestsByPath', TEST];
}
function validateBoundaries(before, after, nativeRoot, captureDir, nodeSha256) {
  assert.equal(before.schema, 'tonswap-options-refund-producer-input-v1');
  assert.deepEqual(after, before, 'Native source/runtime changed during capture');
  assert.equal(before.node.path, process.execPath, 'Use the actual producer Node executable');
  assert.equal(before.node.sha256, nodeSha256, 'Runtime hash differs from explicit authority');
  pinned(before.node);
  assert.deepEqual(process.execArgv, ['--no-turbo-fast-api-calls'], 'Explicit native VM runtime flag required');
  assert.equal(process.env.NODE_OPTIONS, undefined, 'Ambient Node options are forbidden');
  assert.equal(before.input.job.packageRoot, nativeRoot);
  assert.equal(before.input.job.id, 'contracts');
  assert.deepEqual(before.input.job.dependsOn, []);
  assert.deepEqual(before.input.job.requiredOutputs, ['build']);
  assert.deepEqual(before.input.job.commands, [producerCommand(before.node.path, captureDir)], 'Full unfiltered producer command required');
  assert.equal(before.input.job.executionIdentitySha256, before.runtimeIdentity);
  for (const key of ['runner', 'independentCompiler', 'supervisor', 'toolchain']) pinned(before[key]);
}
function sourceClosure(nativeRoot, compiled, before, buildManifest) {
  assert.deepEqual(Object.keys(compiled.artifacts).sort(), [...ROLES].sort(), 'Complete eight-role compiler closure required');
  const compilerSources = {};
  for (const role of ROLES) {
    const artifact = compiled.artifacts[role], roots = Cell.fromBoc(Buffer.from(artifact.boc, 'base64'));
    assert.equal(artifact.entrypoint, ENTRYPOINTS[role], `${role}: wrong compiler entrypoint`);
    assert.equal(roots.length, 1); assert(!roots[0].isExotic);
    assert.equal(roots[0].hash().toString('hex'), artifact.hash, `${role}: compiler BOC hash mismatch`);
    assert.equal(artifact.hash, before.buildCodes[role], `${role}: independent compile differs from authenticated build`);
    const target = artifact.entrypoint.replace(/\.generated\.tolk$/, '.tolk');
    const binding = buildManifest.artifactBindings.find(row => row.target === target);
    assert(binding, `${role}: absent authenticated compiler target`);
    assert.equal(artifact.tolkVersion, binding.tolkVersion);
    assert.equal(new Set(artifact.sources.map(row => row.path)).size, artifact.sources.length, 'Duplicate compiler source');
    // Wrapper-generated identity entrypoints have a harmless banner. Bind their
    // actual bytes, while demanding the complete authenticated import path set.
    assert.deepEqual(artifact.sources.map(row => row.path.replace(/\.generated\.tolk$/, '.tolk')).sort(),
      binding.sources.map(row => row.path).sort(), `${role}: truncated compiler source closure`);
    for (const row of artifact.sources) {
      assert(!path.isAbsolute(row.path) && path.normalize(row.path) === row.path && !row.path.startsWith('..'), 'Unsafe compiler source path');
      const digest = physical(path.join(nativeRoot, row.path)).ref.sha256;
      assert.equal(digest, row.sha256, `Compiler source changed: ${row.path}`);
      const original = binding.sources.find(item => item.path === row.path);
      if (original) assert.equal(digest, original.sha256, 'Compiler source differs from authenticated build');
      if (compilerSources[row.path]) assert.equal(compilerSources[row.path], digest);
      compilerSources[row.path] = digest;
    }
  }
  const runtimeSources = runtimeClosure(nativeRoot);
  const sourceMap = new Map(before.input.sourceFiles.map(row => [row.path, row.sha256]));
  for (const [relative, digest] of Object.entries(runtimeSources))
    assert.equal(digest, sourceMap.get(relative), `Unbound native runtime import: ${relative}`);
  const sources = { ...runtimeSources, ...compilerSources };
  assert.deepEqual(sources, before.fixtureSources, 'Producer fixture source inventory differs from complete actual closure');
  return sources;
}
function runtimeClosure(nativeRoot) {
  const req = createRequire(path.join(nativeRoot, 'package.json')), ts = req('typescript');
  const config = ts.readConfigFile(path.join(nativeRoot, 'tsconfig.json'), ts.sys.readFile);
  assert(!config.error); const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, nativeRoot);
  assert.equal(parsed.errors.length, 0);
  const runtimeSources = {};
  function visit(absolute) {
    const relative = path.relative(nativeRoot, absolute);
    if (relative.startsWith('..') || relative.split(path.sep).includes('node_modules') || Object.hasOwn(runtimeSources, relative)) return;
    const { bytes, ref } = physical(absolute);
    runtimeSources[relative] = ref.sha256;
    if (!/\.(?:[cm]?ts|[cm]?js)$/.test(absolute)) return;
    for (const imported of ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, absolute, parsed.options, ts.sys).resolvedModule;
      if (resolved) visit(resolved.resolvedFileName);
      else assert(!imported.fileName.startsWith('.'), `Unresolved native import: ${imported.fileName}`);
    }
  }
  for (const file of [TEST, 'tests/setup.maxListeners.ts', 'tests/setup.silenceSandboxLogs.ts', 'jest.config.cjs',
    ...ROLES.map(role => `wrappers/${role}.compile.ts`)]) visit(path.join(nativeRoot, file));
  return runtimeSources;
}

function refresh({ captureDir, nativeRoot, outputRoot, nodeSha256, sourceBeforeSha256, compileSha256 }) {
  directory(captureDir); directory(nativeRoot);
  assert(HASH.test(nodeSha256), 'Explicit producer Node SHA-256 required');
  assert(HASH.test(sourceBeforeSha256) && HASH.test(compileSha256), 'Explicit selected producer and compiler-output SHA-256 required');
  assert(path.isAbsolute(outputRoot) && path.normalize(outputRoot) === outputRoot && !fs.existsSync(outputRoot), 'New absolute output root required');
  directory(path.dirname(outputRoot));
  const indexerRoot = path.resolve(__dirname, '..');
  assert(!outputRoot.startsWith(nativeRoot + path.sep) && !outputRoot.startsWith(path.join(indexerRoot, 'src') + path.sep),
    'Write a new preparation output; canonical fixture adoption is a separate reviewed copy');
  require('tsx/cjs/api').register();
  const nativeRequire = createRequire(path.join(nativeRoot, 'package.json'));
  const { assertNoDuplicateJsonObjectKeys } = nativeRequire(path.join(nativeRoot, 'scripts/utils/jsonEvidence.ts'));
  const evidence = {};
  function read(name) {
    const actual = physical(path.join(captureDir, name)); evidence[name] = actual.ref;
    const text = actual.bytes.toString('utf8'); assertNoDuplicateJsonObjectKeys(text, name); return JSON.parse(text);
  }
  const before = read('source-before.json'), after = read('source-after.json');
  assert.equal(evidence['source-before.json'].sha256, sourceBeforeSha256, 'Selected producer authority differs');
  validateBoundaries(before, after, nativeRoot, captureDir, nodeSha256);
  const terminal = read('producer-terminal.json'), launch = read('producer-launch.json'), report = read('producer-result.json');
  const compileTerminal = read('independent-compile-terminal.json'), compiled = read('independent-compile.json');
  assert.equal(evidence['independent-compile.json'].sha256, compileSha256, 'Selected compiler output differs');
  const diagnostic = read('diagnostic.json');
  closed(terminal); closed(compileTerminal);
  assert(Date.parse(compileTerminal.finishedAt) <= Date.parse(terminal.startedAt) ||
    Date.parse(compileTerminal.startedAt) >= Date.parse(terminal.finishedAt), 'Compiler and producer phases overlap');
  assert(report.startTime >= Date.parse(terminal.startedAt) && report.startTime <= Date.parse(terminal.finishedAt), 'Jest report predates this producer');
  assert.equal(diagnostic.status, 'PASS');
  for (const key of ['sourceUnchanged', 'runtimeUnchanged', 'fixtureSourceUnchanged']) assert.equal(diagnostic[key], true);
  for (const [key, name] of Object.entries({ producer: 'producer-terminal.json', independentCompile: 'independent-compile-terminal.json',
    sourceBefore: 'source-before.json', sourceAfter: 'source-after.json' })) assert.deepEqual(diagnostic[key], evidence[name]);
  assert.deepEqual(terminal.argv, producerCommand(before.node.path, captureDir));
  assert.deepEqual(launch.argv, terminal.argv); assert.equal(launch.cwd, nativeRoot); assert.equal(terminal.cwd, nativeRoot);
  assert.equal(launch.pid, terminal.pid); assert.equal(launch.startedAt, terminal.startedAt);
  assert.deepEqual(launch.sourceBefore, evidence['source-before.json']);
  assert.deepEqual(launch.environment, terminal.environment);
  for (const key of ['TONSWAP_NETWORK', 'TON_NETWORK']) assert.equal(terminal.environment[key], 'testnet');
  assert.equal(terminal.environment.NODE_ENV, 'test');
  assert.equal(terminal.environment.OPTIONS_REFUND_STATE_CAPTURE, '1');
  assert.equal(terminal.environment.NODE_OPTIONS, undefined);
  assert.equal(terminal.full55CasesPassed, true);
  assert.deepEqual(terminal.report, evidence['producer-result.json']);
  assert.equal(terminal.log.path, path.join(captureDir, 'producer.log'));
  const log = pinned(terminal.log); evidence['producer.log'] = log.ref;
  const capture = completeRun(report, log.bytes.toString('utf8'), nativeRoot);
  assert(report.testResults[0].startTime >= report.startTime &&
    report.testResults[0].endTime >= report.testResults[0].startTime &&
    report.testResults[0].endTime <= Date.parse(terminal.finishedAt), 'Jest suite interval differs from this producer');
  const compileArgv = before.independentCompiler.path === __filename
    ? compilerCommand(before.node.path, nativeRoot, captureDir)
    : [before.node.path, '--no-turbo-fast-api-calls', before.independentCompiler.path];
  assert.deepEqual(compileTerminal.argv, compileArgv);
  assert.equal(compileTerminal.cwd, nativeRoot); assert.deepEqual(compileTerminal.environment, terminal.environment);
  assert.equal(compileTerminal.log.path, path.join(captureDir, 'independent-compile.log'));
  evidence['independent-compile.log'] = pinned(compileTerminal.log).ref;
  assert.equal(compiled.schema, 'tonswap-options-refund-independent-code-v1');
  assert.equal(compiled.runtime, before.node.path); assert.equal(compiled.runtimeSha256, nodeSha256);
  assert(compiled.importedModules && Object.keys(compiled.importedModules).length > 0, 'Compiler runtime inputs required');
  for (const [file, digest] of Object.entries(compiled.importedModules)) assert.equal(physical(file).ref.sha256, digest, `Compiler import changed: ${file}`);
  const { firstReleaseExecutionIdentity } = nativeRequire(path.join(nativeRoot, 'scripts/release/firstReleaseCommands.ts'));
  const { captureFirstReleaseJobInput } = nativeRequire(path.join(nativeRoot, 'scripts/release/firstReleaseCandidate.ts'));
  const { readFirstReleaseFixtureBuild } = nativeRequire(path.join(nativeRoot, 'scripts/release/firstReleaseFixturePreflight.ts'));
  assert.equal(firstReleaseExecutionIdentity(nativeRoot), before.runtimeIdentity, 'Current native runtime differs');
  assert.deepEqual(captureFirstReleaseJobInput(before.input.job), before.input, 'Current native source differs');
  assert.deepEqual(Object.fromEntries(readFirstReleaseFixtureBuild(nativeRoot)), before.buildCodes, 'Current authenticated build differs');
  const buildManifest = JSON.parse(pinned(before.toolchain).bytes);
  const sources = sourceClosure(nativeRoot, compiled, before, buildManifest);
  const { readOptionFactoryConfig } = require('../src/ledger/optionLifecycleState.ts');
  validateState(capture, compiled.artifacts, readOptionFactoryConfig);
  // Recheck every consumed producer receipt before publishing either output.
  for (const ref of Object.values(evidence)) pinned(ref);
  const bocName = 'options-factory-rejected-ingress.boc';
  const provenance = { schemaVersion: 1, capturedAt: terminal.finishedAt, fixture: bocName,
    scope: 'Actual local Sandbox Factory state from the complete 55-test current native producer. Not live-chain evidence or release qualification.',
    factoryCodeHash: capture.factoryCodeHash, walletCodeHash: compiled.artifacts.JettonWallet.hash,
    bocSha256: sha(capture.boc), bocBytes: capture.boc.length, vm: 15, nanoGramPerGas: 400,
    captureTest: `${TEST}: ${CAPTURE_TEST}`, captureTestResult: 'PASS', combinedRunResult: '55 passed, 0 skipped, 55 total',
    producerLog: terminal.log.path, producerLogSha256: terminal.log.sha256, sourceSha256: sources,
    sourceBindingStage: 'Complete native source/runtime unchanged before and after the actual producer; current source and authenticated build revalidated, with a fresh independent eight-role compiler closure.',
    sourceInventoryFiles: before.input.sourceFiles.length, nativeSourceDigest: before.input.sourceDigest,
    runtimeIdentitySha256: before.runtimeIdentity, runtime: before.node,
    independentCodeHashes: Object.fromEntries(ROLES.map(role => [role, compiled.artifacts[role].hash])),
    adopter: physical(__filename).ref, evidence };
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(outputRoot, bocName), capture.boc, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(outputRoot, 'options-factory-rejected-ingress.provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'PASS', releaseQualification: false, outputRoot, testsPassed: 55,
    sourceInputs: Object.keys(sources).length, outputs: [bocName, 'options-factory-rejected-ingress.provenance.json'].map(name => physical(path.join(outputRoot, name)).ref) };
}
function argumentsFor(argv) {
  assert.deepEqual(argv.filter((_, index) => index % 2 === 0), ['--capture-dir', '--native-root', '--node-sha256',
    '--source-before-sha256', '--compile-sha256', '--output-root'],
  'Use --capture-dir DIR --native-root DIR --node-sha256 HASH --source-before-sha256 HASH --compile-sha256 HASH --output-root NEW_DIR');
  assert.equal(argv.length, 12);
  return { captureDir: argv[1], nativeRoot: argv[3], nodeSha256: argv[5], sourceBeforeSha256: argv[7], compileSha256: argv[9], outputRoot: argv[11] };
}
function compilerCommand(node, nativeRoot, captureDir) {
  return [node, '--no-turbo-fast-api-calls', __filename, 'compile', '--native-root', nativeRoot,
    '--output-file', path.join(captureDir, 'independent-compile.json')];
}
function cleanEnvironment() {
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8',
    CI: '1', NO_COLOR: '1', TONSWAP_NETWORK: 'testnet', TON_NETWORK: 'testnet', NODE_ENV: 'test',
    TS_NODE_PREFER_TS_EXTS: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', OPTIONS_REFUND_STATE_CAPTURE: '1' };
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return physical(file).ref;
}
async function compile(nativeRoot, outputFile) {
  directory(nativeRoot); directory(path.dirname(outputFile));
  assert(!fs.existsSync(outputFile), 'Compiler output must be new');
  const req = createRequire(path.join(nativeRoot, 'package.json'));
  req('ts-node').register({ project: path.join(nativeRoot, 'tsconfig.json'), preferTsExts: true });
  const { runTolkCompiler } = req('@ton/tolk-js'), artifacts = {};
  process.chdir(nativeRoot);
  for (const role of ROLES) {
    const config = req(path.join(nativeRoot, `wrappers/${role}.compile.ts`)).compile;
    if (config.preCompileHook) await config.preCompileHook({});
    assert.equal(config.entrypoint, ENTRYPOINTS[role]);
    const result = await runTolkCompiler({ entrypointFileName: config.entrypoint,
      fsReadCallback: file => fs.readFileSync(path.resolve(nativeRoot, file), 'utf8'),
      withStackComments: config.withStackComments, withSrcLineComments: config.withSrcLineComments });
    assert.equal(result.status, 'ok', 'Independent native compilation failed');
    const code = Cell.fromBase64(result.codeBoc64);
    artifacts[role] = { entrypoint: config.entrypoint, hash: code.hash().toString('hex'), boc: code.toBoc().toString('base64'),
      tolkVersion: result.tolkVersion, sources: result.sourcesSnapshot.map(row => ({ path: row.filename, sha256: sha(row.contents) })) };
    process.stdout.write(`${role} ${artifacts[role].hash}\n`);
  }
  const importedModules = Object.fromEntries(Object.keys(require.cache).filter(file => file.startsWith(nativeRoot + path.sep))
    .sort().map(file => [file, physical(file).ref.sha256]));
  return writeJson(outputFile, { schema: 'tonswap-options-refund-independent-code-v1', runtime: process.execPath,
    runtimeSha256: physical(process.execPath).ref.sha256, artifacts, importedModules });
}

// Reuse the native release's maintained process-group owner. No detached child
// or signal/timeout is treated as successful evidence, even if Jest emitted JSON.
async function runPhase({ nativeRoot, argv, cwd, env, logPath, timeoutMs }) {
  // Loading the owner is synchronous: release tsx hooks before any phase await.
  // tsx unregister deletes overwritten TS handlers; retain prior loader state.
  const extensions = Object.getOwnPropertyDescriptors(require.extensions);
  const unregister = require('tsx/cjs/api').register();
  let processGroups;
  try { processGroups = require(path.join(nativeRoot, 'scripts/release/ownedProcessGroups.ts')); }
  finally { unregister(); Object.defineProperties(require.extensions, extensions); }
  const { OwnedProcessGroupRegistry, installOwnedProcessSignalDrain } = processGroups;
  const groups = new OwnedProcessGroupRegistry(), startedAt = new Date().toISOString();
  const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let group, timer, timedOut = false, wrapperError = null, result, drained = false, completionObserved = false;
  const receivedSignals = [], handlers = [], signalSource = new (require('node:events').EventEmitter)();
  const uninstall = installOwnedProcessSignalDrain(groups, () => groups.drain(), {
    signalSource, exit: code => { process.exitCode = code; },
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => { receivedSignals.push(signal); signalSource.emit(signal === 'SIGHUP' ? 'SIGTERM' : signal); };
    process.on(signal, handler); handlers.push([signal, handler]);
  }
  try {
    group = await groups.spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', fd, fd] }, 'Options fixture producer');
    result = await Promise.race([group.completion.then(value => { completionObserved = true; return value; }),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Error('Options fixture phase timed out')); }, timeoutMs); })]);
    if (result.error) wrapperError = result.error.message;
  } catch (error) { wrapperError = error.message; }
  finally {
    if (timer) clearTimeout(timer);
    try { await groups.drain(); drained = true; } catch (error) {
      const messages = value => [value.message, ...(Array.isArray(value.errors) ? value.errors.flatMap(messages) : [])];
      wrapperError = messages(error).join('; ');
      // A completed target's forbidden descendants may already have been
      // removed by stop(). Prove closure separately, retaining that failure.
      try { await groups.drain(); drained = true; } catch { /* Shared containment stays installed. */ }
    }
    if (group) result = group.targetCompletion || result;
    // Withhold uninstall on a cleanup failure: the shared signal owner retains
    // its keepalive and authenticated force-containment path in that case.
    if (drained) { uninstall(); for (const [signal, handler] of handlers) process.off(signal, handler); }
    fs.fsyncSync(fd); fs.closeSync(fd);
  }
  return { startedAt, finishedAt: new Date().toISOString(), pid: group?.targetPid ?? null, pgid: group?.pgid ?? null,
    exitCode: result?.code ?? null, childSignal: result?.signal ?? null, timedOut, wrapperError,
    childReaped: drained && !!result, processGroupDrained: drained,
    processGroupEmptyAtLeaderExit: drained && completionObserved && wrapperError === null,
    receivedSignals, drainSignalForwarded: receivedSignals.length > 0, ownedExecutionClosed: drained && !!result };
}
async function prepare({ nativeRoot, outputRoot, nodeSha256 }) {
  directory(nativeRoot); directory(path.dirname(outputRoot));
  assert(path.isAbsolute(outputRoot) && path.normalize(outputRoot) === outputRoot && !fs.existsSync(outputRoot), 'New absolute output root required');
  assert(HASH.test(nodeSha256) && physical(process.execPath).ref.sha256 === nodeSha256, 'Explicit current Node authority required');
  assert.deepEqual(process.execArgv, ['--no-turbo-fast-api-calls']); assert.equal(process.env.NODE_OPTIONS, undefined);
  assert(!outputRoot.startsWith(nativeRoot + path.sep) && !outputRoot.startsWith(path.resolve(__dirname, '../src') + path.sep), 'Preparation output must be outside native source and canonical fixtures');
  require('tsx/cjs/api').register();
  const req = createRequire(path.join(nativeRoot, 'package.json'));
  const { captureFirstReleaseJobInput } = req(path.join(nativeRoot, 'scripts/release/firstReleaseCandidate.ts'));
  const { firstReleaseExecutionIdentity } = req(path.join(nativeRoot, 'scripts/release/firstReleaseCommands.ts'));
  const { readFirstReleaseFixtureBuild } = req(path.join(nativeRoot, 'scripts/release/firstReleaseFixturePreflight.ts'));
  // This read-only admission fails before the expensive suite on missing/stale
  // deployment artifacts. Independent compilation below supplies fresh code.
  readFirstReleaseFixtureBuild(nativeRoot);
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  const captureDir = path.join(outputRoot, 'capture'); fs.mkdirSync(captureDir, { mode: 0o700 });
  const env = cleanEnvironment(), compileArgv = compilerCommand(process.execPath, nativeRoot, captureDir);
  const compileTerminal = await runPhase({ nativeRoot, argv: compileArgv, cwd: nativeRoot, env,
    logPath: path.join(captureDir, 'independent-compile.log'), timeoutMs: 300_000 });
  writeJson(path.join(captureDir, 'independent-compile-terminal.json'), { ...compileTerminal, argv: compileArgv,
    cwd: nativeRoot, environment: env, log: physical(path.join(captureDir, 'independent-compile.log')).ref });
  closed(compileTerminal);
  const compiled = JSON.parse(physical(path.join(captureDir, 'independent-compile.json')).bytes);
  const argv = producerCommand(process.execPath, captureDir);
  const capture = () => {
    const runtimeIdentity = firstReleaseExecutionIdentity(nativeRoot);
    const input = captureFirstReleaseJobInput({ id: 'contracts', dependsOn: [], packageRoot: nativeRoot,
      commands: [argv], executionIdentitySha256: runtimeIdentity, requiredOutputs: ['build'] });
    const fixtureSources = { ...runtimeClosure(nativeRoot) };
    for (const role of ROLES) for (const row of compiled.artifacts[role].sources)
      fixtureSources[row.path] = physical(path.join(nativeRoot, row.path)).ref.sha256;
    return { schema: 'tonswap-options-refund-producer-input-v1', input, runtimeIdentity, fixtureSources,
      buildCodes: Object.fromEntries(readFirstReleaseFixtureBuild(nativeRoot)), toolchain: physical(path.join(nativeRoot, 'build/toolchain.json')).ref,
      node: physical(process.execPath).ref, runner: physical(__filename).ref, independentCompiler: physical(__filename).ref,
      supervisor: physical(path.join(nativeRoot, 'scripts/release/ownedProcessGroups.ts')).ref };
  };
  const before = capture(), sourceBefore = writeJson(path.join(captureDir, 'source-before.json'), before);
  const terminal = await runPhase({ nativeRoot, argv, cwd: nativeRoot, env,
    logPath: path.join(captureDir, 'producer.log'), timeoutMs: 1_200_000 });
  const reportPath = path.join(captureDir, 'producer-result.json');
  let complete = false;
  try { closed(terminal); completeRun(JSON.parse(physical(reportPath).bytes), physical(path.join(captureDir, 'producer.log')).bytes.toString('utf8'), nativeRoot); complete = true; } catch { /* Retain the actual failed terminal below. */ }
  writeJson(path.join(captureDir, 'producer-launch.json'), { argv, cwd: nativeRoot, environment: env, pid: terminal.pid,
    startedAt: terminal.startedAt, sourceBefore });
  const terminalRef = writeJson(path.join(captureDir, 'producer-terminal.json'), { ...terminal, argv, cwd: nativeRoot, environment: env,
    log: physical(path.join(captureDir, 'producer.log')).ref, report: fs.existsSync(reportPath) ? physical(reportPath).ref : null, full55CasesPassed: complete });
  const after = capture(), sourceAfter = writeJson(path.join(captureDir, 'source-after.json'), after);
  const unchanged = require('node:util').isDeepStrictEqual(before, after);
  writeJson(path.join(captureDir, 'diagnostic.json'), { status: complete && unchanged ? 'PASS' : 'FAIL', producer: terminalRef,
    independentCompile: physical(path.join(captureDir, 'independent-compile-terminal.json')).ref, sourceBefore, sourceAfter,
    sourceUnchanged: unchanged, runtimeUnchanged: before.runtimeIdentity === after.runtimeIdentity,
    fixtureSourceUnchanged: require('node:util').isDeepStrictEqual(before.fixtureSources, after.fixtureSources) });
  assert(complete && unchanged, 'Native capture failed; retain its diagnostics and do not adopt');
  return refresh({ captureDir, nativeRoot, outputRoot: path.join(outputRoot, 'fixtures'), nodeSha256,
    sourceBeforeSha256: sourceBefore.sha256, compileSha256: physical(path.join(captureDir, 'independent-compile.json')).ref.sha256 });
}
async function main(argv) {
  if (argv[0] === 'prepare') {
    assert.deepEqual(argv.filter((_, i) => i % 2 === 1), ['--native-root', '--node-sha256', '--output-root']);
    assert.equal(argv.length, 7);
    return prepare({ nativeRoot: argv[2], nodeSha256: argv[4], outputRoot: argv[6] });
  }
  if (argv[0] === 'compile') {
    assert.deepEqual(argv.filter((_, i) => i % 2 === 1), ['--native-root', '--output-file']);
    assert.equal(argv.length, 5); return compile(argv[2], argv[4]);
  }
  assert.equal(argv[0], 'adopt', 'Use prepare or adopt; see README');
  return refresh(argumentsFor(argv.slice(1)));
}
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { refresh, prepare, main, argumentsFor, completeRun, closed, validateState, validateBoundaries,
  sourceClosure, runtimeClosure, producerCommand, compilerCommand, runPhase };
