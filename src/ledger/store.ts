import { AsyncLocalStorage } from 'node:async_hooks';
import { decodeBindings } from './publication';
import { discoveryPage, publishDiscoveries } from './discovery';
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Network } from "../models";
import type { RawTransaction } from "../data/dataSource";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
import type {
  LedgerEvent,
  LedgerProjection,
  LedgerProjectionScope,
  LedgerPage,
  LedgerQuery,
  LedgerRelatedAccount,
  LedgerDiscoveryQuery,
} from "./types";

export interface LedgerSqlClient {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
  release?(): void;
}
export interface LedgerSqlPool extends LedgerSqlClient {
  connect(): Promise<LedgerSqlClient>;
  end(): Promise<void>;
}
/** Instrument only the current owner cycle; concurrent cycles remain separate. */
export const ledgerCycleIo = new AsyncLocalStorage<{ sourceMs: number; databaseMs: number }>();
const timedPools = new WeakMap<LedgerSqlPool, LedgerSqlPool>();
function timedPool(pool: LedgerSqlPool): LedgerSqlPool {
  const existing = timedPools.get(pool); if (existing) return existing;
  const query = (client: LedgerSqlClient) => async (sql: string, params?: any[]) => {
    const context = ledgerCycleIo.getStore(), started = performance.now();
    try { return await client.query(sql, params); }
    finally { if (context) context.databaseMs += performance.now() - started; }
  };
  const result: LedgerSqlPool = { query: query(pool), end: () => pool.end(), connect: async () => {
    const client = await pool.connect(); return { query: query(client), release: () => client.release?.() };
  } };
  timedPools.set(pool, result); timedPools.set(result, result); return result;
}

type Cursor = {
  generation: string;
  network: Network;
  account: string;
  lt: string;
  hash: string;
  from: number | null;
  to: number | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validProjectionScope(
  value: unknown,
  owner?: string,
): value is LedgerProjectionScope {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const scope = value as LedgerProjectionScope;
    if (Object.keys(scope).sort().join(",") !== "kind,owner,physicalAccounts" ||
      scope.kind !== "owner" || typeof scope.owner !== "string" ||
      canonicalLedgerAddress(scope.owner) !== scope.owner ||
      (owner !== undefined && scope.owner !== owner) ||
      !Array.isArray(scope.physicalAccounts) || !scope.physicalAccounts.length) return false;
    return scope.physicalAccounts.includes(scope.owner) && scope.physicalAccounts.every((account, index) =>
      typeof account === "string" && canonicalLedgerAddress(account) === account &&
      (index === 0 || scope.physicalAccounts[index - 1] < account));
  } catch { return false; }
}

function assertProjection(projection: LedgerProjection, network?: Network, owner?: string) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection) ||
    Object.keys(projection).sort().join(",") !== "events,projectionScope" ||
    !Array.isArray(projection.events) || !validProjectionScope(projection.projectionScope, owner))
    throw new Error("Invalid ledger projection scope");
  if (projection.events.some(event => !event || event.account !== projection.projectionScope.owner ||
    !["mainnet", "testnet", "localnet"].includes(event.network) ||
    (network !== undefined && event.network !== network)))
    throw new Error("Ledger projection event owner or network mismatch");
}

export function projectionFingerprint(
  projection: LedgerProjection,
  related: LedgerRelatedAccount[],
  issues: string[],
) {
  assertProjection(projection);
  const stable = (value: any): any =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  // A successful identical getter recheck advances checkedAt without copying the
  // full ledger merely because its observation timestamp changed.
  const fingerprintEvents = structuredClone(projection.events);
  for (const event of fingerprintEvents) {
    for (const movement of event.movements)
      if (movement.evidence.getter) movement.evidence.getter.observedAt = "";
  }
  const snapshot = {
    decoder: "exact-ledger-v21",
    projectionScope: projection.projectionScope,
    events: [...fingerprintEvents].sort((a, b) => a.id.localeCompare(b.id)),
    related: related
      .map(({ account, role, historyComplete }) => ({ account, role, historyComplete }))
      .sort((a, b) => a.account.localeCompare(b.account)),
    issues: issues.filter(issue => issue !== "related_account_refresh_pending").sort(),
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(snapshot)))
    .digest("hex");
}

export type OwnerCheckRecord = {
  checkedAt: string;
  boundary: { seqno: number; utime: number };
  headVector: Array<{ account: string; headLt: string | null; headHash: string | null }>;
  pendingAccounts: string[];
  bindings: Record<string, boolean>;
  unresolved: boolean;
  errorCode: string | null;
};

export class LedgerCursorError extends Error {}

export class PostgresLedgerStore {
  readonly pool: LedgerSqlPool;
  constructor(pool: LedgerSqlPool) { this.pool = timedPool(pool); }

  /** Brief admission transaction: contention waits, capacity alone returns false. */
  async admitWatch(network: Network, account: string, maximum: number) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const schema = (await client.query('SELECT current_schema() AS schema')).rows[0]?.schema;
      if (typeof schema !== 'string' || !schema) throw new Error('ledger_schema_unavailable');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ledger:${schema}:${network}:watch-admission`]);
      const existing = (await client.query('SELECT 1 FROM ledger_watch_accounts WHERE network=$1 AND account=$2', [network, account])).rows.length > 0;
      if (!existing) {
        const count = Number((await client.query('SELECT count(*)::text AS count FROM ledger_watch_accounts WHERE network=$1', [network])).rows[0].count);
        if (count >= maximum) { await client.query('COMMIT'); return false; }
        await client.query('INSERT INTO ledger_accounts(network,account) VALUES($1,$2) ON CONFLICT DO NOTHING', [network, account]);
      }
      await client.query(`INSERT INTO ledger_watch_accounts(network,account,requested_at) VALUES($1,$2,clock_timestamp())
        ON CONFLICT(network,account) DO UPDATE SET requested_at=EXCLUDED.requested_at`, [network, account]);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release?.(); }
  }

  async activeWatches(network: Network) {
    return (await this.pool.query(`SELECT w.account FROM ledger_watch_accounts w
      LEFT JOIN ledger_owner_checks c USING(network,account)
      WHERE w.network=$1 AND (w.requested_at >= now() - interval '15 minutes' OR c.unresolved=true)
      ORDER BY w.requested_at DESC,w.account`, [network])).rows.map(row => row.account as string);
  }

  async firstPublicationLatencies(generation: string) {
    return (await this.pool.query(`SELECT EXTRACT(EPOCH FROM (d.discovered_at-to_timestamp((d.event->>'utime')::double precision)))*1000 AS latency
      FROM ledger_discovery_events d WHERE d.generation=$1 AND NOT EXISTS (
        SELECT 1 FROM ledger_discovery_events older WHERE older.network=d.network AND older.account=d.account
          AND older.event_id=d.event_id AND older.revision<d.revision)`, [generation])).rows.map(row => Number(row.latency));
  }

  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended('tonswap:ledger:schema',0))",
      );
      await client.query(
        readFileSync(resolve(__dirname, "../../sql/ledger.sql"), "utf8"),
      );
      // This first-release schema must already be canonical; never infer old scope.
      await client.query("SELECT projection_scope,boundary_seqno,boundary_utime FROM ledger_projection_coverage LIMIT 0");
      await client.query("SELECT requested_at FROM ledger_watch_accounts LIMIT 0");
      await client.query("SELECT network,account,checked_at,boundary_seqno,boundary_utime,head_vector,pending_accounts,bindings,unresolved,error_code FROM ledger_owner_checks LIMIT 0");
      await client.query("SELECT network,wallet,owner,master,code_hash,verified_seqno FROM ledger_wallet_identities LIMIT 0");
      await client.query("SELECT discovery_revision FROM ledger_runs LIMIT 0");
      await client.query("SELECT generation_order,backoff_seconds,retry_after FROM ledger_perps_ranges LIMIT 0");
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended('tonswap:ledger:schema',0))",
      );
      client.release?.();
    }
  }

  async withAccountLock(
    network: Network,
    account: string,
    work: () => Promise<void>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    let key: string | undefined;
    let locked = false;
    try {
      // Resolve on the lock's own connection: search_path is session state.
      const schema = (await client.query("SELECT current_schema() AS schema")).rows[0]?.schema;
      if (typeof schema !== "string" || !schema) throw new Error("ledger_schema_unavailable");
      key = `ledger:${schema}:${network}:${account}`;
      locked =
        (
          await client.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [key],
          )
        ).rows[0]?.locked === true;
      if (!locked) return false;
      await work();
      return true;
    } finally {
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [key],
        );
      client.release?.();
    }
  }

  async account(network: Network, account: string) {
    return (
      (
        await this.pool.query(
          `SELECT a.*, r.head_lt::text, r.head_hash, r.complete
      FROM ledger_accounts a LEFT JOIN ledger_runs r ON r.generation=a.current_generation
      WHERE a.network=$1 AND a.account=$2`,
          [network, account],
        )
      ).rows[0] ?? null
    );
  }

  /** Physical history and published owner projection have distinct authority.
   * A dependency can reuse any genesis-linked physical run, including completed
   * unpublished owner backfill, without replacing the owner's current page. */
  async physicalAccount(network: Network, account: string) {
    const state = await this.account(network, account);
    if (!state) return null;
    const run = (await this.pool.query(`SELECT generation,head_lt::text,head_hash,source_complete
      FROM ledger_runs WHERE network=$1 AND account=$2 AND source_complete=true
      ORDER BY ledger_runs.head_lt DESC NULLS LAST,created_at DESC,generation DESC LIMIT 1`, [network, account])).rows[0];
    return { ...state, current_generation: run?.generation ?? null, head_lt: run?.head_lt ?? null,
      head_hash: run?.head_hash ?? null, complete: run?.source_complete === true };
  }

  async ownerCheck(network: Network, account: string): Promise<OwnerCheckRecord | null> {
    const row = (await this.pool.query(
      "SELECT * FROM ledger_owner_checks WHERE network=$1 AND account=$2", [network, account],
    )).rows[0];
    return row ? {
      checkedAt: new Date(row.checked_at).toISOString(),
      boundary: { seqno: Number(row.boundary_seqno), utime: Number(row.boundary_utime) },
      headVector: row.head_vector, pendingAccounts: row.pending_accounts,
      bindings: row.bindings, unresolved: row.unresolved, errorCode: row.error_code,
    } : null;
  }

  async saveOwnerCheck(network: Network, account: string, record: OwnerCheckRecord, client: LedgerSqlClient = this.pool): Promise<void> {
    await client.query(`INSERT INTO ledger_owner_checks
      (network,account,checked_at,boundary_seqno,boundary_utime,head_vector,pending_accounts,bindings,unresolved,error_code)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
      ON CONFLICT(network,account) DO UPDATE SET checked_at=EXCLUDED.checked_at,
      boundary_seqno=EXCLUDED.boundary_seqno,boundary_utime=EXCLUDED.boundary_utime,
      head_vector=EXCLUDED.head_vector,pending_accounts=EXCLUDED.pending_accounts,
      bindings=EXCLUDED.bindings,unresolved=EXCLUDED.unresolved,error_code=EXCLUDED.error_code`,
      [network, account, record.checkedAt, record.boundary.seqno, record.boundary.utime,
        JSON.stringify(record.headVector), JSON.stringify(record.pendingAccounts),
        JSON.stringify(record.bindings), record.unresolved, record.errorCode]);
  }

  async begin(
    network: Network,
    account: string,
    generation: string,
    head?: { lt: string; hash: string },
    observedAt = new Date().toISOString(),
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ledger_accounts(network, account, syncing,attempted_at) VALUES($1,$2,true,now())
        ON CONFLICT(network,account) DO UPDATE SET attempted_at=now(),syncing=true,error_code=NULL`,
        [network, account],
      );
      await client.query(
        "INSERT INTO ledger_runs(generation,network,account,head_lt,head_hash,head_observed_at,next_lt,next_hash) VALUES($1,$2,$3,$4,$5,$6,$4,$5)",
        [
          generation,
          network,
          account,
          head?.lt ?? null,
          head?.hash ?? null,
          observedAt,
        ],
      );
      await client.query(
        "UPDATE ledger_accounts SET latest_generation=$3 WHERE network=$1 AND account=$2",
        [network, account, generation],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  async append(
    generation: string,
    events: LedgerEvent[],
    raws: RawTransaction[],
  ) {
    if (events.length !== raws.length)
      throw new Error("Ledger evidence count mismatch");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await this.assertWritable(client, generation);
      // A generation represents one physical account chain. Owner projections
      // may group related chains later; raw membership must never mix them.
      for (let i = 0; i < events.length; i++) {
        const event = events[i], raw = raws[i];
        if (event.network !== run.network || event.account !== run.account)
          throw new Error("Ledger evidence account or network does not match generation scope");
        const hash = canonicalLedgerHash(raw.hash);
        const id = createHash("sha256").update(`${event.network}:${event.account}:${raw.lt}:${hash}`).digest("hex");
        if (event.lt !== raw.lt || event.hash !== hash || event.txId !== `${raw.lt}:${hash}` ||
          event.id !== id || event.utime !== raw.utime || event.status !== raw.status ||
          (raw.status !== "success" && raw.status !== "failed") || raw.success !== (raw.status === "success"))
          throw new Error("Ledger event does not match its original physical transaction");
      }
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        await client.query(
          `INSERT INTO ledger_transactions(network,account,lt,hash,utime,event_id,event,raw)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
          ON CONFLICT(network,account,lt,hash) DO NOTHING`,
          [
            e.network,
            e.account,
            e.lt,
            e.hash,
            e.utime,
            e.id,
            JSON.stringify(e),
            JSON.stringify(raws[i]),
          ],
        );
        await client.query(
          `INSERT INTO ledger_projection_events(generation,event_id,network,account,lt,hash,utime,event)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
          [
            generation,
            e.id,
            e.network,
            e.account,
            e.lt,
            e.hash,
            e.utime,
            JSON.stringify(e),
          ],
        );
        await client.query(
          `INSERT INTO ledger_membership(generation,network,account,lt,hash) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT DO NOTHING`,
          [generation, e.network, e.account, e.lt, e.hash],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  async copyKnownTail(
    generation: string,
    previousGeneration: string,
    lt: string,
    hash: string,
  ): Promise<boolean> {
    await this.assertWritable(this.pool, generation);
    const match = await this.pool.query(
      `SELECT 1 FROM ledger_membership m JOIN ledger_runs r USING(generation)
      WHERE m.generation=$1 AND m.lt=$2 AND m.hash=$3 AND r.complete=true`,
      [previousGeneration, lt, hash],
    );
    if (!match.rows.length) return false;
    await this.pool.query(
      `INSERT INTO ledger_membership(generation,network,account,lt,hash)
      SELECT $1,network,account,lt,hash FROM ledger_membership WHERE generation=$2 AND lt <= $3
      ON CONFLICT DO NOTHING`,
      [generation, previousGeneration, lt],
    );
    await this.pool.query(
      `INSERT INTO ledger_projection_events(generation,event_id,network,account,lt,hash,utime,event)
      SELECT $1,t.event_id,t.network,t.account,t.lt,t.hash,t.utime,t.event FROM ledger_membership m JOIN ledger_transactions t USING(network,account,lt,hash)
      WHERE m.generation=$1 ON CONFLICT DO NOTHING`,
      [generation],
    );
    return true;
  }

  /** Reuse a chain linked to genesis without publishing its owner projection.
   * Callers hold the account lock. Scope and exact tail membership are checked;
   * no projected events or coverage are copied from the source generation. */
  async copySourceTail(generation: string, sourceGeneration: string, lt: string, hash: string): Promise<boolean> {
    const target = await this.assertWritable(this.pool, generation);
    const match = await this.pool.query(`SELECT 1 FROM ledger_membership m JOIN ledger_runs r USING(generation)
      WHERE m.generation=$1 AND m.lt=$2 AND m.hash=$3 AND r.source_complete=true
      AND r.network=$4 AND r.account=$5`, [sourceGeneration, lt, hash, target.network, target.account]);
    if (!match.rows.length) return false;
    await this.pool.query(`INSERT INTO ledger_membership(generation,network,account,lt,hash)
      SELECT $1,network,account,lt,hash FROM ledger_membership WHERE generation=$2 AND lt <= $3
      ON CONFLICT DO NOTHING`, [generation, sourceGeneration, lt]);
    await this.pool.query(`INSERT INTO ledger_projection_events(generation,event_id,network,account,lt,hash,utime,event)
      SELECT $1,t.event_id,t.network,t.account,t.lt,t.hash,t.utime,t.event FROM ledger_membership m
      JOIN ledger_transactions t USING(network,account,lt,hash) WHERE m.generation=$1 ON CONFLICT DO NOTHING`, [generation]);
    return true;
  }

  async rawHistory(
    generation: string,
  ): Promise<Array<{ account: string; raw: RawTransaction }>> {
    return (
      await this.pool.query(
        `SELECT t.account,t.raw FROM ledger_membership m JOIN ledger_transactions t USING(network,account,lt,hash) WHERE m.generation=$1 ORDER BY t.lt ASC,t.hash ASC`,
        [generation],
      )
    ).rows;
  }

  async project(
    generation: string,
    projection: LedgerProjection,
    related: LedgerRelatedAccount[],
    issues: string[],
    boundary?: { seqno: number; utime: number },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await this.assertWritable(client, generation);
      assertProjection(projection, run.network, run.account);
      await client.query(
        "UPDATE ledger_runs SET projected=true WHERE generation=$1",
        [generation],
      );
      await client.query(
        "DELETE FROM ledger_projection_events WHERE generation=$1",
        [generation],
      );
      for (const e of projection.events)
        await client.query(
          `INSERT INTO ledger_projection_events(generation,event_id,network,account,lt,hash,utime,event) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            generation,
            e.id,
            e.network,
            e.account,
            e.lt,
            e.hash,
            e.utime,
            JSON.stringify(e),
          ],
        );
      await client.query(
        `INSERT INTO ledger_projection_coverage(generation,projection_scope,related_accounts,issues,fingerprint,boundary_seqno,boundary_utime) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7) ON CONFLICT(generation) DO UPDATE SET projection_scope=EXCLUDED.projection_scope,related_accounts=EXCLUDED.related_accounts,issues=EXCLUDED.issues,fingerprint=EXCLUDED.fingerprint,boundary_seqno=EXCLUDED.boundary_seqno,boundary_utime=EXCLUDED.boundary_utime`,
        [
          generation,
          JSON.stringify(projection.projectionScope),
          JSON.stringify(related),
          JSON.stringify(issues),
          projectionFingerprint(projection, related, issues),
          boundary?.seqno ?? null, boundary?.utime ?? null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  private async assertWritable(client: LedgerSqlClient, generation: string) {
    const run = (
      await client.query(
        "SELECT complete,projected,network,account FROM ledger_runs WHERE generation=$1 FOR UPDATE",
        [generation],
      )
    ).rows[0];
    if (!run || run.complete)
      throw new Error("Ledger snapshot is not writable");
    return run;
  }

  async complete(
    network: Network,
    account: string,
    generation: string,
    checkedAt: string | null = null,
    ownerCheck?: OwnerCheckRecord,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await this.assertWritable(client, generation);
      if (run.network !== network || run.account !== account)
        throw new Error("Ledger publication owner or network mismatch");
      const current = (await client.query(`SELECT r.projected FROM ledger_accounts a
        LEFT JOIN ledger_runs r ON r.generation=a.current_generation
        WHERE a.network=$1 AND a.account=$2 FOR UPDATE OF a`, [network, account])).rows[0];
      await client.query(
        "UPDATE ledger_runs SET complete=true,source_complete=true,next_lt=NULL,next_hash=NULL,published_at=clock_timestamp(),verified_through=COALESCE($2::timestamptz,head_observed_at) WHERE generation=$1",
        [generation, checkedAt],
      );
      await publishDiscoveries(client, network, account, generation);
      if (run.projected || !current?.projected) {
        await client.query(
          `UPDATE ledger_accounts SET current_generation=$3,latest_generation=$3,syncing=false,error_code=NULL,synced_at=now(),checked_at=(SELECT verified_through FROM ledger_runs WHERE generation=$3)
          WHERE network=$1 AND account=$2`, [network, account, generation]);
      } else {
        // A physical refresh of another watched owner must never erase that
        // owner's publication, discovery head, checkpoint or observation times.
        await client.query('UPDATE ledger_accounts SET latest_generation=$3,syncing=false WHERE network=$1 AND account=$2',
          [network, account, generation]);
      }
      if (ownerCheck) {
        if (decodeBindings(ownerCheck.bindings)?.published?.generation !== generation)
          throw new Error('Ledger publication checkpoint generation mismatch');
        await this.saveOwnerCheck(network, account, ownerCheck, client);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  async failed(network: Network, account: string, code: string) {
    await this.pool.query(
      "UPDATE ledger_accounts SET syncing=false,error_code=$3 WHERE network=$1 AND account=$2",
      [network, account, code],
    );
  }

  async discoveries(network: Network, account: string, query: LedgerDiscoveryQuery) {
    return discoveryPage(this.pool, network, account, query,
      async generation => (await this.page(network, account, { generation, limit: 1 }, !query.cursor)).coverage);
  }

  async page(
    network: Network,
    account: string,
    query: LedgerQuery = {},
    mergeCurrentCheck = false,
  ): Promise<LedgerPage> {
    const state = await this.account(network, account);
    const from = query.fromUtime ?? null;
    const to = query.toUtime ?? null;
    let cursor: Cursor | null = null;
    if (query.cursor) {
      try {
        if (query.cursor.length > 2048) throw new Error("long");
        cursor = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8"),
        );
        if (
          !cursor ||
          !UUID.test(cursor.generation) ||
          cursor.network !== network ||
          cursor.account !== account ||
          cursor.from !== from ||
          cursor.to !== to ||
          !/^[1-9]\d{0,19}$/.test(cursor.lt) ||
          typeof cursor.hash !== "string" ||
          cursor.hash.length > 64
        )
          throw new Error("shape");
      } catch {
        throw new LedgerCursorError(
          "Invalid ledger cursor or changed date bounds",
        );
      }
    }
    const generation =
      cursor?.generation ??
      query.generation ??
      state?.current_generation ??
      state?.latest_generation;
    if (!generation)
      return {
        network,
        account,
        events: [],
        nextCursor: null,
        coverage: {
          generation: null,
          projectionScope: null,
          publishedAt: null,
          headObservedAt: null,
          checkedAt: null, boundary: null, refreshPending: [],
          snapshotComplete: false,
          historyComplete: false,
          decodingComplete: false,
          syncing: state?.syncing ?? false,
          oldestUtime: null,
          newestUtime: null,
          syncedAt: null,
          issues: ["history_not_indexed"],
        },
      };
    const run = (
      await this.pool.query(
        "SELECT complete,projected,published_at,head_observed_at,verified_through FROM ledger_runs WHERE generation=$1 AND network=$2 AND account=$3",
        [generation, network, account],
      )
    ).rows[0];
    if (!run) throw new LedgerCursorError("Ledger cursor snapshot not found");
    if (!run.complete || !run.projected)
      return {
        network,
        account,
        events: [],
        nextCursor: null,
        coverage: {
          generation,
          projectionScope: null,
          publishedAt: null,
          headObservedAt: run.head_observed_at
            ? new Date(run.head_observed_at).toISOString()
            : null,
          checkedAt: null, boundary: null, refreshPending: [],
          snapshotComplete: false,
          historyComplete: false,
          decodingComplete: false,
          syncing: state?.syncing ?? false,
          oldestUtime: null,
          newestUtime: null,
          syncedAt: null,
          issues: [
            run.complete ? "owner_projection_pending" : "history_incomplete",
            ...(state?.error_code ? [String(state.error_code)] : []),
          ],
        },
      };
    const projection = (
      await this.pool.query(
        "SELECT projection_scope,related_accounts,issues,fingerprint,boundary_seqno,boundary_utime FROM ledger_projection_coverage WHERE generation=$1",
        [generation],
      )
    ).rows[0];
    if (!projection || !validProjectionScope(projection.projection_scope, account) ||
      !Array.isArray(projection.related_accounts) || !Array.isArray(projection.issues) ||
      projection.issues.some((issue: unknown) => typeof issue !== "string") ||
      typeof projection.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(projection.fingerprint))
      return {
        network, account, events: [], nextCursor: null,
        coverage: {
          generation, projectionScope: null, publishedAt: null,
          headObservedAt: run.head_observed_at ? new Date(run.head_observed_at).toISOString() : null,
          checkedAt: null, boundary: null, refreshPending: [], snapshotComplete: false, historyComplete: false, decodingComplete: false,
          syncing: state?.syncing ?? false, oldestUtime: null, newestUtime: null, syncedAt: null,
          issues: ["owner_projection_metadata_invalid"],
        },
      };
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const params = [generation, network, account, from, to];
    const where = `t.generation=$1 AND t.network=$2 AND t.account=$3 AND ($4::bigint IS NULL OR t.utime >= $4) AND ($5::bigint IS NULL OR t.utime < $5)`;
    const join = "FROM ledger_projection_events t";
    const rows = (
      await this.pool.query(
        `SELECT t.event ${join} WHERE ${where}
      AND ($6::numeric IS NULL OR (t.lt,t.hash)<($6::numeric,$7::text)) ORDER BY t.lt DESC,t.hash DESC LIMIT $8`,
        [...params, cursor?.lt ?? null, cursor?.hash ?? null, limit + 1],
      )
    ).rows;
    const events = rows.slice(0, limit).map((row) => row.event as LedgerEvent);
    const extent = (
      await this.pool.query(
        `SELECT min(t.utime)::text AS oldest,max(t.utime)::text AS newest ${join} WHERE ${where}`,
        params,
      )
    ).rows[0];
    const issueRows = (
      await this.pool.query(
        `SELECT DISTINCT jsonb_array_elements_text(t.event->'issues') AS issue ${join} WHERE ${where}`,
        params,
      )
    ).rows;
    const related = projection?.related_accounts as
      LedgerRelatedAccount[] | undefined;
    const graphComplete =
      !related?.some((item) => !item.historyComplete) &&
      !(projection?.issues ?? []).some((issue: string) =>
        [
          "configured_wallet_discovery_unresolved",
          "related_account_limit_reached",
          "related_account_history_incomplete",
        ].includes(issue),
      );
    const issues = [
      ...issueRows.map((row) => String(row.issue)),
      ...(projection?.issues ?? []),
    ];
    if (related?.some((item) => !item.historyComplete))
      issues.push("related_account_history_incomplete");
    if (!run.complete) issues.push("history_incomplete");

    const latestCheck = !cursor && (!query.generation || mergeCurrentCheck) && state?.current_generation === generation
      ? await this.ownerCheck(network, account) : null;
    // Publication can race this read. A newer check must never be merged into
    // the older generation selected above; its checkpoint names its authority.
    const check = decodeBindings(latestCheck?.bindings)?.published?.generation === generation ? latestCheck : null;
    const refreshPending = [...new Set(check ? check.pendingAccounts
      : (related ?? []).filter(row => row.atBoundary === false).map(row => row.account))].sort();
    if (!refreshPending.length && (check ? check.unresolved || check.errorCode : issues.includes("related_account_refresh_pending")))
      refreshPending.push(account);
    if (check && !refreshPending.length) {
      for (let index = issues.length - 1; index >= 0; index--) if (issues[index] === "related_account_refresh_pending") issues.splice(index, 1);
    }
    if (refreshPending.length) issues.push("related_account_refresh_pending");
    const last = events[events.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              generation,
              network,
              account,
              lt: last.lt,
              hash: last.hash,
              from,
              to,
            } satisfies Cursor),
          ).toString("base64url")
        : null;
    return {
      network,
      account,
      events,
      nextCursor,
      coverage: {
        generation,
        projectionScope: projection.projection_scope,
        publishedAt: run.published_at
          ? new Date(run.published_at).toISOString()
          : null,
        headObservedAt: new Date(run.head_observed_at).toISOString(),
        checkedAt: check?.checkedAt ?? new Date(run.verified_through ?? run.head_observed_at).toISOString(),
        boundary: check?.boundary ?? (projection.boundary_seqno === null ? null : {
          seqno: Number(projection.boundary_seqno), utime: Number(projection.boundary_utime),
        }),
        refreshPending,
        snapshotComplete: run.complete,
        historyComplete: run.complete && graphComplete,
        ...(related
          ? {
              relatedAccounts: related,
              discoveryScope: "configured_roots_and_observed_wallets" as const,
            }
          : {}),
        decodingComplete: run.complete && issues.length === 0,
        syncing: state?.syncing ?? false,
        oldestUtime: extent.oldest === null ? null : Number(extent.oldest),
        newestUtime: extent.newest === null ? null : Number(extent.newest),
        syncedAt: run.published_at
          ? new Date(run.published_at).toISOString()
          : null,
        issues: [...new Set(issues)].sort(),
      },
    };
  }
}
