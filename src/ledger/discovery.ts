import { createHash } from 'node:crypto';
import type { Network } from '../models';
import type { LedgerSqlClient } from './store';
import type { LedgerCoverage, LedgerDiscoveryPage, LedgerDiscoveryQuery, LedgerEvent } from './types';

const decimal = /^(0|[1-9]\d{0,29})$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class LedgerDiscoveryCursorError extends Error {}
type Cursor = { network: Network; account: string; since: string; after: string; through: string; generation: string };

/** Getter refreshes cannot manufacture a new economic event. */
export function discoveryFingerprint(source: LedgerEvent): string {
  const event = structuredClone(source);
  if (event.settlement?.t3?.identityEvidence) event.settlement.t3.identityEvidence.observedAt = '';
  for (const movement of event.movements) if (movement.evidence.getter) movement.evidence.getter.observedAt = '';
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(stable(event))).digest('hex');
}

/** Called inside the same transaction that publishes the owner projection. */
export async function publishDiscoveries(sql: LedgerSqlClient, network: Network, account: string, generation: string) {
  const run = (await sql.query('SELECT projected,published_at FROM ledger_runs WHERE generation=$1 AND network=$2 AND account=$3', [generation, network, account])).rows[0];
  if (!run?.projected) return; // Physical related-account chains do not publish owner events.
  if (!run.published_at) throw new Error('Discovery requires an atomic publication timestamp');
  await sql.query(`INSERT INTO ledger_discovery_heads(network,account,generation) VALUES($1,$2,$3) ON CONFLICT(network,account) DO NOTHING`, [network, account, generation]);
  let revision = BigInt((await sql.query('SELECT revision::text FROM ledger_discovery_heads WHERE network=$1 AND account=$2 FOR UPDATE', [network, account])).rows[0].revision);
  const rows = (await sql.query(`SELECT event FROM ledger_projection_events WHERE generation=$1 AND network=$2 AND account=$3 ORDER BY event_id`, [generation, network, account])).rows;
  const latest = new Map((await sql.query(`SELECT DISTINCT ON(event_id) event_id,fingerprint FROM ledger_discovery_events WHERE network=$1 AND account=$2 ORDER BY event_id,revision DESC`, [network, account])).rows.map(row => [row.event_id, row.fingerprint]));
  for (const row of rows) {
    const event = row.event as LedgerEvent, fingerprint = discoveryFingerprint(event);
    if (latest.get(event.id) === fingerprint) continue;
    // This is only an inclusive discovery candidate bound. Each consumer must
    // identify the particular completed stage and its required chain evidence.
    const times = [event.utime, ...(event.settlement?.evidence ?? []).map(ref => ref.utime)];
    if (times.some(time => !Number.isSafeInteger(time) || time < 0)) throw new Error('Invalid discovery transaction time');
    revision += 1n;
    await sql.query(`INSERT INTO ledger_discovery_events(network,account,revision,generation,event_id,fingerprint,discovered_at,evidence_utime,event)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [network, account, revision.toString(), generation, event.id, fingerprint, run.published_at, Math.max(...times), JSON.stringify(event)]);
  }
  await sql.query('UPDATE ledger_discovery_heads SET revision=$3,generation=$4 WHERE network=$1 AND account=$2', [network, account, revision.toString(), generation]);
  await sql.query('UPDATE ledger_runs SET discovery_revision=$2 WHERE generation=$1', [generation, revision.toString()]);
}

export async function discoveryPage(sql: LedgerSqlClient, network: Network, account: string, query: LedgerDiscoveryQuery,
  coverageFor: (generation?: string) => Promise<LedgerCoverage>): Promise<LedgerDiscoveryPage> {
  if (!Number.isFinite(Date.parse(query.since)) || new Date(query.since).toISOString() !== query.since || !decimal.test(query.afterRevision ?? '0'))
    throw new LedgerDiscoveryCursorError('Invalid discovery boundary');
  const head = (await sql.query('SELECT revision::text,generation FROM ledger_discovery_heads WHERE network=$1 AND account=$2', [network, account])).rows[0];
  let cursor: Cursor | null = null;
  if (query.cursor) {
    try {
      if (query.cursor.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || Object.keys(cursor).sort().join(',') !== 'account,after,generation,network,since,through' ||
        cursor.network !== network || cursor.account !== account || cursor.since !== query.since || !uuid.test(cursor.generation) ||
        (query.afterRevision !== undefined && query.afterRevision !== cursor.after) ||
        !decimal.test(cursor.after) || !decimal.test(cursor.through) || BigInt(cursor.after) > BigInt(cursor.through) ||
        !head || BigInt(cursor.through) > BigInt(head.revision)) throw new Error();
      const run = (await sql.query('SELECT discovery_revision::text FROM ledger_runs WHERE generation=$1 AND network=$2 AND account=$3 AND complete AND projected', [cursor.generation, network, account])).rows[0];
      if (!run || run.discovery_revision !== cursor.through) throw new Error();
    } catch { throw new LedgerDiscoveryCursorError('Invalid discovery cursor or changed scope'); }
  }
  const through = cursor?.through ?? head?.revision ?? '0', after = cursor?.after ?? query.afterRevision ?? '0';
  if (BigInt(after) > BigInt(through)) throw new LedgerDiscoveryCursorError('Discovery checkpoint exceeds published history');
  const generation = cursor?.generation ?? head?.generation;
  const coverage = await coverageFor(generation);
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const rows = (await sql.query(`SELECT revision::text,generation,discovered_at,evidence_utime,event FROM ledger_discovery_events
    WHERE network=$1 AND account=$2 AND revision>$3::numeric AND revision<=$4::numeric
      AND (discovered_at >= $5::timestamptz OR evidence_utime >= $6::bigint)
    ORDER BY revision ASC LIMIT $7`, [network, account, after, through, query.since, Math.ceil(Date.parse(query.since) / 1000), limit + 1])).rows;
  const revisions = rows.slice(0, limit).map(row => ({ revision: String(row.revision), generation: row.generation,
    discoveredAt: new Date(row.discovered_at).toISOString(), evidenceUtime: Number(row.evidence_utime), event: row.event as LedgerEvent }));
  const nextCursor = rows.length > limit && generation ? Buffer.from(JSON.stringify({ network, account, since: query.since,
    after: revisions[revisions.length - 1]!.revision, through, generation } satisfies Cursor)).toString('base64url') : null;
  return { network, account, since: query.since, throughRevision: through, revisions, nextCursor, coverage };
}
