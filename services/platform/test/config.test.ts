import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createECDH } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { PushSender } from '../src/push.js';
import { encrypt, decrypt } from '../src/crypto.js';
const environment = { DATABASE_URL: 'postgres://localhost/tonswap', DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  APP_ORIGIN: 'https://app.example.test', PLATFORM_URL: 'https://app.example.test/platform' };
describe('secure service configuration', () => {
  it.each(['GOVERNANCE_CONTRACT_TESTNET', 'GOVERNANCE_CONTRACT_MAINNET'])('rejects removed unpinned Governance configuration %s', name => {
    expect(() => loadConfig({ ...environment, [name]: `0:${'7'.repeat(64)}` })).toThrow('Governance identity comes only from INDEXER_RELEASE_MANIFEST');
  });
  it('checks prices every 15 seconds by default within the current oracle freshness window', () => {
    expect(loadConfig(environment).priceSeconds).toBe(15);
    expect(loadConfig({ ...environment, PRICE_SECONDS: '15' }).priceSeconds).toBe(15);
    expect(loadConfig({ ...environment, PRICE_SECONDS: '3600' }).priceSeconds).toBe(3600);
    for (const value of ['14', '15.5', '3601'])
      expect(() => loadConfig({ ...environment, PRICE_SECONDS: value })).toThrow();
  });
  it('keeps secure cookies and proxy trust explicit by default', () => {
    expect(loadConfig(environment)).toMatchObject({ cookieSecure: true, cookieSameSite: 'lax', trustLoopbackProxy: false });
    expect(loadConfig({ ...environment, TRUST_LOOPBACK_PROXY: '1', COOKIE_SAME_SITE: 'none' })).toMatchObject({ cookieSecure: true, trustLoopbackProxy: true });
  });
  it('cannot disable secure cookies for a public app or API host', () => {
    expect(() => loadConfig({ ...environment, ALLOW_INSECURE_LOCAL: '1' })).toThrow('limited to localhost');
    const local = { ...environment, APP_ORIGIN: 'http://localhost:3000', PLATFORM_URL: 'http://127.0.0.1:8787', ALLOW_INSECURE_LOCAL: '1' };
    expect(loadConfig(local).cookieSecure).toBe(false);
    expect(() => loadConfig({ ...local, COOKIE_SAME_SITE: 'none' })).toThrow('requires secure HTTPS');
  });
  const keyPair = (scalar: number) => {
    const privateKey = Buffer.alloc(32); privateKey[31] = scalar;
    const pair = createECDH('prime256v1'); pair.setPrivateKey(privateKey);
    return { VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: privateKey.toString('base64url'),
      VAPID_SUBJECT: 'mailto:notifications@example.test' };
  };
  const vapid = keyPair(1);
  const error = 'must form one valid canonical P-256 signing key pair';
  it.each(['api', 'worker', 'all'])('admits a valid VAPID pair or explicitly unavailable push in %s mode', mode => {
    expect(new PushSender(loadConfig({ ...environment, PLATFORM_MODE: mode })).available).toBe(false);
    const config = loadConfig({ ...environment, ...vapid, PLATFORM_MODE: mode });
    expect(new PushSender(config).available).toBe(true);
    expect(config.vapidPublicKey).toBe(vapid.VAPID_PUBLIC_KEY);
    expect(config.vapidPrivateKey).toBe(vapid.VAPID_PRIVATE_KEY);
  });
  it.each(['api', 'worker', 'all'])('rejects individually valid keys from different pairs before %s startup', mode => {
    expect(() => loadConfig({ ...environment, ...vapid, PLATFORM_MODE: mode,
      VAPID_PRIVATE_KEY: keyPair(2).VAPID_PRIVATE_KEY })).toThrow(error);
  });
  it.each([
    ['non-base64 input', 'invalid'], ['zero scalar', Buffer.alloc(32).toString('base64url')],
    ['out-of-range scalar', Buffer.alloc(32, 255).toString('base64url')],
    ['short scalar', Buffer.alloc(31, 1).toString('base64url')], ['oversized scalar', Buffer.alloc(33, 1).toString('base64url')],
    ['padded encoding', vapid.VAPID_PRIVATE_KEY + '='], ['noncanonical trailing bits', vapid.VAPID_PRIVATE_KEY.slice(0, -1) + 'F'],
  ])('rejects unusable VAPID private key: %s', (_label, value) => {
    expect(() => loadConfig({ ...environment, ...vapid, VAPID_PRIVATE_KEY: value })).toThrow(error);
  });
  it('rejects an off-curve public point even if its byte length and prefix look valid', () => {
    const invalid = Buffer.alloc(65); invalid[0] = 4;
    expect(() => loadConfig({ ...environment, ...vapid, VAPID_PUBLIC_KEY: invalid.toString('base64url') })).toThrow(error);
  });
  it('reports only configuration names when the pair does not match', () => {
    const other = keyPair(2).VAPID_PRIVATE_KEY;
    try { loadConfig({ ...environment, ...vapid, VAPID_PRIVATE_KEY: other }); expect.fail('invalid pair was accepted'); }
    catch (failure) {
      expect((failure as Error).message).toContain(error);
      expect((failure as Error).message).not.toContain(other);
      expect((failure as Error).message).not.toContain(vapid.VAPID_PUBLIC_KEY);
    }
  });
});

describe('explicit platform secret sources preserve existing consumer behavior', () => {
  const base = fileURLToPath(new URL('../../../.local/secret-source-test-fixtures/', import.meta.url));
  let root: string, sequence: number;
  beforeAll(() => fs.mkdirSync(base, { recursive: true, mode: 0o700 }));
  beforeEach(() => { root = fs.mkdtempSync(join(base, 'config-')); sequence = 0; });
  const file = (value: string) => {
    const path = join(root, `secret-${sequence++}`); fs.writeFileSync(path, value, { flag: 'wx', mode: 0o600 }); return path;
  };
  const names = ['DATABASE_URL', 'DATA_ENCRYPTION_KEY', 'INDEXER_API_KEY', 'TON_RPC_API_KEY',
    'COINGECKO_API_KEY', 'VAPID_PRIVATE_KEY'] as const;
  it('loads each explicit file exactly, retains the VAPID pair and decrypts ciphertext written with the original key', () => {
    const pair = createECDH('prime256v1'); pair.setPrivateKey(Buffer.alloc(32, 0x11));
    const original: NodeJS.ProcessEnv = { ...environment, DATABASE_URL: ' postgres://public-dummy@localhost/fixture\n',
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 0x42).toString('base64'), INDEXER_API_KEY: ' public-indexer\n',
      TON_RPC_API_KEY: 'public-rpc ', COINGECKO_API_KEY: 'public-archive\r\n',
      VAPID_PRIVATE_KEY: pair.getPrivateKey().toString('base64url'), VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
      VAPID_SUBJECT: 'mailto:public-fixture@example.test' };
    const oldConfig = loadConfig(original), row = { endpoint: 'https://push.example.test/public-fixture', value: 'public fixture\nsecond line' };
    const ciphertext = encrypt(row, oldConfig.encryptionKey);
    const selected: NodeJS.ProcessEnv = { ...original };
    for (const name of names) { selected[`${name}_FILE`] = file(original[name]!); delete selected[name]; }
    Object.freeze(selected);
    const loaded = loadConfig(selected);
    expect(loaded.databaseUrl).toBe(original.DATABASE_URL);
    expect(loaded.indexerApiKey).toBe(original.INDEXER_API_KEY); expect(loaded.tonRpcApiKey).toBe(original.TON_RPC_API_KEY);
    expect(loaded.coingeckoKey).toBe(original.COINGECKO_API_KEY); expect(loaded.vapidPrivateKey).toBe(original.VAPID_PRIVATE_KEY);
    expect(loaded.vapidPublicKey).toBe(original.VAPID_PUBLIC_KEY); expect(new PushSender(loaded).available).toBe(true);
    expect(loaded.encryptionKey.equals(oldConfig.encryptionKey)).toBe(true); expect(decrypt(ciphertext, loaded.encryptionKey)).toEqual(row);
    for (const name of names) expect(selected[name]).toBeUndefined();
  });
  it.each(names)('rejects %s source conflicts including defined-empty inline values', name => {
    for (const inline of ['', 'public-inline']) {
      const env: NodeJS.ProcessEnv = { ...environment, [name]: inline, [`${name}_FILE`]: file('public-file') };
      expect(() => loadConfig(env)).toThrow(`Configure only one of ${name}`);
    }
  });
  it.each(['INDEXER_API_KEY', 'TON_RPC_API_KEY', 'COINGECKO_API_KEY', 'VAPID_PRIVATE_KEY'] as const)(
    'rejects an explicitly missing or empty %s source instead of treating it as optional absence', name => {
      expect(() => loadConfig({ ...environment, [`${name}_FILE`]: join(root, 'absent') })).toThrow(`${name}_FILE`);
      expect(() => loadConfig({ ...environment, [`${name}_FILE`]: file('') })).toThrow(`${name}_FILE`);
      expect(() => loadConfig({ ...environment, [name]: '' })).toThrow(name);
    });
  it('retains ordinary optional absence and requires both core secrets', () => {
    expect(loadConfig(environment)).toMatchObject({ indexerApiKey: undefined, tonRpcApiKey: undefined, coingeckoKey: undefined, vapidPrivateKey: undefined });
    for (const name of ['DATABASE_URL', 'DATA_ENCRYPTION_KEY']) {
      const env: NodeJS.ProcessEnv = { ...environment }; delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    }
  });
  it('keeps encryption decoding behavior while retaining strict VAPID encoding and pair validation', () => {
    const encryption = file(`\n${environment.DATA_ENCRYPTION_KEY}\n`);
    expect(loadConfig({ ...environment, DATA_ENCRYPTION_KEY: undefined, DATA_ENCRYPTION_KEY_FILE: encryption }).encryptionKey).toEqual(Buffer.alloc(32));
    expect(() => loadConfig({ ...environment, DATA_ENCRYPTION_KEY: undefined, DATA_ENCRYPTION_KEY_FILE: file('public-not-a-key') })).toThrow('DATA_ENCRYPTION_KEY must be');
    const pair = createECDH('prime256v1'); pair.setPrivateKey(Buffer.alloc(32, 0x11));
    const vapid = { VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'), VAPID_SUBJECT: 'mailto:public-fixture@example.test' };
    expect(() => loadConfig({ ...environment, ...vapid, VAPID_PRIVATE_KEY_FILE: file(pair.getPrivateKey().toString('base64url') + '\n') })).toThrow('must form one valid canonical');
    const other = createECDH('prime256v1'); other.setPrivateKey(Buffer.alloc(32, 0x22));
    expect(() => loadConfig({ ...environment, ...vapid, VAPID_PRIVATE_KEY_FILE: file(other.getPrivateKey().toString('base64url')) })).toThrow('must form one valid canonical');
  });
});
