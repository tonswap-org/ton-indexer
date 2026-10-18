import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { Decimal } from './decimal.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { PriceRuleInput, Session } from './types.js';
import { ApiError } from './errors.js';
import { constantEquals } from './crypto.js';
import { Store, normalizeAddress, normalizeNetwork } from './store.js';
import { Providers } from './providers.js';
import { verifyTonProof } from './tonProof.js';
import { PushSender, requireApplicationServerKey, validateSubscription } from './push.js';
import { fetchJson, numeric, record, type Fetcher } from './http.js';
import { AssetValuations, canonicalAsset } from './valuations.js';
import { historicalAnchorTime } from './historicalAnchors.js';
import { alertAssetSchema } from './alertAssetSchema.js';
import { DexPrices } from './dexPrices.js';
import { AlertObservations } from './alertObservations.js';
import { alertCatalogue } from './alertCatalogue.js';
import { assessPriceObservation } from './priceMonitoring.js';
import { NOTIFICATION_DESTINATIONS } from './notificationLinks.js';

const walletSchema = z.object({ address: z.string().min(1).max(128), network: z.string().max(16) });
const proofSchema = walletSchema.extend({ publicKey: z.string().regex(/^[a-fA-F0-9]{64}$/), walletStateInit: z.string().min(1).max(16000),
  proof: z.object({ timestamp: z.number().int().positive(), domain: z.object({ lengthBytes: z.number().int().min(1).max(1024), value: z.string().min(1).max(1024) }).strict(),
    signature: z.string().min(80).max(100), payload: z.string().min(32).max(256) }).strict() }).strict();
const preferencesSchema = z.object({ priceAlerts: z.boolean().optional(), activity: z.boolean().optional(),
  governance: z.boolean().optional(), walletProtocol: z.boolean().optional() }).strict();
const subscriptionSchema = z.object({ applicationServerKey: z.string().length(87), endpoint: z.string().url().max(4096), expirationTime: z.number().positive().nullable().optional(),
  keys: z.object({ p256dh: z.string().max(128), auth: z.string().max(32) }).strict(), deviceName: z.string().max(80).optional(),
  replacesSubscriptionId: z.string().uuid().optional() }).strict();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10);
}, 'Use a real date that is not in the future.');
const uuidParams = z.object({ id: z.string().uuid() });
export interface ServerDependencies { fetcher?: Fetcher; store?: Store; providers?: Providers; push?: PushSender; logger?: boolean }

export async function createServer(config: Config, db: Database, dependencies: ServerDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 24_000, trustProxy: config.trustLoopbackProxy ? ['127.0.0.1/32', '::1/128'] : false, logger: dependencies.logger ?? {
    level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
    serializers: { req: request => ({ method: request.method, url: request.url?.split('?')[0], remoteAddress: request.ip }) },
  } });
  const store = dependencies.store ?? new Store(db, config);
  const providers = dependencies.providers ?? new Providers(db, config, dependencies.fetcher);
  const push = dependencies.push ?? new PushSender(config);
  const valuations = new AssetValuations(config, db, providers, dependencies.fetcher);
  const dex = new DexPrices(config, dependencies.fetcher);
  const alertObservations = new AlertObservations(config, dex);
  const cookieName = config.cookieSecure ? '__Host-tonswap_session' : 'tonswap_session_dev';
  const cookieOptions = { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, path: '/' } as const;
  await app.register(cookie);
  await app.register(cors, { origin: (origin, callback) => callback(null, Boolean(origin && config.appOrigins.includes(origin))),
    credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Wallet-Address', 'X-Wallet-Network'] });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', allowList: [], keyGenerator: request => request.ip });
  const requireOrigin = (request: FastifyRequest): string => {
    const origin = request.headers.origin;
    if (!origin || !config.appOrigins.includes(origin)) throw new ApiError(403, 'invalid_origin', 'Open TONSWAP on its configured app origin.');
    return origin;
  };
  const authenticated = async (request: FastifyRequest, write = false): Promise<Session> => {
    if (write) requireOrigin(request);
    const value = request.cookies[cookieName]; const session = value ? await store.session(value) : null;
    if (!session) throw new ApiError(401, 'authentication_required', 'Verify wallet ownership to use notifications.');
    const walletHeader = request.headers['x-wallet-address']; const networkHeader = request.headers['x-wallet-network'];
    if ((write || walletHeader || networkHeader) && (walletHeader !== session.walletAddress || networkHeader !== session.network))
      throw new ApiError(409, 'wallet_session_changed', 'The notification wallet changed. Refresh and retry for the current wallet.');
    const csrf = request.headers['x-csrf-token'];
    if (write && (typeof csrf !== 'string' || !constantEquals(csrf, session.csrfToken))) throw new ApiError(403, 'invalid_csrf', 'Refresh the notification session and try again.');
    return session;
  };
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid request fields.', fields: error.issues.map(issue => issue.path.join('.')) } });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const errorStatus = record(error).statusCode;
    const status = typeof errorStatus === 'number' && errorStatus < 500 ? errorStatus : 503;
    return reply.code(status).send({ error: { code: status === 503 ? 'service_unavailable' : 'invalid_request',
      message: status === 503 ? 'Auxiliary service temporarily unavailable. Trading remains available.' : 'Request could not be processed.' } });
  });
  app.get('/v1/health', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      const workers = await db.query<{ count: string }>("SELECT count(*) FROM platform_worker_status WHERE last_seen_at>now()-interval '2 minutes'");
      const jobs = await db.query<{ count: string }>("SELECT count(*) FROM platform_jobs WHERE state='failed'");
      return { status: 'ok', database: 'ready', ...(config.instanceId ? { instanceId: config.instanceId } : {}), worker: Number(workers.rows[0]?.count) ? 'active' : 'not_seen',
        failedDeliveryJobs: Number(jobs.rows[0]?.count ?? 0), push: push.available ? 'configured' : 'unavailable',
        prices: config.networks.some(network => dex.configured(network)) ? 'configured' : 'unavailable', priceSource: 'tonswap-dex' };
    } catch { return reply.code(503).send({ status: 'unavailable', database: 'unavailable' }); }
  });
  app.get('/v1/capabilities', async () => ({ networks: config.networks, appOrigins: config.appOrigins,
    notifications: { inbox: true, push: push.available, categories: ['priceAlerts', 'activity', 'governance', 'walletProtocol'],
      governanceNetworks: Object.keys(config.governanceContracts), indexedNetworks: Object.keys(config.indexerUrls),
      priceRule: { kinds: ['target'], thresholdPercent: '5', windowHours: 24, cooldownHours: 24, currency: 'T3', source: 'tonswap-dex', quoteAssetId: config.dexRelease?.quoteAssetId ?? null, releaseManifestHash: config.dexRelease?.manifestHash ?? null },
      activityEvidence: 'confirmed_settlement_only' }, taxDataAccepted: false }));
  app.get('/v1/currencies', async () => providers.currencies());
  app.get('/v1/asset-valuations', async request => {
    const input = z.object({ network: z.enum(['mainnet', 'testnet']), assets: z.string().max(6500) }).strict().parse(request.query);
    if (!config.networks.includes(input.network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    let assets: string[];
    try { assets = z.array(z.string().max(128)).min(1).max(50).parse(input.assets.split(',')).map(canonicalAsset); }
    catch { throw new ApiError(400, 'invalid_asset', 'Use canonical token roots or native.'); }
    return valuations.prices(input.network, [...new Set(assets)]);
  });
  app.get('/v1/historical-anchor', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const input = z.object({ network: z.enum(['mainnet', 'testnet']), asset: z.string().min(1).max(128), at: z.string().max(64) }).strict().parse(request.query);
    const at = historicalAnchorTime(input.at, new Date());
    if (!config.networks.includes(input.network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    if (input.network !== 'mainnet') throw new ApiError(400, 'simulation_historical_valuation', 'Simulation assets cannot use real historical monetary prices.');
    let assetId: string;
    try { assetId = canonicalAsset(input.asset); }
    catch { throw new ApiError(400, 'invalid_asset', 'Use a canonical token root or native.'); }
    const path = config.assetValuationPaths.find(item => item.network === input.network && item.assetId === assetId);
    if (!path || path.kind !== 'coingecko') throw new ApiError(400, 'historical_anchor_not_configured', 'This asset has no configured listed-asset historical anchor.');
    return { network: input.network, assetId, anchor: await providers.historicalAnchor(path.coinGeckoId, at) };
  });
  app.get('/v1/historical-anchor/revisions/:id', async request => {
    z.object({}).strict().parse(request.query);
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.params);
    const revision = await providers.historicalAnchorRevision(id);
    if (!revision) throw new ApiError(404, 'historical_revision_unavailable', 'This preserved historical observation is unavailable.');
    return revision;
  });
  app.get('/v1/assets/search', async request => {
    const input = z.object({ network: z.enum(['mainnet', 'testnet']), q: z.string().max(128).default('') }).strict().parse(request.query);
    if (!config.networks.includes(input.network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    return alertCatalogue(config, dex, input.network, input.q);
  });
  app.get('/v1/rates/revisions/:id', async request => {
    z.object({}).strict().parse(request.query);
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.params);
    const revision = await providers.historicalFxRevision(id);
    if (!revision) throw new ApiError(404, 'historical_fx_revision_unavailable', 'This preserved daily exchange-rate evidence is unavailable.');
    return revision;
  });
  app.get('/v1/receita-work-rates', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const input = z.object({ month: z.string().length(7).regex(/^202[56]-(?:0[1-9]|1[0-2])$/) }).strict().parse(request.query);
    return providers.receitaWorkRates(input.month);
  });
  app.get('/v1/receita-work-rates/revisions/:id', async request => {
    z.object({}).strict().parse(request.query);
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.params);
    const revision = await providers.receitaWorkRatesRevision(id);
    if (!revision) throw new ApiError(404, 'receita_work_rates_revision_unavailable', 'This preserved Receita monthly table is unavailable.');
    return revision;
  });
  app.get('/v1/ptax', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const input = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), date: dateSchema }).strict().parse(request.query);
    return providers.ptax(input.currency, input.date);
  });
  app.get('/v1/ptax/revisions/:id', async request => {
    z.object({}).strict().parse(request.query);
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.params);
    const revision = await providers.ptaxRevision(id);
    if (!revision) throw new ApiError(404, 'ptax_revision_unavailable', 'This preserved Banco Central closing quotation is unavailable.');
    return revision;
  });
  app.get('/v1/rates', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    const input = z.object({ base: z.string().regex(/^[A-Z]{3}$/).default('USD'), symbols: z.string().max(700), date: dateSchema.optional(), network: z.enum(['mainnet', 'testnet']).optional() }).strict().parse(request.query);
    const symbols = z.array(z.string().regex(/^[A-Z]{3,12}$/)).min(1).max(50).parse(input.symbols.split(','));
    if (input.network && !config.networks.includes(input.network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    const result = await providers.rates(input.base, symbols, input.date);
    const network = input.network ?? (config.networks.length === 1 ? config.networks[0] : undefined);
    return result;
  });
  app.get('/v1/prices/revisions/:id', async request => {
    z.object({}).strict().parse(request.query);
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.params);
    const revision = await providers.historicalDailyRevision(id);
    if (!revision) throw new ApiError(404, 'historical_daily_revision_unavailable', 'This preserved daily price evidence is unavailable.');
    return revision;
  });
  const dexRequest = async (query: unknown) => {
    const input = z.object({ network: z.enum(['mainnet', 'testnet']), assets: z.string().min(1).max(6500) }).strict().parse(query);
    if (!config.networks.includes(input.network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    let assets: string[];
    try { assets = z.array(z.string().max(128)).min(1).max(50).parse(input.assets.split(',')).map(canonicalAsset); }
    catch { throw new ApiError(400, 'invalid_asset', 'Use canonical token roots or native.'); }
    return dex.prices(input.network, [...new Set(assets)]);
  };
  app.get('/v1/dex-prices', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => dexRequest(request.query));
  app.get('/v1/prices', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    if (!record(request.query).date) return dexRequest(request.query);
    // Explicitly dated archives retain their original evidence and denomination.
    const input = z.object({ ids: z.string().max(1000), vs: z.string().regex(/^[a-z]{3}$/).default('usd'), date: dateSchema }).strict().parse(request.query);
    const ids = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).min(1).max(10).parse(input.ids.split(','));
    return providers.prices(ids, input.vs, input.date);
  });
  app.post('/v1/auth/challenge', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async request => {
    const origin = requireOrigin(request); const input = walletSchema.strict().parse(request.body);
    const network = normalizeNetwork(input.network);
    if (!config.networks.includes(network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    return store.createChallenge(normalizeAddress(input.address), network, new URL(origin).host);
  });
  app.post('/v1/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const origin = requireOrigin(request); const input = proofSchema.parse(request.body); const network = normalizeNetwork(input.network);
    if (!config.networks.includes(network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    const address = normalizeAddress(input.address);
    const challenge = await store.challenge(input.proof.payload, address, network);
    if (!challenge || challenge.domain !== new URL(origin).host) throw new ApiError(401, 'proof_replayed_or_expired', 'Request a new wallet proof.');
    await verifyTonProof(input, { domain: challenge.domain, payload: input.proof.payload, nowSeconds: Math.floor(Date.now() / 1000),
      resolvePublicKey: async wallet => {
        const endpoint = config.tonRpcUrls[network]; if (!endpoint) return null;
        const response = record(await fetchJson(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
          ...(config.tonRpcApiKey ? { 'X-API-Key': config.tonRpcApiKey } : {}) },
          body: JSON.stringify({ id: 'tonswap-proof', jsonrpc: '2.0', method: 'runGetMethod', params: { address: wallet, method: 'get_public_key', stack: [] } }) }, dependencies.fetcher));
        const result = record(response.result);
        if (numeric(result.exit_code) !== 0 || !Array.isArray(result.stack)) return null;
        const entry = result.stack[0]; if (!Array.isArray(entry) || entry[0] !== 'num') return null;
        const value = BigInt(String(entry[1])); if (value < 0n || value >= 1n << 256n) return null;
        return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
      } });
    const session = await store.createSession(input.proof.payload, address, network);
    reply.setCookie(cookieName, session.token, { ...cookieOptions, expires: new Date(session.expiresAt) });
    await store.emit(address, network, { category: 'walletProtocol', sourceEventId: `session:${session.id}`, title: 'Wallet verified for alerts',
      body: 'A notification session was verified with this wallet.', href: NOTIFICATION_DESTINATIONS.settings, occurredAt: new Date().toISOString(), evidence: { kind: 'wallet_proof_verified' } });
    return { walletAddress: session.walletAddress, network, expiresAt: session.expiresAt, csrfToken: session.csrfToken };
  });
  app.get('/v1/auth/session', async request => {
    const session = await authenticated(request);
    return { walletAddress: session.walletAddress, network: session.network, expiresAt: session.expiresAt, csrfToken: session.csrfToken };
  });
  app.post('/v1/auth/logout', async (request, reply) => {
    const session = await authenticated(request, true); await store.logout(session);
    reply.clearCookie(cookieName, cookieOptions); return { revoked: true };
  });
  app.get('/v1/notifications/preferences', async request => {
    const session = await authenticated(request); return { preferences: await store.preferences(session.walletAddress, session.network) };
  });
  app.patch('/v1/notifications/preferences', async request => ({ preferences: await store.setPreferences(await authenticated(request, true), preferencesSchema.parse(request.body)) }));
  app.get('/v1/notifications/price-rules', async request => ({ rules: await store.rules(await authenticated(request)) }));
  app.put('/v1/notifications/price-rules', async request => {
    const session = await authenticated(request, true);
    const positiveDecimal = z.string().regex(/^\d+(?:\.\d+)?$/).max(80)
      .transform(value => new Decimal(value).toString()).refine(value => new Decimal(value).gt(0));
    const parsed = z.object({ currency: z.literal('T3'), quoteAssetId: z.string().regex(/^(-1|0):[a-f0-9]{64}$/),
      releaseManifestHash: z.string().regex(/^[a-f0-9]{64}$/), asset: alertAssetSchema, enabled: z.boolean().default(true),
      kind: z.enum(['percent', 'target']).default('percent'), thresholdPercent: positiveDecimal.nullable().optional(),
      targetPrice: positiveDecimal.nullable().optional(), direction: z.enum(['above', 'below', 'both']).default('both') }).strict().parse(request.body);
    const input: PriceRuleInput = { currency: parsed.currency, quoteAssetId: parsed.quoteAssetId, releaseManifestHash: parsed.releaseManifestHash, asset: parsed.asset, enabled: parsed.enabled, kind: parsed.kind, direction: parsed.direction,
      thresholdPercent: parsed.kind === 'percent' ? parsed.thresholdPercent ?? '5' : null,
      targetPrice: parsed.kind === 'target' ? parsed.targetPrice ?? null : null };
    if (input.asset.kind !== 'ton' || !dex.configured(session.network) || input.quoteAssetId !== config.dexRelease?.quoteAssetId ||
        input.releaseManifestHash !== config.dexRelease?.manifestHash)
      throw new ApiError(400, 'dex_pair_required', 'Choose the quote asset and release from the TONSwap DEX catalogue.');
    if (input.asset.kind === 'ton' && input.asset.network !== session.network)
      throw new ApiError(409, 'asset_network_mismatch', 'Choose an asset on the verified wallet network.');
    if (!config.networks.includes(session.network)) throw new ApiError(400, 'unsupported_network', 'This network is not enabled.');
    if (input.kind === 'target' && (!input.targetPrice || input.direction === 'both')) throw new ApiError(400, 'invalid_target_rule', 'Target rules need a price and an above/below direction.');
    if (input.thresholdPercent && new Decimal(input.thresholdPercent).gt(10000)) throw new ApiError(400, 'invalid_threshold', 'Percentage threshold must not exceed 10000.');
    if (input.enabled) {
      const response = await alertObservations.prices([input.asset]);
      const assessment = assessPriceObservation(input.asset, input.kind, response.quotes[0] ?? null, response.currency, Date.now(), input.quoteAssetId);
      if (assessment.issue === 'change_unavailable') throw new ApiError(422, 'price_change_unavailable', 'This asset has no observed 24-hour percentage change. Use a target price alert.');
      if (assessment.outcome !== 'observed') throw new ApiError(422, 'price_feed_unavailable', 'This asset does not have a current supported price feed.');
    }
    return { rule: await store.saveRule(session, input) };
  });
  app.delete('/v1/notifications/price-rules/:id', async request => {
    const session = await authenticated(request, true); await store.deleteRule(session, uuidParams.parse(request.params).id); return { deleted: true };
  });
  app.get('/v1/notifications/inbox', async request => {
    const session = await authenticated(request);
    const input = z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict().parse(request.query);
    return store.inbox(session, input.limit, input.cursor);
  });
  app.post('/v1/notifications/inbox/:id/read', async request => {
    const session = await authenticated(request, true); await store.markRead(session, uuidParams.parse(request.params).id); return { read: true };
  });
  app.get('/v1/push/config', async () => ({ available: push.available, publicKey: config.vapidPublicKey ?? null }));
  app.get('/v1/push/subscriptions', async request => ({ subscriptions: await store.listSubscriptions(await authenticated(request)) }));
  app.post('/v1/push/subscriptions', async request => {
    const session = await authenticated(request, true);
    if (!push.available) throw new ApiError(503, 'push_unavailable', 'Push notifications are not configured.');
    const { replacesSubscriptionId, ...input } = subscriptionSchema.parse(request.body); validateSubscription(input);
    requireApplicationServerKey(input.applicationServerKey, config.vapidPublicKey);
    return store.saveSubscription(session, input, replacesSubscriptionId);
  });
  app.delete('/v1/push/subscriptions/:id', async request => {
    const session = await authenticated(request, true); await store.retireSubscription(uuidParams.parse(request.params).id, 'user_disabled', session); return { deleted: true };
  });
  app.post('/v1/push/test', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async request => {
    const session = await authenticated(request, true);
    const { subscriptionId } = z.object({ subscriptionId: z.string().uuid() }).strict().parse(request.body);
    const subscription = await store.subscription(subscriptionId);
    if (!subscription?.active || subscription.walletAddress !== session.walletAddress || subscription.network !== session.network)
      throw new ApiError(404, 'subscription_not_found', 'This device is not registered for the current wallet.');
    if (!push.available) throw new ApiError(503, 'push_unavailable', 'Push notifications are not configured.');
    requireApplicationServerKey(subscription.applicationServerKey, config.vapidPublicKey);
    const id = await store.emit(session.walletAddress, session.network, { category: 'walletProtocol', sourceEventId: `test:${randomUUID()}`,
      title: 'TONSWAP notification test', body: 'This is your requested notification test. Check for it outside the app.', href: NOTIFICATION_DESTINATIONS.settings,
      occurredAt: new Date().toISOString(), evidence: { kind: 'user_requested_test' } }, { force: true, subscriptionId });
    return { queued: true, notificationId: id, delivery: 'pending' };
  });
  return app;
}
