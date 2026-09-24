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
    if (event.settlement?.t3?.identityEvidence)
      event.settlement.t3.identityEvidence.observedAt = "";
    for (const movement of event.movements)
      if (movement.evidence.getter) movement.evidence.getter.observedAt = "";
  }
  const snapshot = {
    decoder: "exact-ledger-v20",
    projectionScope: projection.projectionScope,
    events: [...fingerprintEvents].sort((a, b) => a.id.localeCompare(b.id)),
    related: related
      .map((item) =>
        item.role === "owner" ? { ...item, generation: null } : item,
      )
      .sort((a, b) => a.account.localeCompare(b.account)),
    issues: [...issues].sort(),
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(snapshot)))
    .digest("hex");
}

export class LedgerCursorError extends Error {}

export class PostgresLedgerStore {
  constructor(readonly pool: LedgerSqlPool) {}

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
      await client.query("SELECT projection_scope FROM ledger_projection_coverage LIMIT 0");
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
    const key = `ledger:${network}:${account}`;
    let locked = false;
    try {
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
        `INSERT INTO ledger_projection_coverage(generation,projection_scope,related_accounts,issues,fingerprint) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5) ON CONFLICT(generation) DO UPDATE SET projection_scope=EXCLUDED.projection_scope,related_accounts=EXCLUDED.related_accounts,issues=EXCLUDED.issues,fingerprint=EXCLUDED.fingerprint`,
        [
          generation,
          JSON.stringify(projection.projectionScope),
          JSON.stringify(related),
          JSON.stringify(issues),
          projectionFingerprint(projection, related, issues),
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
        "SELECT complete,network,account FROM ledger_runs WHERE generation=$1 FOR UPDATE",
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
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await this.assertWritable(client, generation);
      if (run.network !== network || run.account !== account)
        throw new Error("Ledger publication owner or network mismatch");
      await client.query("SELECT 1 FROM ledger_accounts WHERE network=$1 AND account=$2 FOR UPDATE", [network, account]);
      await client.query(
        "UPDATE ledger_runs SET complete=true,source_complete=true,next_lt=NULL,next_hash=NULL,published_at=clock_timestamp(),verified_through=COALESCE($2::timestamptz,head_observed_at) WHERE generation=$1",
        [generation, checkedAt],
      );
      await publishDiscoveries(client, network, account, generation);
      await client.query(
        `UPDATE ledger_accounts SET current_generation=$3,latest_generation=$3,syncing=false,error_code=NULL,synced_at=now(),checked_at=(SELECT verified_through FROM ledger_runs WHERE generation=$3)
        WHERE network=$1 AND account=$2`,
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

  async failed(network: Network, account: string, code: string) {
    await this.pool.query(
      "UPDATE ledger_accounts SET syncing=false,error_code=$3 WHERE network=$1 AND account=$2",
      [network, account, code],
    );
  }

  async discoveries(network: Network, account: string, query: LedgerDiscoveryQuery) {
    return discoveryPage(this.pool, network, account, query,
      async generation => (await this.page(network, account, { generation, limit: 1 })).coverage);
  }

  async page(
    network: Network,
    account: string,
    query: LedgerQuery = {},
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
          checkedAt: null,
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
          checkedAt: null,
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
        "SELECT projection_scope,related_accounts,issues,fingerprint FROM ledger_projection_coverage WHERE generation=$1",
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
          checkedAt: null, snapshotComplete: false, historyComplete: false, decodingComplete: false,
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
        checkedAt:
          state?.current_generation === generation && state.checked_at
            ? new Date(state.checked_at).toISOString()
            : new Date(
                run.verified_through ?? run.head_observed_at,
              ).toISOString(),
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
