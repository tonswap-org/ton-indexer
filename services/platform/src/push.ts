import { Agent } from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import webpush from 'web-push';
import type { Config } from './config.js';
import type { Notification, SubscriptionInput } from './types.js';
import { ApiError } from './errors.js';

export function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.process(value);
    return address.range() === 'unicast';
  } catch { return false; }
}
export function validatePushEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new ApiError(400, 'invalid_push_endpoint', 'Invalid push endpoint.'); }
  const allowed = endpoint.hostname === 'fcm.googleapis.com' || endpoint.hostname === 'updates.push.services.mozilla.com' ||
    endpoint.hostname === 'web.push.apple.com' || endpoint.hostname.endsWith('.notify.windows.com');
  if (!allowed || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || value.length > 4096) {
    throw new ApiError(400, 'invalid_push_endpoint', 'Only supported HTTPS browser push services are accepted.');
  }
  return endpoint;
}
export function validateApplicationServerKey(value: string): void {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value) || Buffer.from(value, 'base64url').length !== 65 ||
    Buffer.from(value, 'base64url')[0] !== 4 || Buffer.from(value, 'base64url').toString('base64url') !== value)
    throw new ApiError(400, 'invalid_application_server_key', 'Use the browser subscription’s canonical VAPID public key.');
}
export function requireApplicationServerKey(value: string, current: string | undefined): void {
  validateApplicationServerKey(value);
  if (value !== current) throw new ApiError(409, 'push_key_changed', 'The notification service key changed. Refresh delivery settings and renew this device. Your inbox is unchanged.');
}
export function validateSubscription(value: SubscriptionInput): void {
  validateApplicationServerKey(value.applicationServerKey);
  validatePushEndpoint(value.endpoint);
  for (const [key, length] of [['p256dh', 65], ['auth', 16]] as const) {
    const valueKey = value.keys[key];
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(valueKey) || Buffer.from(valueKey, 'base64url').length !== length)
      throw new ApiError(400, 'invalid_push_key', 'Invalid browser push encryption key.');
  }
  if (Buffer.from(value.keys.p256dh, 'base64url')[0] !== 4) throw new ApiError(400, 'invalid_push_key', 'Invalid uncompressed P-256 key.');
  if (value.expirationTime && value.expirationTime <= Date.now()) throw new ApiError(400, 'expired_push_subscription', 'This browser subscription has expired.');
}
/** DNS is checked at socket connection time, preventing a check-then-resolve rebinding gap. */
export const publicPushAgent = () => new Agent({
  keepAlive: false,
  lookup: ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    void lookup(hostname, { all: true, verbatim: true }).then(addresses => {
      if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw new Error('Push DNS resolves to a non-public address.');
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }).catch(error => callback(error));
  }) as ConstructorParameters<typeof Agent>[0] extends { lookup?: infer L } ? L : never,
});
export class PushSender {
  constructor(private config: Config) {}
  get available(): boolean { return Boolean(this.config.vapidPublicKey && this.config.vapidPrivateKey && this.config.vapidSubject); }
  async send(subscription: SubscriptionInput, notification: Notification, origin: string): Promise<void> {
    if (!this.available) throw new ApiError(503, 'push_unavailable', 'Push delivery is not configured.');
    validateSubscription(subscription);
    requireApplicationServerKey(subscription.applicationServerKey, this.config.vapidPublicKey);
    const agent = publicPushAgent();
    try {
      const navigate = new URL(notification.href, origin).toString();
      await webpush.sendNotification(subscription, JSON.stringify({
        web_push: 8030, notification: { title: notification.title, body: notification.body,
          navigate, tag: notification.id, data: { id: notification.id, href: notification.href } },
        // Same visible data is understood by the dedicated worker on browsers without declarative push.
        id: notification.id, title: notification.title, body: notification.body, href: notification.href,
      }), { TTL: 3600, urgency: 'normal', timeout: 10000, agent,
        vapidDetails: { subject: this.config.vapidSubject!, publicKey: this.config.vapidPublicKey!, privateKey: this.config.vapidPrivateKey! } });
    } finally { agent.destroy(); }
  }
}
