import { describe, expect, it } from 'vitest';
import { createECDH } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { PushSender } from '../src/push.js';
const environment = { DATABASE_URL: 'postgres://localhost/tonswap', DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  APP_ORIGIN: 'https://app.example.test', PLATFORM_URL: 'https://app.example.test/platform' };
describe('secure service configuration', () => {
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
