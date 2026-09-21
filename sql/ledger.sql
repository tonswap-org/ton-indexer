-- Durable chain evidence. Ledger runs preserve cursor snapshots independently
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
