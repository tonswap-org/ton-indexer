import assert from 'node:assert/strict';
import { constants, closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERPS_PRODUCERS, type PerpsProducer, producerSha256 } from './perps-fixture-producer';

/** Retain producer artifacts under the deliberately adopted common manifest.
 * A single fixture adopter cannot replace that shared build authority. */
export function retainPerpsCaptureBuild(source: string, producer: PerpsProducer, receipt: any) {
  const common = join(__dirname, 'fixtures/capture-build');
  const manifest = join(common, 'manifest.json');
  assert(existsSync(manifest), 'Adopt the reviewed common pure-build manifest before individual fixtures');
  assert(lstatSync(manifest).isFile() && !lstatSync(manifest).isSymbolicLink() && lstatSync(manifest).nlink === 1);
  assert.equal(producerSha256(readFileSync(manifest)), receipt.build.manifestSha256,
    'Producer manifest differs from the deliberately adopted common build');
  const directory = join(common, producer);
  for (const path of [common, directory, join(directory, 'current-compiled')]) {
    if (!existsSync(path)) mkdirSync(path);
    assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Retained capture directory must be physical');
  }
  const retain = (relative: string, expectedHash: string) => {
    const bytes = readFileSync(join(source, relative));
    assert.equal(producerSha256(bytes), expectedHash, `Original producer artifact changed: ${relative}`);
    const destination = join(directory, relative);
    const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      assert(stat.isFile() && stat.nlink === 1, 'Retained artifact must be a physical single-link file');
      ftruncateSync(fd, 0);
      writeFileSync(fd, bytes);
    } finally { closeSync(fd); }
  };
  retain('build-binding.json', receipt.build.sha256);
  for (const artifact of Object.values(receipt.compiled) as { file: string; sha256: string }[])
    retain(artifact.file, artifact.sha256);
}

function main() {
  const producer = process.argv[2] as PerpsProducer, directory = process.argv[3];
  assert(Object.hasOwn(PERPS_PRODUCERS, producer) && directory && resolve(directory) === directory && !process.argv[4],
    'Usage: capture-perps-fixture.ts <risk|wallets|browser|directFee|funding> <new-absolute-directory>');
  assert(!process.env.NODE_OPTIONS, 'NODE_OPTIONS must be unset');
  assert.equal(process.version, 'v26.10.0', 'Use the reviewed native capture runtime');
  const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
  const runner = join(nativeRoot, 'tests/helpers/captureRun.ts');
  assert(existsSync(runner), 'The native pure-build capture CLI must be available on master');
  const result = spawnSync(process.execPath, ['--require', 'ts-node/register/transpile-only', runner, producer, directory],
    { cwd: nativeRoot, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Native pure-build capture failed');
}
if (require.main === module) main();
