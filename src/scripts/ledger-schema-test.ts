import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';

function poolFor(db: PGlite): LedgerSqlPool {
  const pool: LedgerSqlPool = {
    query: async (sql, params) => !params && sql.includes(';') ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params),
    connect: async () => pool, end: () => db.close()
  };
  return pool;
}
async function main() {
  const db = new PGlite(), store = new PostgresLedgerStore(poolFor(db));
  try {
    await store.initialize(); await store.initialize();
    const columns = (await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(`
      SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('ledger_owner_checks','ledger_wallet_identities','ledger_projection_coverage','ledger_watch_accounts','ledger_transactions') ORDER BY table_name,ordinal_position`)).rows;
    const column = (table: string, name: string) => { const value = columns.find(row => row.table_name === table && row.column_name === name); assert(value, `${table}.${name} exists`); return value; };
    const expectedOwner: Record<string, string> = { network: 'text', account: 'text', checked_at: 'timestamp with time zone', boundary_seqno: 'bigint', boundary_utime: 'bigint', head_vector: 'jsonb', pending_accounts: 'jsonb', bindings: 'jsonb', unresolved: 'boolean', error_code: 'text' };
    const expectedWallet: Record<string, string> = { network: 'text', wallet: 'text', owner: 'text', master: 'text', code_hash: 'text', verified_seqno: 'bigint' };
    for (const [table, expected] of [['ledger_owner_checks', expectedOwner], ['ledger_wallet_identities', expectedWallet]] as const) {
      assert.deepEqual(columns.filter(row => row.table_name === table).map(row => row.column_name).sort(), Object.keys(expected).sort());
      for (const [name, type] of Object.entries(expected)) { assert.equal(column(table, name).data_type, type); assert.equal(column(table, name).is_nullable, name === 'error_code' ? 'YES' : 'NO'); }
    }
    assert.equal(column('ledger_owner_checks', 'pending_accounts').column_default, "'[]'::jsonb");
    assert.equal(column('ledger_owner_checks', 'bindings').column_default, "'{}'::jsonb");
    assert.equal(column('ledger_owner_checks', 'unresolved').column_default, 'false');
    for (const name of ['boundary_seqno', 'boundary_utime']) { const c = column('ledger_projection_coverage', name); assert.equal(c.data_type, 'bigint'); assert.equal(c.is_nullable, 'YES'); assert.equal(c.column_default, null); }
    assert.equal(column('ledger_watch_accounts', 'requested_at').data_type, 'timestamp with time zone');
    assert.equal(column('ledger_watch_accounts', 'requested_at').is_nullable, 'NO');
    assert.equal(column('ledger_watch_accounts', 'requested_at').column_default, 'now()');
    assert.equal(column('ledger_transactions', 'event_id').is_nullable, 'NO');
    const constraints = (await db.query<{ conname: string }>('SELECT conname FROM pg_constraint')).rows.map(row => row.conname);
    for (const name of ['ledger_transactions_lt_check', 'ledger_transactions_event_id_key', 'ledger_runs_network_account_fkey', 'ledger_owner_checks_pkey', 'ledger_owner_checks_network_account_fkey', 'ledger_wallet_identities_pkey']) assert(constraints.includes(name), name);
    assert.equal((await db.query<{ name: string }>("SELECT to_regclass('ledger_perps_ranges')::text AS name")).rows[0].name, 'ledger_perps_ranges');
    const generation = '11111111-1111-4111-8111-111111111111';
    await db.exec(`INSERT INTO ledger_accounts(network,account) VALUES('testnet','owner');
      INSERT INTO ledger_runs(generation,network,account) VALUES('${generation}','testnet','owner');
      INSERT INTO ledger_watch_accounts(network,account) VALUES('testnet','owner');
      INSERT INTO ledger_owner_checks(network,account,checked_at,boundary_seqno,boundary_utime,head_vector) VALUES('testnet','owner',now(),10,20,'[]');`);
    assert.deepEqual((await db.query('SELECT pending_accounts,bindings,unresolved,error_code FROM ledger_owner_checks')).rows[0], { pending_accounts: [], bindings: {}, unresolved: false, error_code: null });
    assert((await db.query<{ present: boolean }>('SELECT requested_at IS NOT NULL AS present FROM ledger_watch_accounts')).rows[0].present);
    const coverage = `INSERT INTO ledger_projection_coverage(generation,projection_scope,fingerprint,related_accounts,issues,boundary_seqno,boundary_utime) VALUES('${generation}','{}','fingerprint','[]','[]',10,NULL)`;
    await assert.rejects(() => db.exec(coverage), /check constraint/);
    await db.exec(coverage.replace('10,NULL)', '10,20)'));
    await assert.rejects(() => db.exec('UPDATE ledger_projection_coverage SET boundary_utime=NULL'), /check constraint/);
    await db.exec('UPDATE ledger_projection_coverage SET boundary_seqno=NULL,boundary_utime=NULL');
  } finally { await db.close(); }

  const old = new PGlite();
  try {
    assert.equal(createHash('sha256').update(BASELINE_SQL).digest('hex'), BASELINE_SHA256);
    await old.exec(BASELINE_SQL);
    await assert.rejects(() => new PostgresLedgerStore(poolFor(old)).initialize(), /boundary_seqno.*does not exist/);
    const coverage = (await old.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='ledger_projection_coverage' ORDER BY ordinal_position")).rows.map(row => row.column_name);
    assert.deepEqual(coverage, ['generation', 'projection_scope', 'fingerprint', 'related_accounts', 'issues'], 'Old coverage is refused without migration');
    assert.equal((await old.query<{ count: number }>("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='ledger_watch_accounts' AND column_name='requested_at'")).rows[0].count, 0);
  } finally { await old.close(); }
  console.log('ledger schema idempotence, current contract and prior-schema refusal ok');
}

// Exact 58fe8cd sql/ledger.sql captured as test input; no Git or build output is needed at runtime.
const BASELINE_SHA256 = 'aa10e643de4055c97097c9198a97025c333517e914d829885839c23e42d742d0';
const BASELINE_SQL = String.raw`-- Durable chain evidence. Ledger runs preserve cursor snapshots independently
-- of the bounded, disposable account-history cache.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  network text NOT NULL CHECK (network IN ('mainnet', 'testnet', 'localnet')),
  account text NOT NULL,
  current_generation uuid,
  latest_generation uuid,
  syncing boolean NOT NULL DEFAULT false,
  error_code text,
  synced_at timestamptz,
  checked_at timestamptz,
  attempted_at timestamptz,
  PRIMARY KEY (network, account)
);
CREATE TABLE IF NOT EXISTS ledger_runs (
  generation uuid PRIMARY KEY,
  network text NOT NULL,
  account text NOT NULL,
  head_lt numeric(20,0),
  head_hash text,
  complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  head_observed_at timestamptz NOT NULL DEFAULT now(),
  verified_through timestamptz,
  next_lt numeric(20,0),
  next_hash text,
  source_complete boolean NOT NULL DEFAULT false,
  projected boolean NOT NULL DEFAULT false,
  discovery_revision numeric(30,0),
  FOREIGN KEY (network, account) REFERENCES ledger_accounts(network, account)
);
CREATE TABLE IF NOT EXISTS ledger_transactions (
  network text NOT NULL,
  account text NOT NULL,
  lt numeric(20,0) NOT NULL CHECK (lt > 0),
  hash text NOT NULL,
  utime bigint NOT NULL CHECK (utime >= 0),
  event_id text NOT NULL UNIQUE,
  event jsonb NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (network, account, lt, hash)
);
CREATE INDEX IF NOT EXISTS ledger_transactions_date ON ledger_transactions(network, account, utime);
CREATE TABLE IF NOT EXISTS ledger_membership (
  generation uuid NOT NULL REFERENCES ledger_runs(generation),
  network text NOT NULL,
  account text NOT NULL,
  lt numeric(20,0) NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (generation, lt, hash),
  FOREIGN KEY (network, account, lt, hash) REFERENCES ledger_transactions(network, account, lt, hash)
);
-- Immutable owner projections may group physical transactions from several
-- controlled jetton wallets. Their raw account chains remain separate above.
CREATE TABLE IF NOT EXISTS ledger_projection_events (
  generation uuid NOT NULL REFERENCES ledger_runs(generation),
  event_id text NOT NULL,
  network text NOT NULL,
  account text NOT NULL,
  lt numeric(20,0) NOT NULL,
  hash text NOT NULL,
  utime bigint NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY(generation,event_id)
);
CREATE INDEX IF NOT EXISTS ledger_projection_page ON ledger_projection_events(generation,lt DESC,hash DESC);
CREATE TABLE IF NOT EXISTS ledger_projection_coverage (
  generation uuid PRIMARY KEY REFERENCES ledger_runs(generation),
  projection_scope jsonb NOT NULL,
  fingerprint text NOT NULL,
  related_accounts jsonb NOT NULL,
  issues jsonb NOT NULL
);
-- Owner-specific publication order is allocated under one transactional row
-- lock. It never relies on a global sequence whose commits can arrive out of order.
CREATE TABLE IF NOT EXISTS ledger_discovery_heads (
  network text NOT NULL,
  account text NOT NULL,
  revision numeric(30,0) NOT NULL DEFAULT 0 CHECK(revision >= 0),
  generation uuid NOT NULL REFERENCES ledger_runs(generation),
  PRIMARY KEY(network,account),
  FOREIGN KEY(network,account) REFERENCES ledger_accounts(network,account)
);
CREATE TABLE IF NOT EXISTS ledger_discovery_events (
  network text NOT NULL,
  account text NOT NULL,
  revision numeric(30,0) NOT NULL CHECK(revision > 0),
  generation uuid NOT NULL REFERENCES ledger_runs(generation),
  event_id text NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  discovered_at timestamptz NOT NULL,
  evidence_utime bigint NOT NULL CHECK(evidence_utime >= 0),
  event jsonb NOT NULL,
  PRIMARY KEY(network,account,revision),
  FOREIGN KEY(network,account) REFERENCES ledger_discovery_heads(network,account)
);
CREATE INDEX IF NOT EXISTS ledger_discovery_latest ON ledger_discovery_events(network,account,event_id,revision DESC);
CREATE TABLE IF NOT EXISTS ledger_account_states (
  network text NOT NULL,
  account text NOT NULL,
  lt numeric(20,0) NOT NULL,
  hash text NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY(network,account,lt,hash)
);

-- Only explicitly requested owner accounts are scheduled for graph projection.
CREATE TABLE IF NOT EXISTS ledger_watch_accounts (
  network text NOT NULL,
  account text NOT NULL,
  PRIMARY KEY(network,account),
  FOREIGN KEY(network,account) REFERENCES ledger_accounts(network,account)
);

-- Immutable market evidence is separate from account/owner projections and from
-- display candles. Publication pins qualified code/root bindings and every raw
-- chain dependency; new generations never overwrite older observations.
CREATE TABLE IF NOT EXISTS market_heads (
  network text NOT NULL CHECK (network IN ('mainnet','testnet','localnet')),
  pool text NOT NULL,
  current_generation uuid,
  PRIMARY KEY(network,pool)
);
CREATE TABLE IF NOT EXISTS market_generations (
  generation uuid PRIMARY KEY,
  network text NOT NULL,
  pool text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(network,pool,fingerprint),
  FOREIGN KEY(network,pool) REFERENCES market_heads(network,pool)
);
CREATE TABLE IF NOT EXISTS market_observations (
  generation uuid NOT NULL REFERENCES market_generations(generation),
  observation_id text NOT NULL,
  execution_utime bigint NOT NULL CHECK (execution_utime >= 0),
  observation jsonb NOT NULL,
  PRIMARY KEY(generation,observation_id)
);
CREATE INDEX IF NOT EXISTS market_observations_page ON market_observations(generation,execution_utime DESC,observation_id DESC);
CREATE TABLE IF NOT EXISTS market_candidates (
  generation uuid NOT NULL REFERENCES market_generations(generation),
  candidate_id text NOT NULL,
  execution_utime bigint NOT NULL CHECK (execution_utime >= 0),
  candidate jsonb NOT NULL,
  PRIMARY KEY(generation,candidate_id)
);
CREATE INDEX IF NOT EXISTS market_candidates_page ON market_candidates(generation,execution_utime DESC,candidate_id DESC);

-- Raw archival root state at a masterchain boundary, separate from mutable
-- display metadata and from transaction-state caches. Parsed precision is always
-- requalified against the current explicit root-code binding before publication.
CREATE TABLE IF NOT EXISTS market_root_archive_states (
  network text NOT NULL CHECK (network IN ('mainnet','testnet','localnet')),
  root text NOT NULL,
  seqno bigint NOT NULL CHECK (seqno >= 0),
  snapshot jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY(network,root,seqno)
);

-- Scoped perps proofs are independent of all-history cursors. A completed row is
-- immutable; its physical chains share one masterchain boundary. Only this
-- current first-release schema is supported.
CREATE TABLE IF NOT EXISTS ledger_perps_ranges (
  generation uuid PRIMARY KEY,
  generation_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  network text NOT NULL CHECK (network IN ('mainnet','testnet','localnet')),
  account text NOT NULL,
  from_utime bigint NOT NULL CHECK (from_utime >= 0),
  to_utime bigint NOT NULL CHECK (to_utime > from_utime),
  binding text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','complete','failed')),
  backoff_seconds integer NOT NULL DEFAULT 5 CHECK (backoff_seconds BETWEEN 5 AND 300),
  retry_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  published_at timestamptz,
  snapshot jsonb,
  error_code text,
  CHECK ((status = 'complete' AND snapshot IS NOT NULL AND published_at IS NOT NULL) OR
         (status <> 'complete' AND snapshot IS NULL AND published_at IS NULL))
);
CREATE INDEX IF NOT EXISTS ledger_perps_ranges_lookup
  ON ledger_perps_ranges(network,account,from_utime,to_utime,binding,generation_order DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_perps_ranges_active
  ON ledger_perps_ranges(network,account,from_utime,to_utime,binding)
  WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS ledger_perps_ranges_pending
  ON ledger_perps_ranges(network,created_at,generation_order) WHERE status IN ('pending','running');
`;
main().catch(error => { console.error(error); process.exitCode = 1; });
