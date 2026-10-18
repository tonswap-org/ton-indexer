import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLiteserverPool } from '../data/liteserverPool';
const key = Buffer.alloc(32, 3).toString('base64');
const dir = mkdtempSync(join(tmpdir(), 'indexer-pool-test-'));
try {
  const file = join(dir, 'pool.json');
  writeFileSync(file, JSON.stringify({ liteservers: [{ ip: 2130706433, port: 3030, id: { key } }] }));
  const parsed = loadLiteserverPool(file);
  assert.equal(parsed[0].host, '127.0.0.1'); assert.equal(parsed[0].port, 3030); assert.ok(parsed[0].publicKey.equals(Buffer.alloc(32, 3)));
  assert.deepEqual(loadLiteserverPool(`127.0.0.1:3030:${key}`), parsed);
  assert.equal(loadLiteserverPool(`[::1]:3030:${key}`)[0].host, '[::1]');
  assert.equal(loadLiteserverPool(`127.0.0.1:3030:${key},127.0.0.1:3030:${key}`).length, 1);
  for (const value of [undefined, '', ' ', 'https://ton.org/global.config.json', 'http://localhost/pool.json', './pool.json',
    `host:0:${key}`, `host:65536:${key}`, 'host:1234:invalid', `host:1234:${key},`]) assert.throws(() => loadLiteserverPool(value), /LITESERVER_POOL/);
  writeFileSync(file, '{"liteservers":[]}'); assert.throws(() => loadLiteserverPool(file), /empty/);
  writeFileSync(file, '{"liteservers":[{}]}'); assert.throws(() => loadLiteserverPool(file));
  console.log('Liteserver pool: local file and inline validation pass; URLs, missing and empty configurations are rejected');
} finally { rmSync(dir, { recursive: true, force: true }); }
