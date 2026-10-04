'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const tool = require('./refresh-options-rejected-ingress-fixture.cjs');
const tsx = require('tsx/cjs/api');
const nativeRoot = path.resolve(__dirname, '../../tonswap_tolk');
function loaderState() {
  return { resolve: Module._resolveFilename, extensions: Object.getOwnPropertyDescriptors(require.extensions),
    sourceMapsEnabled: process.sourceMapsEnabled };
}
function assertLoaderState(before) {
  assert.equal(Module._resolveFilename, before.resolve, 'CJS resolver hook escaped phase loading');
  assert.deepEqual(Object.getOwnPropertyDescriptors(require.extensions), before.extensions, 'Extension loader state changed');
  assert.equal(process.sourceMapsEnabled, before.sourceMapsEnabled, 'Source-map state changed');
}
test('31 real owned phases preserve loader state, including concurrent calls under a pre-existing tsx loader', async t => {
  const directory = process.env.LOADER_REGRESSION_OUTPUT ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'options-loader-regression-'));
  if (!process.env.LOADER_REGRESSION_OUTPUT) t.after(() => fs.rmSync(directory,{recursive:true}));
  assert(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
  const initial = loaderState(), signals = Object.fromEntries(['SIGINT','SIGTERM','SIGHUP'].map(s => [s,process.listenerCount(s)]));
  const terminals = [];
  const invoke = async index => {
    const before = loaderState(), message = `owned-loader-phase-${index}`;
    const logPath = path.join(directory, `phase-${index}.log`);
    const terminal = await tool.runPhase({ nativeRoot,
      argv: [process.execPath, '--no-turbo-fast-api-calls', '-e', 'process.stdout.write(process.argv[1]+"\\n")', message],
      cwd: directory, env: { PATH: '/usr/bin:/bin', LANG:'C', LC_ALL:'C' }, logPath, timeoutMs:5000 });
    tool.closed(terminal);
    assert.equal(fs.readFileSync(logPath,'utf8'), message+'\n');
    assert.throws(() => process.kill(-terminal.pgid,0), {code:'ESRCH'});
    assertLoaderState(before);
    terminals.push({index,logPath,...terminal});
  };
  for (let index=1;index<=29;index++) { await invoke(index); assertLoaderState(initial); }
  const unregister = tsx.register();
  try {
    const existing = loaderState();
    await Promise.all([invoke(30),invoke(31)]);
    assertLoaderState(existing);
  } finally { unregister(); Object.defineProperties(require.extensions, initial.extensions); }
  assertLoaderState(initial);
  await assert.rejects(tool.runPhase({nativeRoot:path.join(directory,'missing-native'),
    argv:[process.execPath,'-e','process.exit(0)'],cwd:directory,env:{PATH:'/usr/bin:/bin'},
    logPath:path.join(directory,'must-not-open.log'),timeoutMs:5000}), {code:'MODULE_NOT_FOUND'});
  assert(!fs.existsSync(path.join(directory,'must-not-open.log')));
  assertLoaderState(initial);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP']) assert.equal(process.listenerCount(signal), signals[signal]);
  fs.writeFileSync(path.join(directory,'actual-terminals.json'),JSON.stringify({status:'PASS',realPhases:31,
    sequentialPhases:29,concurrentExistingLoaderPhases:2,missingOwnerImportRestoredState:true,
    resolverUnchanged:true,extensionsUnchanged:true,sourceMapsUnchanged:true,signalListenersUnchanged:true,
    terminals:terminals.sort((a,b)=>a.index-b.index)},null,2)+'\n',{flag:'wx',mode:0o600});
});
