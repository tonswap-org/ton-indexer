import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readDatabaseUrl, readSecretText } from '../src/secrets.js';
import { migrateFromEnvironment } from '../src/migrate.js';

const mockPostgres = vi.hoisted(() => vi.fn());
vi.mock('../src/db.js', () => ({ postgres: mockPostgres }));
const names = ['DATABASE_URL', 'DATA_ENCRYPTION_KEY', 'INDEXER_API_KEY', 'TON_RPC_API_KEY',
  'COINGECKO_API_KEY', 'VAPID_PRIVATE_KEY'] as const;
const base = fileURLToPath(new URL('../../../.local/secret-source-test-fixtures/', import.meta.url));
let root: string;
beforeAll(() => fs.mkdirSync(base, { recursive: true, mode: 0o700 }));
beforeEach(() => { root = fs.mkdtempSync(join(base, 'reader-')); mockPostgres.mockReset(); });
afterEach(() => vi.restoreAllMocks());
const file = (value: string | Buffer = 'public dummy value') => {
  const path = join(root, 'secret'); fs.writeFileSync(path, value, { flag: 'wx', mode: 0o600 }); return path;
};
const selected = (path: string) => ({ INDEXER_API_KEY_FILE: path });
const read = (path: string) => readSecretText(selected(path), 'INDEXER_API_KEY');

describe('explicit private-file secret selection', () => {
  it.each(names)('%s permits absence only when optional and rejects every defined-empty/conflicting selection', name => {
    expect(readSecretText({}, name)).toBeUndefined();
    expect(() => readSecretText({}, name, true)).toThrow(`Configure ${name} or ${name}_FILE.`);
    const open = vi.spyOn(fs, 'openSync');
    for (const env of [{ [name]: '' }, { [`${name}_FILE`]: '' },
      { [name]: 'public-inline', [`${name}_FILE`]: 'missing' }, { [name]: '', [`${name}_FILE`]: 'missing' },
      { [name]: 'public-inline', [`${name}_FILE`]: '' }, { [name]: '', [`${name}_FILE`]: '' }]) {
      expect(() => readSecretText(env, name)).toThrow(name);
    }
    expect(open).not.toHaveBeenCalled();
  });
  it('preserves spaces, newlines and BOM in valid UTF-8 instead of trimming or normalizing', () => {
    const value = '\ufeff public\nfixture\r\n ';
    expect(read(file(value))).toBe(value);
    expect(readSecretText({ INDEXER_API_KEY: value }, 'INDEXER_API_KEY')).toBe(value);
  });
  it('accepts exactly 64 KiB of UTF-8 bytes and rejects oversized inline or file sources', () => {
    const boundary = 'é'.repeat(32768), path = file(boundary);
    expect(read(path)).toBe(boundary);
    expect(readSecretText({ INDEXER_API_KEY: boundary }, 'INDEXER_API_KEY')).toBe(boundary);
    fs.appendFileSync(path, 'x'); expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
    expect(() => readSecretText({ INDEXER_API_KEY: boundary + 'x' }, 'INDEXER_API_KEY')).toThrow('INDEXER_API_KEY');
  });
  it.each([Buffer.alloc(0), Buffer.from([0]), Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])])(
    'refuses empty, NUL or malformed UTF-8 files', value => expect(() => read(file(value))).toThrow('INDEXER_API_KEY_FILE'));
  it('refuses NUL in inline text too', () => {
    expect(() => readSecretText({ INDEXER_API_KEY: 'public\0dummy' }, 'INDEXER_API_KEY')).toThrow('INDEXER_API_KEY');
  });
  it('refuses relative/NUL paths before opening and scrubs the selected path, value and raw filesystem errors', () => {
    const open = vi.spyOn(fs, 'openSync');
    for (const path of ['relative-public-sensitive-label', '/public-sensitive-label\0suffix']) expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
    expect(open).not.toHaveBeenCalled();
    const path = join(root, 'public-sensitive-label');
    try { read(path); expect.fail('missing source accepted'); }
    catch (error) {
      expect((error as Error).message).toBe('INDEXER_API_KEY_FILE must select a stable private UTF-8 file of 1..65536 bytes owned by this process user.');
      expect((error as Error).message).not.toContain(path);
      expect((error as Error).message).not.toContain('ENOENT');
    }
    expect(() => readSecretText({ INDEXER_API_KEY: 'public fallback', INDEXER_API_KEY_FILE: path }, 'INDEXER_API_KEY')).toThrow('Configure only one');
  });
  it('refuses final-component symlinks, multiply linked files and directories', () => {
    const original = file(), linked = join(root, 'link'); fs.symlinkSync(original, linked);
    expect(() => read(linked)).toThrow('INDEXER_API_KEY_FILE');
    fs.linkSync(original, join(root, 'hardlink'));
    expect(() => read(original)).toThrow('INDEXER_API_KEY_FILE');
    expect(() => read(root)).toThrow('INDEXER_API_KEY_FILE');
  });
  it('opens a FIFO nonblocking and refuses it before reading', () => {
    const fifo = join(root, 'fifo');
    expect(spawnSync('/usr/bin/mkfifo', [fifo], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000 }).status).toBe(0);
    const readCall = vi.spyOn(fs, 'readSync');
    expect(() => read(fifo)).toThrow('INDEXER_API_KEY_FILE'); expect(readCall).not.toHaveBeenCalled();
  });
  it.each([0o640, 0o604, 0o666])('refuses nonprivate file permissions %s', mode => {
    const path = file(); fs.chmodSync(path, mode); expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
  });
  it('refuses a different file owner before reading', () => {
    const path = file(), actual = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd: number) => {
      const s = actual(fd, { bigint: true });
      return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: s.uid + 1n });
    });
    const readCall = vi.spyOn(fs, 'readSync');
    expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE'); expect(readCall).not.toHaveBeenCalled();
  });
  it.each(['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)(
    'refuses descriptor %s changes across ingestion', field => {
      const path = file(), actual = fs.fstatSync; let calls = 0;
      vi.spyOn(fs, 'fstatSync').mockImplementation((fd: number) => {
        const s = actual(fd, { bigint: true }); calls++;
        return calls === 2 ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { [field]: s[field] + 1n }) : s;
      });
      expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
    });
  it('refuses a replaced path even when the original descriptor and bytes remain stable', () => {
    const path = file(), actual = fs.readSync; let replaced = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = actual(...args);
      if (!replaced) { replaced = true; fs.renameSync(path, path + '.retained-original'); fs.writeFileSync(path, 'public dummy value', { flag: 'wx', mode: 0o600 }); }
      return count;
    });
    expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
  });
  it('caps ingestion after file growth and wipes the temporary buffer on rejection', () => {
    const path = file('x'), actual = fs.readSync; let buffer: Buffer | undefined, grown = false, ingested = 0;
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      buffer = args[1] as Buffer;
      if (!grown) { grown = true; fs.appendFileSync(path, Buffer.alloc(128 * 1024, 0x41)); }
      const count = actual(...args); ingested += count; return count;
    });
    expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
    expect(ingested).toBe(65537); expect(buffer?.length).toBe(65537); expect(buffer?.every(byte => byte === 0)).toBe(true);
  });
  it('wipes temporary bytes and closes the descriptor after success or a failed read', () => {
    const path = file(), actual = fs.readSync; const captured: Buffer[] = [];
    const reader = vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => { captured.push(args[1] as Buffer); return actual(...args); });
    const close = vi.spyOn(fs, 'closeSync');
    expect(read(path)).toBe('public dummy value');
    reader.mockImplementation((...args: Parameters<typeof fs.readSync>) => { captured.push(args[1] as Buffer); throw new Error('raw public-sensitive-label'); });
    expect(() => read(path)).toThrow('INDEXER_API_KEY_FILE');
    expect(close).toHaveBeenCalledTimes(2); expect(captured.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
  });
});

describe('database-only migration selection', () => {
  it('does not normalize the existing database string or require unrelated service secrets', async () => {
    const value = ' postgres://public-dummy:public-dummy@localhost/fixture\n', path = file(value);
    expect(readDatabaseUrl({ DATABASE_URL_FILE: path })).toBe(value);
    const query = vi.fn(async () => []), close = vi.fn(async () => {});
    mockPostgres.mockReturnValue({ transaction: async (run: (db: { query: typeof query }) => Promise<void>) => run({ query }), close });
    await migrateFromEnvironment({ DATABASE_URL_FILE: path, DATA_ENCRYPTION_KEY: 'not-a-key', DATA_ENCRYPTION_KEY_FILE: 'conflict', VAPID_PRIVATE_KEY: '' });
    expect(mockPostgres).toHaveBeenCalledExactlyOnceWith(value); expect(query).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
  });
  it.each([{}, { DATABASE_URL: '' }, { DATABASE_URL_FILE: '' }, { DATABASE_URL_FILE: '/absent-public-fixture' },
    { DATABASE_URL: 'public-inline', DATABASE_URL_FILE: '/absent-public-fixture' }])('refuses invalid database source before creating a pool', async env => {
    await expect(migrateFromEnvironment(env)).rejects.toThrow('DATABASE_URL'); expect(mockPostgres).not.toHaveBeenCalled();
  });
});
