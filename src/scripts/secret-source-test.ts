import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSecretText } from '../config/secrets';
import { readDatabaseUrl } from '../config/database';
import { loadConfig } from '../config';

export function testSecretSources(): void {
  fs.mkdirSync('.local', { recursive: true });
  const root = fs.mkdtempSync(join(resolve('.local'), 'secret-source-test-'));
  const path = join(root, 'private-source');
  const env = { INDEXER_ADMIN_TOKEN_FILE: path };
  const read = () => readSecretText(env, 'INDEXER_ADMIN_TOKEN');
  const write = (value: string | Buffer) => fs.writeFileSync(path, value, { mode: 0o600 });
  const originalRead = fs.readSync;
  const mutableFs = require('node:fs') as typeof fs;
  const keys = ['INDEXER_DATABASE_URL', 'INDEXER_EDGE_KEY', 'INDEXER_ADMIN_TOKEN']
    .flatMap(name => [name, `${name}_FILE`]);
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(readSecretText({}, 'INDEXER_ADMIN_TOKEN'), undefined);
    assert.equal(readSecretText({ INDEXER_ADMIN_TOKEN: ' exact\nsecret ' }, 'INDEXER_ADMIN_TOKEN'), ' exact\nsecret ');
    for (const inline of ['', 'x'.repeat(65537), 'nul\0secret']) {
      assert.throws(() => readSecretText({ INDEXER_ADMIN_TOKEN: inline }, 'INDEXER_ADMIN_TOKEN'));
    }
    for (const inline of ['', 'chosen']) {
      assert.throws(() => readSecretText({ ...env, INDEXER_ADMIN_TOKEN: inline }, 'INDEXER_ADMIN_TOKEN'), /only one/);
    }
    for (const file of ['', 'relative', `${path}\0bad`, join(root, 'absent-do-not-disclose')]) {
      assert.throws(() => readSecretText({ INDEXER_ADMIN_TOKEN_FILE: file }, 'INDEXER_ADMIN_TOKEN'), error => {
        assert.equal(String(error), 'Error: The INDEXER_ADMIN_TOKEN_FILE secret could not be read safely.');
        return true;
      });
    }
    write('\ufeff exact\nsecret ');
    assert.equal(read(), '\ufeff exact\nsecret ', 'text transport must preserve BOM and whitespace');
    write('x'.repeat(65536)); assert.equal(read()?.length, 65536);
    for (const value of ['', 'x'.repeat(65537), Buffer.from([0xc3, 0x28]), 'nul\0secret']) {
      write(value); assert.throws(read);
    }
    write('private-test-value');
    fs.chmodSync(path, 0o640); assert.throws(read); fs.chmodSync(path, 0o600);
    const uid = process.getuid;
    assert(uid);
    try { process.getuid = () => uid() + 1; assert.throws(read); } finally { process.getuid = uid; }
    const linked = join(root, 'hard-link');
    fs.linkSync(path, linked); assert.throws(read); fs.unlinkSync(linked);
    const symbolic = join(root, 'symbolic-link');
    fs.symlinkSync(path, symbolic);
    assert.throws(() => readSecretText({ INDEXER_ADMIN_TOKEN_FILE: symbolic }, 'INDEXER_ADMIN_TOKEN'));
    assert.throws(() => readSecretText({ INDEXER_ADMIN_TOKEN_FILE: root }, 'INDEXER_ADMIN_TOKEN'));
    const fifo = join(root, 'fifo');
    execFileSync('mkfifo', [fifo], { stdio: 'pipe', timeout: 2000 });
    assert.throws(() => readSecretText({ INDEXER_ADMIN_TOKEN_FILE: fifo }, 'INDEXER_ADMIN_TOKEN'));

    for (const mutate of [
      () => fs.appendFileSync(path, 'growth'),
      () => fs.chmodSync(path, 0o640),
      () => { fs.renameSync(path, join(root, 'old-file')); write('private-test-value'); },
    ]) {
      write('private-test-value'); fs.chmodSync(path, 0o600);
      let first = true;
      mutableFs.readSync = ((...args: Parameters<typeof originalRead>) => {
        const count = (originalRead as Function)(...args);
        if (first) { first = false; mutate(); }
        return count;
      }) as typeof originalRead;
      try { assert.throws(read, /could not be read safely/); } finally { mutableFs.readSync = originalRead; }
    }
    write('private-test-value'); fs.chmodSync(path, 0o600);
    let captured: Buffer | undefined;
    mutableFs.readSync = ((...args: Parameters<typeof originalRead>) => {
      captured = args[1] as Buffer;
      return (originalRead as Function)(...args);
    }) as typeof originalRead;
    try { assert.equal(read(), 'private-test-value'); } finally { mutableFs.readSync = originalRead; }
    assert(captured && captured.every(byte => byte === 0), 'owned read buffer must be wiped');
    write(Buffer.from([0xc3, 0x28]));
    captured = undefined;
    mutableFs.readSync = ((...args: Parameters<typeof originalRead>) => {
      captured = args[1] as Buffer;
      return (originalRead as Function)(...args);
    }) as typeof originalRead;
    try { assert.throws(read); } finally { mutableFs.readSync = originalRead; }
    assert(captured && (captured as Buffer).every(byte => byte === 0), 'failed decoding must also wipe its buffer');
    write('start');
    let received = 0;
    mutableFs.readSync = ((...args: Parameters<typeof originalRead>) => {
      assert((args[1] as Buffer).length <= 65537);
      const count = (originalRead as Function)(...args);
      if (received === 0) fs.appendFileSync(path, 'x'.repeat(65537));
      received += count;
      return count;
    }) as typeof originalRead;
    try { assert.throws(read); } finally { mutableFs.readSync = originalRead; }
    assert(received <= 65537, 'growth after stat must not cause unbounded ingestion');

    write(' postgres://dummy:fixture@localhost/db\n');
    assert.equal(readDatabaseUrl({ INDEXER_DATABASE_URL_FILE: path }), 'postgres://dummy:fixture@localhost/db');
    write(' \n'); assert.throws(() => readDatabaseUrl({ INDEXER_DATABASE_URL_FILE: path }), /empty/);
    write('https://private-value');
    assert.throws(() => readDatabaseUrl({ INDEXER_DATABASE_URL_FILE: path }), error => {
      assert(!String(error).includes('private-value')); return true;
    });
    const base = loadConfig();
    write(' a'.repeat(16));
    process.env.INDEXER_EDGE_KEY_FILE = path;
    process.env.INDEXER_ADMIN_TOKEN_FILE = path;
    const configured = loadConfig();
    assert.equal(configured.edgeKey, ' a'.repeat(16));
    assert.equal(configured.adminToken, ' a'.repeat(16));
    assert.deepEqual({ ...configured, edgeKey: base.edgeKey, adminToken: base.adminToken }, base);
    assert.equal(process.env.INDEXER_EDGE_KEY, undefined, 'resolved credentials must not enter environment');
    write('short'); assert.throws(() => loadConfig(), /at least 32/);
    process.env.INDEXER_EDGE_KEY = 'x'.repeat(32);
    assert.throws(() => loadConfig(), /only one/);
    delete process.env.INDEXER_EDGE_KEY;
    write('x'.repeat(32));
    const next = loadConfig(); assert.equal(next.adminToken, 'x'.repeat(32), 'fresh config reload reads the selected source');
    const childEnvironment = { PATH: process.env.PATH, LANG: 'C', TMPDIR: tmpdir(),
      INDEXER_EDGE_KEY_FILE: path, INDEXER_ADMIN_TOKEN_FILE: path };
    for (const character of ['x', 'y']) {
      write(character.repeat(32));
      const code = `const c = require(${JSON.stringify(require.resolve('../config'))}).loadConfig();
        process.stdout.write(String(c.edgeKey === ${JSON.stringify(character.repeat(32))}
          && c.adminToken === c.edgeKey && process.env.INDEXER_EDGE_KEY === undefined
          && process.env.INDEXER_ADMIN_TOKEN === undefined
          && require('node:os').tmpdir() === ${JSON.stringify(tmpdir())}));`;
      assert.equal(execFileSync(process.execPath, [...process.execArgv, '-e', code],
        { env: childEnvironment, encoding: 'utf8', timeout: 5000 }), 'true',
      'fresh workers must preserve the caller temp directory and resolve only file selectors without exporting secrets');
    }
    fs.unlinkSync(path); assert.throws(() => loadConfig(), /could not be read safely/);
  } finally {
    mutableFs.readSync = originalRead;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  testSecretSources();
  process.stdout.write('secret sources and indexer consumers passed\n');
}
