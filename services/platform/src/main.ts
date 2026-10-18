import { loadConfig } from './config.js';
import { postgres } from './db.js';
import { Store } from './store.js';
import { Providers } from './providers.js';
import { PushSender } from './push.js';
import { createServer } from './server.js';
import { Worker } from './worker.js';

const config = loadConfig();
const db = postgres(config.databaseUrl);
// Migrations are a deployment step; API and worker processes never race schema creation.
await db.query('SELECT id FROM platform_migrations LIMIT 1');
await db.query('SELECT asset_kind,asset_id,network,currency,quote_asset_id,release_manifest_hash FROM platform_price_rules LIMIT 0');
await db.query('SELECT rule_id,definition_revision,started_at,checked_at,observed_at,source,outcome,issue FROM platform_price_rule_monitoring LIMIT 0');
const store = new Store(db, config); const providers = new Providers(db, config); const push = new PushSender(config);
const server = config.mode !== 'worker' ? await createServer(config, db, { store, providers, push }) : null;
const worker = config.mode !== 'api' ? new Worker(config, store, providers, push) : null;
if (server) await server.listen({ host: config.host, port: config.port });
const running = worker?.run();
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true; worker?.stop();
  await server?.close(); await running; await db.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
