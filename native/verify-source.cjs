'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function relative(name) {
  assert(typeof name === 'string' && name.length > 0 && !path.isAbsolute(name));
  assert(name.split('/').every(part => part && part !== '.' && part !== '..') && !name.includes('\\'));
  return name;
}
function physical(root, name) {
  const file = path.join(root, relative(name));
  assert.equal(fs.realpathSync(file), file, 'Source alias is forbidden');
  const before = fs.lstatSync(file);
  assert(before.isFile() && before.nlink === 1, 'Physical single-link file required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) assert(before[key] === after[key] && before[key] === current[key]);
    return { bytes, sha256: sha(bytes), size: bytes.length, mode: before.mode & 511 };
  } finally { fs.closeSync(fd); }
}
function loadLock(nativeRoot) {
  const lock = JSON.parse(physical(nativeRoot, 'source-lock.json').bytes);
  assert.equal(lock.schema, 'tonswap-native-admission-source-lock-v1');
  assert(/^[a-f0-9]{40}$/.test(lock.upstream.commit));
  assert.equal(new Set(lock.files.map(row => relative(row.path))).size, lock.files.length);
  for (const row of lock.files) {
    assert(['patch', 'add'].includes(row.operation));
    assert(/^[a-f0-9]{64}$/.test(row.sha256));
    assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.mode === 420);
    if (row.operation === 'patch') assert(/^[a-f0-9]{64}$/.test(row.beforeSha256));
  }
  for (const module of lock.upstream.submodules) {
    relative(module.path); assert(/^[a-f0-9]{40}$/.test(module.commit));
    assert.equal(typeof module.initialized, 'boolean');
  }
  const patch = physical(nativeRoot, lock.patch.path);
  assert.equal(patch.sha256, lock.patch.sha256); assert.equal(patch.size, lock.patch.bytes);
  for (const row of lock.files.filter(row => row.operation === 'add')) {
    const file = physical(nativeRoot, 'overlay/' + row.path);
    assert.equal(file.sha256, row.sha256, row.path); assert.equal(file.size, row.bytes); assert.equal(file.mode, row.mode);
  }
  return lock;
}
function git(root, ...args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_TERMINAL_PROMPT','GIT_NO_REPLACE_OBJECTS','GIT_OPTIONAL_LOCKS'].includes(key)) delete env[key];
  return execFileSync('/usr/bin/git', ['-C', root, ...args], { env, maxBuffer: 8 * 1024 * 1024 });
}
function verifySource(nativeRoot, sourceRoot) {
  nativeRoot = fs.realpathSync(nativeRoot); sourceRoot = fs.realpathSync(sourceRoot);
  const lock = loadLock(nativeRoot);
  assert.equal(git(sourceRoot, 'rev-parse', 'HEAD').toString().trim(), lock.upstream.commit, 'Official TON commit differs');
  assert.equal(git(sourceRoot, 'diff', '--name-only', '--no-ext-diff', 'HEAD').toString().trim().split('\n').filter(Boolean).sort().join('\n'), lock.files.filter(row => row.operation === 'patch').map(row => row.path).sort().join('\n'), 'Unexpected upstream source delta');
  assert.deepEqual(git(sourceRoot, 'ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort(), lock.files.filter(row => row.operation === 'add').map(row => row.path).sort(), 'Unexpected added source');
  const observed = git(sourceRoot, 'submodule', 'status', '--recursive').toString().trimEnd().split('\n').map(line => {
    const match = /^([- +U])([a-f0-9]{40}) (\S+)/.exec(line); assert(match && ['-', ' '].includes(match[1]), 'Dirty or conflicting submodule');
    return { path: match[3], commit: match[2], initialized: match[1] === ' ' };
  });
  assert.deepEqual(observed, lock.upstream.submodules, 'Submodule identity differs');
  for (const module of observed.filter(module => module.initialized)) assert.equal(git(path.join(sourceRoot, module.path), 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none').toString(), '', 'Submodule source is dirty');
  for (const row of lock.files) {
    const file = physical(sourceRoot, row.path);
    assert.equal(file.sha256, row.sha256, row.path); assert.equal(file.size, row.bytes); assert.equal(file.mode, row.mode);
    if (row.operation === 'patch') assert.equal(sha(git(sourceRoot, 'show', 'HEAD:' + row.path)), row.beforeSha256, 'Original source blob differs');
  }
  return { schema: 'tonswap-native-admission-source-inspection-v1', verified: true, sourceRoot, officialCommit: lock.upstream.commit, patchFiles: lock.files.filter(row => row.operation === 'patch').length, overlayFiles: lock.files.filter(row => row.operation === 'add').length, qualificationClaim: false };
}
if (require.main === module) {
  assert.equal(process.argv.length, 3, 'Usage: node native/verify-source.cjs /absolute/prepared-ton-source');
  assert(path.isAbsolute(process.argv[2]));
  process.stdout.write(JSON.stringify(verifySource(__dirname, process.argv[2])) + '\n');
}
module.exports = { loadLock, physical, relative, verifySource };
