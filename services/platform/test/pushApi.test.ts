import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { address, secondAddress, config, database, session } from './helpers.js';
let applicationServerKey: string; let db: Database; let app: FastifyInstance; let store: Store; let headers: Record<string, string>;
beforeAll(async () => {
  db = await database(); const keys = webpush.generateVAPIDKeys(); applicationServerKey = keys.publicKey;
  const cfg = config({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:test@example.test' });
  store = new Store(db, cfg); const verified = await session(store);
  headers = { origin: cfg.appOrigins[0]!, cookie: `__Host-tonswap_session=${verified.token}`,
    'x-csrf-token': verified.csrfToken, 'x-wallet-address': address, 'x-wallet-network': 'testnet' };
  app = await createServer(cfg, db, { store, logger: false });
});
afterAll(async () => { await app.close(); await db.close(); });
describe('authenticated push device API contract', () => {
  it('registers and renews a device atomically, exposes only fingerprints, and rejects stale wallet enrollment', async () => {
    const input = { applicationServerKey, endpoint: 'https://fcm.googleapis.com/fcm/send/api-browser', deviceName: 'My browser',
      expirationTime: null, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
    const first = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers, payload: input });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ active: true });
    const oldId = first.json().id;
    const other = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers,
      payload: { ...input, endpoint: input.endpoint + '-other-device' } });
    const failed = await app.inject({ method: 'POST', url: '/v1/push/subscriptions',
      headers: { ...headers, 'x-wallet-address': secondAddress }, payload: { ...input, replacesSubscriptionId: oldId } });
    expect(failed.statusCode).toBe(409); expect((await store.subscription(oldId))?.active).toBe(true);
    const renewed = await app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers,
      payload: { ...input, endpoint: input.endpoint + '-renewed', replacesSubscriptionId: oldId } });
    expect(renewed.statusCode).toBe(200);
    const listed = await app.inject({ url: '/v1/push/subscriptions', headers });
    expect(listed.json().subscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldId, active: false, retirementReason: 'replaced' }),
      expect.objectContaining({ id: renewed.json().id, active: true, deviceName: 'My browser', applicationServerKey, endpointHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: other.json().id, active: true }),
    ]));
    expect(listed.body).not.toContain(input.endpoint); expect(listed.body).not.toContain(input.keys.auth);
    await app.inject({ method: 'DELETE', url: `/v1/push/subscriptions/${renewed.json().id}`, headers });
    expect((await store.subscription(renewed.json().id))?.active).toBe(false);
    expect((await store.subscription(other.json().id))?.active).toBe(true);
  });
});
