'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Cell } = require('@ton/core');
const tool = require('./refresh-options-rejected-ingress-fixture.cjs');
require('tsx/cjs/api').register();
const { readOptionFactoryConfig } = require('../src/ledger/optionLifecycleState.ts');
const nativeRoot = path.resolve(__dirname, '../../tonswap_tolk');
const fixtureRoot = path.resolve(__dirname, '../src/scripts/fixtures');
const boc = fs.readFileSync(path.join(fixtureRoot, 'options-factory-rejected-ingress.boc'));
const provenance = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'options-factory-rejected-ingress.provenance.json')));
const sha = value => createHash('sha256').update(value).digest('hex');
const captureTitle = 'refunds the complete deposit when a buy sends more than the quoted premium';

// These deliberately synthetic execution summaries test rejection boundaries;
// only a real complete producer passed through the CLI can refresh a fixture.
function report() {
  return { success: true, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0,
    numPendingTestSuites: 0, numTotalTests: 55, numPassedTests: 55, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: path.join(nativeRoot, 'tests/options/OptionFactory.spec.ts'), status: 'passed',
      assertionResults: Array.from({ length: 55 }, (_, index) => ({ status: 'passed', fullName: `Boundary unit case ${index}`,
        title: index === 0 ? captureTitle : `case ${index}` })) }] };
}
const log = `OPTIONS_REFUND_FACTORY_STATE ${boc.toString('base64')}\nOPTIONS_REFUND_FACTORY_CODE_HASH ${provenance.factoryCodeHash}\nTest Suites: 1 passed, 1 total\nTests:       55 passed, 55 total\n`;
test('complete log extraction preserves the original BOC bytes', () => {
  const result = tool.completeRun(report(), log, nativeRoot);
  assert(result.boc.equals(boc)); assert.equal(result.factoryCodeHash, provenance.factoryCodeHash);
});
for (const [label, change] of [
  ['failed run', value => { value.success = false; }],
  ['filtered run', value => { value.numPassedTests = 1; value.numPendingTests = 54; }],
  ['skipped suite', value => { value.numPendingTestSuites = 1; }],
  ['todo', value => { value.numTodoTests = 1; }],
  ['wrong suite', value => { value.testResults[0].name = path.join(nativeRoot, 'tests/options/Other.spec.ts'); }],
  ['truncated assertions', value => { value.testResults[0].assertionResults.pop(); }],
  ['pending assertion', value => { value.testResults[0].assertionResults[54].status = 'pending'; }],
  ['duplicated assertions', value => { value.testResults[0].assertionResults[54] = value.testResults[0].assertionResults[0]; }],
  ['missing capture test', value => { value.testResults[0].assertionResults[0].title = 'different case'; }],
]) test(`rejects ${label}`, () => {
  const value = report(); change(value); assert.throws(() => tool.completeRun(value, log, nativeRoot));
});
for (const [label, changed] of [
  ['truncated log', log.replace(/^Test Suites:.*$/m, '')],
  ['appended failure summary', log + 'Test Suites: 1 failed, 1 total\nTests: 1 failed, 1 total\n'],
  ['failed suite prefix', 'FAIL tests/options/Other.spec.ts\n' + log],
  ['duplicate capture', log + `OPTIONS_REFUND_FACTORY_STATE ${boc.toString('base64')}\n`],
  ['missing code marker', log.replace(/^OPTIONS_REFUND_FACTORY_CODE_HASH.*$/m, '')],
  ['malformed BOC', log.replace(boc.toString('base64'), 'YWJj')],
]) test(`rejects ${label}`, () => assert.throws(() => tool.completeRun(report(), changed, nativeRoot)));

function validTerminal() {
  return { exitCode: 0, childSignal: null, timedOut: false, wrapperError: null, childReaped: true,
    processGroupDrained: true, processGroupEmptyAtLeaderExit: true, ownedExecutionClosed: true,
    receivedSignals: [], drainSignalForwarded: false, pid: 123, startedAt: '2026-09-28T01:00:00Z', finishedAt: '2026-09-28T01:01:00Z' };
}
for (const [key, value] of Object.entries({ exitCode: 1, childSignal: 'SIGTERM', timedOut: true, wrapperError: 'cleanup failed',
  childReaped: false, processGroupDrained: false, processGroupEmptyAtLeaderExit: false, ownedExecutionClosed: false,
  receivedSignals: ['SIGTERM'], drainSignalForwarded: true, pid: null, finishedAt: '2026-09-28T00:00:00Z' })) {
  test(`rejects unsuccessful execution ${key}`, () => assert.throws(() => tool.closed({ ...validTerminal(), [key]: value })));
}
function artifactsForState() {
  const state = Cell.fromBoc(boc)[0], config = state.refs[0].refs[1];
  return { OptionFactory: { hash: provenance.factoryCodeHash }, JettonWallet: { hash: config.refs[2].refs[0].hash().toString('hex') },
    ShoutOption: { hash: config.refs[1].refs[0].hash().toString('hex') }, OutperformanceOption: { hash: config.refs[1].refs[1].hash().toString('hex') } };
}
test('retained genuine state passes the current strict ABI/receipt checks', () => {
  tool.validateState(tool.completeRun(report(), log, nativeRoot), artifactsForState(), readOptionFactoryConfig);
});
for (const role of ['OptionFactory', 'JettonWallet', 'ShoutOption', 'OutperformanceOption']) {
  test(`rejects a different embedded/Factory ${role} code identity`, () => {
    const artifacts = artifactsForState(); artifacts[role].hash = '0'.repeat(64);
    assert.throws(() => tool.validateState(tool.completeRun(report(), log, nativeRoot), artifacts, readOptionFactoryConfig));
  });
}
test('output must be new, explicit, and external to canonical fixtures', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-output-'));
  try {
    assert.throws(() => tool.refresh({ captureDir: base, nativeRoot, outputRoot: base, nodeSha256: 'a'.repeat(64),
      sourceBeforeSha256: 'b'.repeat(64), compileSha256: 'c'.repeat(64) }), /New absolute output/);
    assert.throws(() => tool.refresh({ captureDir: base, nativeRoot, outputRoot: path.join(fixtureRoot, 'must-not-create'),
      nodeSha256: 'a'.repeat(64), sourceBeforeSha256: 'b'.repeat(64), compileSha256: 'c'.repeat(64) }), /preparation output/);
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'must-not-create')), false);
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('external adoption requires separately selected source and compiler output pins', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-authority-'));
  try {
    assert.throws(() => tool.refresh({ captureDir: base, nativeRoot, outputRoot: path.join(base, 'output'), nodeSha256: 'a'.repeat(64) }), /selected producer/);
    assert.equal(fs.existsSync(path.join(base, 'output')), false);
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('CLI rejects reordered, missing, or extra options before any preparation', async () => {
  await assert.rejects(tool.main(['prepare', '--native-root', nativeRoot, '--output-root', '/tmp/nope']), /deep-equal/);
  assert.throws(() => tool.argumentsFor(['--capture-dir', '/tmp/capture']), /Use --capture-dir/);
  await assert.rejects(tool.main(['other']), /Use prepare or adopt/);
});
test('prepare rejects an untrusted Node before creating output', async () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-node-'));
  try {
    await assert.rejects(tool.prepare({ nativeRoot, outputRoot: path.join(base, 'new'), nodeSha256: '0'.repeat(64) }), /Node authority/);
    assert.equal(fs.existsSync(path.join(base, 'new')), false);
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('owned transport preserves the real exit code and drains a successful process', async () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-process-'));
  try {
    const result = await tool.runPhase({ nativeRoot, argv: [process.execPath, '-e', 'console.log("actual child");'],
      cwd: base, env: { PATH: process.env.PATH }, logPath: path.join(base, 'pass.log'), timeoutMs: 5_000 });
    tool.closed(result); assert.equal(fs.readFileSync(path.join(base, 'pass.log'), 'utf8'), 'actual child\n');
    assert.throws(() => process.kill(-result.pgid, 0), { code: 'ESRCH' });
    const failure = await tool.runPhase({ nativeRoot, argv: [process.execPath, '-e', 'process.exit(7)'],
      cwd: base, env: { PATH: process.env.PATH }, logPath: path.join(base, 'fail.log'), timeoutMs: 5_000 });
    assert.equal(failure.exitCode, 7); assert.equal(failure.ownedExecutionClosed, true); assert.throws(() => tool.closed(failure));
    assert.throws(() => process.kill(-failure.pgid, 0), { code: 'ESRCH' });
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('owned timeout rejects a running producer and proves its group absent', async () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-timeout-'));
  try {
    const result = await tool.runPhase({ nativeRoot, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      cwd: base, env: { PATH: process.env.PATH }, logPath: path.join(base, 'timeout.log'), timeoutMs: 100 });
    assert.equal(result.timedOut, true); assert.equal(result.ownedExecutionClosed, true); assert.throws(() => tool.closed(result));
    assert.throws(() => process.kill(-result.pgid, 0), { code: 'ESRCH' });
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('zero target exit with a surviving descendant is rejected even after successful cleanup', async () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-descendant-'));
  try {
    const source = 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}).unref();';
    const result = await tool.runPhase({ nativeRoot, argv: [process.execPath, '-e', source],
      cwd: base, env: { PATH: process.env.PATH }, logPath: path.join(base, 'descendant.log'), timeoutMs: 5_000 });
    assert.equal(result.exitCode, 0);
    assert.match(result.wrapperError, /background descendants are forbidden/);
    assert.equal(result.processGroupEmptyAtLeaderExit, false); assert.throws(() => tool.closed(result));
    assert.throws(() => process.kill(-result.pgid, 0), { code: 'ESRCH' });
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('changed before/after native identity is rejected before file or compiler access', () => {
  assert.throws(() => tool.validateBoundaries({ schema: 'tonswap-options-refund-producer-input-v1', fixtureSources: { wallet: 'a' } },
    { schema: 'tonswap-options-refund-producer-input-v1', fixtureSources: { wallet: 'b' } }, nativeRoot, '/capture', 'a'.repeat(64)), /changed during capture/);
});
test('compiler closure rejects omitted roles, missing transitive inputs and changed source bytes', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-compiler-'));
  try {
    const entries = { OptionFactory: 'contracts/options/factory.tolk', JettonWallet: 'contracts/shared/jetton/jetton_wallet.generated.tolk',
      JettonRoot: 'contracts/shared/jetton/jetton_root.generated.tolk', ShoutOption: 'contracts/options/shout_option.tolk',
      OutperformanceOption: 'contracts/options/outperformance_option.tolk',
      OptionSeriesManager: 'contracts/options/series_manager.tolk', OptionVault: 'contracts/options/vault.tolk',
      VolIndex: 'contracts/volatility/vol_index.tolk' };
    const code = new Cell(), artifacts = Object.fromEntries(Object.entries(entries).map(([role, entrypoint]) => [role,
      { entrypoint, boc: code.toBoc().toString('base64'), hash: code.hash().toString('hex'), tolkVersion: 'test-only',
        sources: [{ path: entrypoint, sha256: sha('expected') }] }]));
    const before = { buildCodes: Object.fromEntries(Object.keys(entries).map(role => [role, code.hash().toString('hex')])) };
    assert.throws(() => tool.sourceClosure(base, { artifacts: { OptionFactory: artifacts.OptionFactory } }, before, {}), /eight-role/);
    const binding = { target: entries.OptionFactory, tolkVersion: 'test-only', sources: [
      { path: entries.OptionFactory, sha256: sha('expected') }, { path: 'contracts/omitted.tolk', sha256: sha('other') }] };
    assert.throws(() => tool.sourceClosure(base, { artifacts }, before, { artifactBindings: [binding] }), /truncated compiler/);
    binding.sources.pop(); fs.mkdirSync(path.join(base, 'contracts/options'), { recursive: true });
    fs.writeFileSync(path.join(base, entries.OptionFactory), 'changed');
    assert.throws(() => tool.sourceClosure(base, { artifacts }, before, { artifactBindings: [binding] }), /Compiler source changed/);
  } finally { fs.rmSync(base, { recursive: true }); }
});
test('an actual signal retains failure and owned cleanup before supervisor exit', async () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-adopter-signal-'));
  try {
    const source = `const t=require(${JSON.stringify(require.resolve('./refresh-options-rejected-ingress-fixture.cjs'))});
      t.runPhase({nativeRoot:${JSON.stringify(nativeRoot)},argv:[process.execPath,'-e','console.log("ready");setInterval(()=>{},1000)'],
        cwd:${JSON.stringify(base)},env:{PATH:process.env.PATH},logPath:${JSON.stringify(path.join(base, 'child.log'))},timeoutMs:5000})
        .then(r=>require('node:fs').writeFileSync(${JSON.stringify(path.join(base, 'result.json'))},JSON.stringify(r)));`;
    const child = spawn(process.execPath, ['--no-turbo-fast-api-calls', '-e', source], { stdio: 'pipe' });
    const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
    const until = Date.now() + 5_000;
    while ((!fs.existsSync(path.join(base, 'child.log')) || !fs.readFileSync(path.join(base, 'child.log'), 'utf8').includes('ready')) && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert(fs.readFileSync(path.join(base, 'child.log'), 'utf8').includes('ready'));
    child.kill('SIGTERM');
    assert.deepEqual(await completed, { code: 143, signal: null });
    const result = JSON.parse(fs.readFileSync(path.join(base, 'result.json')));
    assert.deepEqual(result.receivedSignals, ['SIGTERM']); assert.equal(result.ownedExecutionClosed, true);
    assert.throws(() => tool.closed(result)); assert.throws(() => process.kill(-result.pgid, 0), { code: 'ESRCH' });
  } finally { fs.rmSync(base, { recursive: true }); }
});

require('./refresh-options-loader-registration.test.cjs');
