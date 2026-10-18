import { applicationServerKey, pushConfig } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { isPublicAddress, validatePushEndpoint, validateSubscription } from '../src/push.js';
describe('push destination validation', () => {
  it.each(['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x',
    'https://fcm.googleapis.com:8443/x', 'https://user:secret@fcm.googleapis.com/x', 'https://[::1]/x',
    'https://169.254.169.254/latest/meta-data', 'https://random.example/x'])('rejects %s', endpoint => {
    expect(() => validatePushEndpoint(endpoint)).toThrow();
  });
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.2.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])('rejects private DNS address %s', ip => expect(isPublicAddress(ip)).toBe(false));
  it('accepts recognized push hostnames and public DNS results', () => {
    expect(validatePushEndpoint('https://web.push.apple.com/QExample').hostname).toBe('web.push.apple.com');
    expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
  it('checks encryption key sizes and expired subscriptions', () => {
    expect(() => validateSubscription({ applicationServerKey, endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: 'short' } })).toThrow();
    expect(() => validateSubscription({ applicationServerKey, endpoint: 'https://fcm.googleapis.com/x', expirationTime: 1,
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } })).toThrow();
  });
});
