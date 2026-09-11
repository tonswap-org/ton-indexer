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
