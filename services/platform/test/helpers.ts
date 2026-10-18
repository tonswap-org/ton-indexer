import webpush from 'web-push';
import { PGlite } from '@electric-sql/pglite';
import { WalletContractV4 } from '@ton/ton';
import { beginCell, storeStateInit } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import type { Config } from '../src/config.js';
import type { Database, Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';
import { proofDigest, type TonProofInput } from '../src/tonProof.js';

export const config = (overrides: Partial<Config> = {}): Config => ({
  host: '127.0.0.1', port: 8787, mode: 'all', databaseUrl: 'postgres://unused',
  appOrigins: ['https://app.example.test'], platformUrl: 'https://app.example.test/platform', cookieSecure: true, cookieSameSite: 'lax',
  encryptionKey: Buffer.alloc(32, 42), networks: ['testnet'], sessionHours: 24,
  indexerUrls: { testnet: 'https://indexer.example.test/api/indexer/v1' }, tonRpcUrls: {}, coingeckoTier: 'demo',
  governanceContracts: {}, pollSeconds: 30, priceSeconds: 120, workerConcurrency: 4, retentionDays: 90, allowInsecureLocal: false,
  assetValuationPaths: [],
  trustLoopbackProxy: false,
  ...overrides,
});
export async function database(): Promise<Database> {
  const pg = new PGlite();
  const adapter = (client: Pick<PGlite, 'query' | 'exec'>): Sql => ({
    async query<T>(sql: string, values?: unknown[]) {
      if (!values && sql.split(';').filter(value => value.trim()).length > 1) {
        const results = await client.exec(sql); return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      const result = await client.query<T>(sql, values); return { rows: result.rows, rowCount: result.affectedRows };
    },
  });
  const db: Database = { ...adapter(pg), transaction: fn => pg.transaction(tx => fn(adapter(tx as typeof pg))), close: () => pg.close() };
  await migrate(db); return db;
}
export const keys = keyPairFromSeed(Buffer.alloc(32, 7));
export const wallet = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey });
export const address = wallet.address.toRawString();
export const secondAddress = `0:${'1'.repeat(64)}`;
export function proof(payload: string, overrides: Partial<TonProofInput> = {}): TonProofInput {
  const input: TonProofInput = { address, publicKey: keys.publicKey.toString('hex'),
    walletStateInit: beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64'),
    proof: { timestamp: Math.floor(Date.now() / 1000), domain: { lengthBytes: 16, value: 'app.example.test' }, payload, signature: '' }, ...overrides };
  input.proof.signature = sign(proofDigest(wallet.address, input.proof), keys.secretKey).toString('base64');
  return input;
}
export async function session(store: Store, walletAddress = address) {
  const challenge = await store.createChallenge(walletAddress, 'testnet', 'app.example.test');
  return store.createSession(challenge.payload, walletAddress, 'testnet');
}

const vapid = webpush.generateVAPIDKeys();
export const applicationServerKey = vapid.publicKey;
export const pushConfig = (overrides: Partial<Config> = {}) => config({ vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, vapidSubject: 'mailto:test@example.test', ...overrides });
