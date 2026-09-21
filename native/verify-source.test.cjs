'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { test } = require('node:test');
const V = require('./verify-source.cjs');
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ton-native-source-test-')));
  fs.cpSync(__dirname, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function mutate(dir, change) {
  const file = path.join(dir, 'source-lock.json'), value = JSON.parse(fs.readFileSync(file));
  change(value); fs.writeFileSync(file, JSON.stringify(value));
}
test('retained patch and full source overlay match the dependency lock', () => {
  const lock = V.loadLock(__dirname);
  const headers = fs.readFileSync(path.join(__dirname, lock.patch.path), 'utf8').split('\n').filter(line => line.startsWith('diff --git ')).map(line => /^diff --git a\/(.+) b\/\1$/.exec(line)?.[1]);
  assert.deepEqual(headers.sort(), lock.files.filter(row => row.operation === 'patch').map(row => row.path).sort());
});
test('changed patch is rejected before dependency preparation', t => {
  const dir = fixture(t); fs.appendFileSync(path.join(dir, 'patches/verified-admission.patch'), '\n'); assert.throws(() => V.loadLock(dir));
});
test('changed worker source cannot reuse the locked artifact identity', t => {
  const dir = fixture(t); fs.appendFileSync(path.join(dir, 'overlay/tonlib/tonlib/admission-worker.cpp'), '\n'); assert.throws(() => V.loadLock(dir));
});
test('missing authentic proof fixture is rejected', t => {
  const dir = fixture(t); fs.unlinkSync(path.join(dir, 'overlay/tonlib/test/fixtures/admission-proof/account-state.boc')); assert.throws(() => V.loadLock(dir));
});
test('overlay symlink is rejected even when its target has identical bytes', t => {
  const dir = fixture(t), file = path.join(dir, 'overlay/tonlib/ADMISSION.md'); fs.renameSync(file, file + '.target'); fs.symlinkSync('ADMISSION.md.target', file); assert.throws(() => V.loadLock(dir), /alias/);
});
test('overlay hardlink is rejected', t => {
  const dir = fixture(t), file = path.join(dir, 'overlay/tonlib/ADMISSION.md'); fs.linkSync(file, file + '.link'); assert.throws(() => V.loadLock(dir), /single-link/);
});
test('source lock rejects traversal and repeated output paths', t => {
  const dir = fixture(t); mutate(dir, lock => { lock.files[0].path = '../escape'; }); assert.throws(() => V.loadLock(dir));
  const other = fixture(t); mutate(other, lock => lock.files.push(lock.files[0])); assert.throws(() => V.loadLock(other));
});
test('absolute and ambiguous overlay paths cannot escape the dependency', () => {
  for (const value of ['/tmp/escape', '../escape', 'a/../b', 'a//b', 'a\\b', './a']) assert.throws(() => V.relative(value));
});
