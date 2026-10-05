import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cell } from '@ton/core';
import { perpsRiskFixtureFolder, readPerpsRiskFixtureProvenance } from './perps-risk-fixture';
import { producerSha256, assertPerpsStressChainConfig } from './perps-fixture-producer';

const output = process.argv[2];
assert(output && resolve(output) === output && !existsSync(output) && !process.argv[3],
  'Usage: refresh-perps-funded-web-fixture.ts <new-absolute-projection-directory>');
assert.equal(process.version, 'v26.10.0');
assert(process.execArgv.includes('--no-turbo-fast-api-calls'));
assert(!process.env.NODE_OPTIONS);
const indexerRoot = resolve(__dirname, '../..');
const inventory = () => {
  const files: Record<string, string> = {};
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith('.ts')) files[relative(indexerRoot, path)] = producerSha256(readFileSync(path));
    }
  };
  visit(join(indexerRoot, 'src'));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) files[name] = producerSha256(readFileSync(join(indexerRoot, name)));
  return files;
};
const sourceBefore = inventory();
const native = readPerpsRiskFixtureProvenance();
assert.equal(native.qualification, 'qualified-pure-build-target-closure');
const buildBindingJson=JSON.stringify(native.buildBinding,null,2)+'\n';
assert.equal(producerSha256(buildBindingJson),native.producerReceipt.build.sha256);
for (const [field, role] of Object.entries({engine:'PerpsEngine',pool:'DlmmPool',wallet:'JettonWallet',
  riskVault:'RiskVault',riskController:'RiskController'}))
  assert.equal(native[field+'CodeHash'], native.producerReceipt.compiled[role].codeHash);
mkdirSync(output, {mode: 0o700});
const result = spawnSync(process.execPath, ['--no-turbo-fast-api-calls', '--import', 'tsx',
  join(__dirname, 'ledger-perps-oracle-execution-test.ts')], {cwd: indexerRoot, encoding: 'utf8',
  env: {...process.env, PERPS_ORACLE_LEDGER_EXPORT_DIR: output}, maxBuffer: 32*1024*1024});
const log = Buffer.from(result.stdout + result.stderr);
writeFileSync(join(output, 'projector.log'), log, {flag: 'wx'});
process.stdout.write(log);
assert.equal(result.status, 0, 'Current original-transaction projection must pass completely');
assert.deepEqual(inventory(), sourceBefore, 'Indexer source changed during projection; recapture');
assert.deepEqual(readPerpsRiskFixtureProvenance(), native, 'Native evidence changed during projection');
const names = ['open-accepted', 'vault-rejected', 'policy-rejected', 'modify-accepted', 'profitable-close', 'gap-close', 'failed-close'];
const files: Record<string, string> = {};
const staged = new Map<string, Buffer>();
for (const name of names) {
  const filename = `${name}-ledger.json`, bytes = readFileSync(join(output, filename));
  const saved = JSON.parse(bytes.toString('utf8'));
  assertPerpsStressChainConfig(saved.chainConfig);
  for (const role of ['engine', 'pool', 'wallet', 'riskVault', 'riskController'])
    assert.equal(Cell.fromBase64(saved[role+'Code']).hash().toString('hex'), native[role+'CodeHash']);
  assert(saved.events.some((event: any) => event.kind === 'perps_operation' && event.settlement?.status === 'confirmed'));
  files[filename] = producerSha256(bytes); staged.set(filename, bytes);
}
const producerLog = Buffer.from(native.producerLog);
const provenance = {
  source: 'ton-indexer/src/scripts/ledger-perps-oracle-execution-test.ts from qualified current PerpsRiskAdmission VM15 stress400 captures',
  description: 'Unmodified original Sandbox transaction captures with independent strict indexer projection; local evidence, not deployed testnet history.',
  ...Object.fromEntries(['engine','pool','wallet','riskVault','riskController'].map(role => [role+'CodeHash', native[role+'CodeHash']])),
  sourceDirectory: output, nativeFixtureDirectory: perpsRiskFixtureFolder, files,
  qualification:'qualified-pure-build-target-closure', buildBinding:native.buildBinding, buildBindingJson,
  producerReceipt: native.producerReceipt, producerLogSha256: producerSha256(producerLog),
  projectorLogSha256: producerSha256(log), projectorSource: sourceBefore,
};
staged.set('producer.log', producerLog); staged.set('projector.log', log);
staged.set('build-binding.json',Buffer.from(buildBindingJson));
for (const artifact of Object.values(native.producerReceipt.compiled) as {file:string;sha256:string}[]) {
  const bytes=readFileSync(join(__dirname,'fixtures/capture-build/risk',artifact.file));
  assert.equal(producerSha256(bytes),artifact.sha256);
  staged.set(artifact.file,bytes);
}
staged.set('provenance.json', Buffer.from(JSON.stringify(provenance, null, 2)+'\n'));
const target = resolve(__dirname, '../../../tonswap_web/tests/fixtures/perps-funded-current');
mkdirSync(target, {recursive: true});
for (const [name, bytes] of staged) {mkdirSync(join(target,name,'..'),{recursive:true});writeFileSync(join(target, name), bytes);}
console.log(`Adopted ${names.length} current Perps browser projections: ${native.engineCodeHash}`);
