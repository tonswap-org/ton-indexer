CREATE TABLE IF NOT EXISTS platform_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS platform_challenges (
 payload_hash text PRIMARY KEY, wallet_address text NOT NULL, network text NOT NULL CHECK (network IN ('mainnet','testnet')),
 domain text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_sessions (
 id uuid PRIMARY KEY, token_hash text UNIQUE NOT NULL, wallet_address text NOT NULL,
 network text NOT NULL CHECK (network IN ('mainnet','testnet')), csrf_token text NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sessions_wallet ON platform_sessions(network,wallet_address);
CREATE TABLE IF NOT EXISTS platform_preferences (
 wallet_address text NOT NULL, network text NOT NULL, preferences jsonb NOT NULL,
 activity_enabled_at timestamptz, wallet_protocol_enabled_at timestamptz,
 CHECK ((jsonb_typeof(preferences->'activity')='boolean' AND (preferences->>'activity')::boolean = (activity_enabled_at IS NOT NULL)) IS TRUE),
 CHECK ((jsonb_typeof(preferences->'walletProtocol')='boolean' AND (preferences->>'walletProtocol')::boolean = (wallet_protocol_enabled_at IS NOT NULL)) IS TRUE),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(network,wallet_address)
);
CREATE TABLE IF NOT EXISTS platform_subscriptions (
 id uuid PRIMARY KEY, wallet_address text NOT NULL, network text NOT NULL, session_id uuid REFERENCES platform_sessions(id),
 endpoint_hash text UNIQUE NOT NULL, encrypted_subscription text NOT NULL,
 application_server_key text NOT NULL CHECK (application_server_key ~ '^[A-Za-z0-9_-]{87}$'),
 device_name text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_sent_at timestamptz, retired_at timestamptz, retirement_reason text
);
CREATE INDEX IF NOT EXISTS platform_subscriptions_wallet ON platform_subscriptions(network,wallet_address) WHERE active;
CREATE TABLE IF NOT EXISTS platform_price_rules (
 id uuid PRIMARY KEY, wallet_address text NOT NULL, network text NOT NULL CHECK(network IN ('mainnet','testnet')),
 asset_kind text NOT NULL CHECK(asset_kind='ton'), asset_id text NOT NULL,
 CHECK((asset_kind='listed' AND asset_id ~ '^[a-z0-9][a-z0-9-]{0,79}$') OR
       (asset_kind='ton' AND (asset_id='native' OR asset_id ~ '^(-1|0):[a-f0-9]{64}$'))),
 currency text NOT NULL CHECK(currency='T3'),
 quote_asset_id text NOT NULL CHECK(quote_asset_id ~ '^(-1|0):[a-f0-9]{64}$'),
 release_manifest_hash text NOT NULL CHECK(release_manifest_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL DEFAULT 'percent' CHECK(kind IN ('percent','target')),
 threshold_percent numeric, target_price numeric, direction text NOT NULL DEFAULT 'both' CHECK(direction IN ('above','below','both')),
 CHECK((kind='percent' AND threshold_percent IS NOT NULL AND threshold_percent>0 AND target_price IS NULL) OR
       (kind='target' AND target_price IS NOT NULL AND target_price>0 AND threshold_percent IS NULL AND direction IN ('above','below'))),
 enabled boolean NOT NULL DEFAULT true, last_direction text CHECK (last_direction IN ('up','down','inside')),
 last_notified_at timestamptz, last_observed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(network,wallet_address,asset_kind,asset_id)
);
CREATE TABLE IF NOT EXISTS platform_price_rule_monitoring (
 rule_id uuid PRIMARY KEY REFERENCES platform_price_rules(id) ON DELETE CASCADE,
 definition_revision text NOT NULL, started_at timestamptz NOT NULL, checked_at timestamptz NOT NULL,
 observed_at timestamptz, source text CHECK(source IN ('tonswap-dex')),
 outcome text NOT NULL CHECK(outcome IN ('observed','stale','unavailable')), issue text,
 CHECK(outcome<>'observed' OR (observed_at IS NOT NULL AND source IS NOT NULL AND issue IS NULL))
);
CREATE TABLE IF NOT EXISTS platform_notifications (
 id uuid PRIMARY KEY, wallet_address text NOT NULL, network text NOT NULL,
 category text NOT NULL CHECK(category IN ('priceAlerts','activity','governance','walletProtocol')),
 source_event_id text NOT NULL, title text NOT NULL, body text NOT NULL, href text NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}', occurred_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 UNIQUE(network,wallet_address,source_event_id)
);
CREATE INDEX IF NOT EXISTS platform_notifications_inbox ON platform_notifications(network,wallet_address,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS platform_jobs (
 id uuid PRIMARY KEY, kind text NOT NULL, dedupe_key text UNIQUE NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','leased','done','failed')),
 available_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_jobs_ready ON platform_jobs(available_at) WHERE state IN ('ready','leased');
CREATE TABLE IF NOT EXISTS platform_checkpoints (
 key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_quote_cache (
 key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_historical_anchor_revisions (
 id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), request_key text NOT NULL,
 fetched_at timestamptz NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((jsonb_typeof(evidence)='object' AND jsonb_typeof(evidence->'fetchedAt')='string'
   AND (evidence->>'fetchedAt')::timestamptz=fetched_at) IS TRUE)
);
CREATE INDEX IF NOT EXISTS platform_historical_anchor_request ON platform_historical_anchor_revisions(request_key,fetched_at);
CREATE FUNCTION platform_preserve_historical_anchor_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Historical anchor revisions are immutable';
END;
$$;
CREATE TRIGGER platform_historical_anchor_immutable BEFORE UPDATE OR DELETE ON platform_historical_anchor_revisions
 FOR EACH ROW EXECUTE FUNCTION platform_preserve_historical_anchor_revision();
CREATE TRIGGER platform_historical_anchor_no_truncate BEFORE TRUNCATE ON platform_historical_anchor_revisions
 FOR EACH STATEMENT EXECUTE FUNCTION platform_preserve_historical_anchor_revision();
CREATE TABLE IF NOT EXISTS platform_historical_fx_revisions (
 id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), request_key text NOT NULL,
 fetched_at timestamptz NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((jsonb_typeof(evidence)='object' AND jsonb_typeof(evidence->'fetchedAt')='string'
   AND (evidence->>'fetchedAt')::timestamptz=fetched_at) IS TRUE)
);
CREATE INDEX IF NOT EXISTS platform_historical_fx_request ON platform_historical_fx_revisions(request_key,fetched_at);
CREATE FUNCTION platform_preserve_historical_fx_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Historical FX revisions are immutable';
END;
$$;
CREATE TRIGGER platform_historical_fx_immutable BEFORE UPDATE OR DELETE ON platform_historical_fx_revisions
 FOR EACH ROW EXECUTE FUNCTION platform_preserve_historical_fx_revision();
CREATE TRIGGER platform_historical_fx_no_truncate BEFORE TRUNCATE ON platform_historical_fx_revisions
 FOR EACH STATEMENT EXECUTE FUNCTION platform_preserve_historical_fx_revision();
CREATE TABLE IF NOT EXISTS platform_historical_daily_revisions (
 id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'), request_key text NOT NULL,
 fetched_at timestamptz NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((jsonb_typeof(evidence)='object' AND jsonb_typeof(evidence->'fetchedAt')='string'
   AND (evidence->>'fetchedAt')::timestamptz=fetched_at) IS TRUE)
);
CREATE INDEX IF NOT EXISTS platform_historical_daily_request ON platform_historical_daily_revisions(request_key,fetched_at);
CREATE FUNCTION platform_preserve_historical_daily_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Historical daily price revisions are immutable';
END;
$$;
CREATE TRIGGER platform_historical_daily_immutable BEFORE UPDATE OR DELETE ON platform_historical_daily_revisions
 FOR EACH ROW EXECUTE FUNCTION platform_preserve_historical_daily_revision();
CREATE TRIGGER platform_historical_daily_no_truncate BEFORE TRUNCATE ON platform_historical_daily_revisions
 FOR EACH STATEMENT EXECUTE FUNCTION platform_preserve_historical_daily_revision();
CREATE TABLE IF NOT EXISTS platform_source_events (
 id text NOT NULL, network text NOT NULL, wallet_address text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(network,wallet_address,id)
);
CREATE TABLE IF NOT EXISTS platform_worker_status (
 id text PRIMARY KEY, last_seen_at timestamptz NOT NULL DEFAULT now(), last_error text
);
