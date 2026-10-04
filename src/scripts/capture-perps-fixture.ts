import assert from 'node:assert/strict';
import { mkdirSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERPS_PRODUCERS, type PerpsProducer, perpsProducerSourceInventory,
  producerSha256, assertCompletePerpsProducer } from './perps-fixture-producer';

async function main() {
  const producer = process.argv[2] as PerpsProducer, captureDirectory = process.argv[3];
  const observedConfigPath = producer==='directFeeObserved'?process.argv[4]:undefined;
  assert(producer!=='directFeeObserved'||(observedConfigPath&&resolve(observedConfigPath)===observedConfigPath),
    'Observed-price producer requires an absolute authenticated configuration input');
  assert(producer==='directFeeObserved'||!process.argv[4], 'Unexpected producer configuration input');
  const externalInputs=observedConfigPath?{[observedConfigPath]:producerSha256(readFileSync(observedConfigPath))}:{};
  assert(Object.hasOwn(PERPS_PRODUCERS, producer) && captureDirectory && resolve(captureDirectory) === captureDirectory,
    'Usage: pinned-node --no-turbo-fast-api-calls --import tsx capture-perps-fixture.ts <risk|wallets|browser|directFee|directFeeObserved|funding> <new-absolute-directory> [observed-config-path]');
  assert.equal(process.version, 'v26.5.1', 'Use the reviewed Node runtime');
  assert(process.execArgv.includes('--no-turbo-fast-api-calls'));
  assert(!process.env.NODE_OPTIONS, 'NODE_OPTIONS must be unset');
  assert(!existsSync(captureDirectory) && !existsSync(captureDirectory + '.log'), 'Evidence must be new');
  const parent = lstatSync(dirname(captureDirectory));
  assert(parent.isDirectory() && !parent.isSymbolicLink());
  const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
  const sourceBefore = perpsProducerSourceInventory(nativeRoot);
  const spec = PERPS_PRODUCERS[producer];
  const result = spawnSync(process.execPath, ['--no-turbo-fast-api-calls', 'node_modules/jest/bin/jest.js',
    '--config', 'jest.config.cjs', '--runInBand', '--runTestsByPath', spec.suite], {
    cwd: nativeRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1',
      TONSWAP_PERPS_RISK_FIXTURE_DIR: captureDirectory,
      TONSWAP_PERPS_EXECUTION_FIXTURE_DIR: captureDirectory,
      TONSWAP_PERPS_BROWSER_FIXTURE_DIR: captureDirectory,
      TONSWAP_REFERRAL_TRADE_PROOF_DIR: captureDirectory,
      TONSWAP_PERPS_DIRECT_FEE_OBSERVED_CONFIG: observedConfigPath??'',
      TONSWAP_PERPS_FUNDING_FIXTURE_DIR: captureDirectory },
  });
  const log = Buffer.from(result.stdout + result.stderr);
  writeFileSync(captureDirectory + '.log', log, { flag: 'wx', mode: 0o600 });
  process.stdout.write(log);
  assert.equal(result.status, 0, `Native ${producer} producer failed`);
  assertCompletePerpsProducer(log.toString('utf8'), producer);
  const currentSource = perpsProducerSourceInventory(nativeRoot);
  assert.deepEqual(currentSource, sourceBefore, 'Producer source changed during execution; recapture');
  for(const [path,hash] of Object.entries(externalInputs))assert.equal(producerSha256(readFileSync(path)),hash,
    'Observed fee configuration changed during execution');
  // Fresh independent compile, never a possibly stale build/ artifact.
  process.chdir(nativeRoot);
  const nativeRequire = createRequire(join(nativeRoot, 'package.json'));
  nativeRequire('ts-node/register/transpile-only');
  const { compile } = nativeRequire('@ton/blueprint');
  const roles = producer.startsWith('directFee') ? ['PerpsEngine', 'DlmmPool', 'JettonWallet', 'FeeRouter'] :
    producer === 'funding' ? ['PerpsEngine'] : ['PerpsEngine', 'DlmmPool', 'JettonWallet', 'RiskVault', 'RiskController'];
  mkdirSync(join(captureDirectory, 'current-compiled'), { mode: 0o700 });
  const compiled: Record<string, { file: string; sha256: string; codeHash: string }> = {};
  for (const role of roles) {
    const code = await compile(role), file = `current-compiled/${role}.json`;
    const bytes = Buffer.from(JSON.stringify({ hash: code.hash().toString('hex'), hex: code.toBoc().toString('hex') }) + '\n');
    writeFileSync(join(captureDirectory, file), bytes, { flag: 'wx', mode: 0o600 });
    compiled[role] = { file, sha256: producerSha256(bytes), codeHash: code.hash().toString('hex') };
  }
  const sourceAfter = perpsProducerSourceInventory(nativeRoot);
  assert.deepEqual(sourceAfter, sourceBefore, 'Producer source changed during independent compilation; recapture');
  const artifacts: Record<string, string> = {};
  const collect = (folder: string, prefix = '') => {
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name), stat = lstatSync(file), key = prefix + name;
      assert(!stat.isSymbolicLink(), 'Capture cannot contain symbolic links');
      if (stat.isDirectory()) collect(file, key + '/');
      else { assert(stat.isFile()); artifacts[key] = producerSha256(readFileSync(file)); }
    }
  };
  collect(captureDirectory);
  const receipt = { schema: 'tonswap-perps-fixture-producer-v1', producer, ...spec, captureDirectory,
    exitCode: result.status, runtime: { version: process.version, noTurboFastApiCalls: true,
      binarySha256: producerSha256(readFileSync(process.execPath)) },
    logSha256: producerSha256(log), sourceBefore, sourceAfter, externalInputs, compiled, artifacts };
  writeFileSync(join(captureDirectory, 'producer-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Qualified producer receipt: ${captureDirectory}/producer-receipt.json`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
