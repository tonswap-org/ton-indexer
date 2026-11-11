import type { LedgerSqlClient, LedgerSqlPool } from './store';
import { releaseDatabaseSchema } from '../releaseState';

export const RELEASE_IDENTITY_DDL = 'CREATE TABLE IF NOT EXISTS release_identity (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), manifest_hash text NOT NULL)';

export type LedgerCatalog = {
  relations: unknown[];
  columns: unknown[];
  constraints: unknown[];
  indexes: unknown[];
  sequences: unknown[];
  triggers: unknown[];
  internalTriggers: unknown[];
  policies: unknown[];
};

/** Catalog facts are read in one snapshot. No account or history is enrolled. */
export async function readLedgerCatalog(client: LedgerSqlClient, schema: string): Promise<LedgerCatalog> {
  const relations = await client.query(`SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
    c.relrowsecurity AS "rowSecurity",c.relforcerowsecurity AS "forceRowSecurity"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t') ORDER BY c.relname`, [schema]);
  const columns = await client.query(`SELECT c.relname AS relation,a.attname AS name,a.attnum AS position,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",a.attidentity AS identity,
    a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid,false) AS "default"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t') ORDER BY c.relname,a.attnum`, [schema]);
  const constraints = await client.query(`SELECT c.relname AS relation,k.conname AS name,k.contype AS type,
    k.convalidated AS validated,k.condeferrable AS deferrable,k.condeferred AS deferred,
    pg_get_constraintdef(k.oid,false) AS definition,
    EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=k.conrelid AND a.attnum>0
      AND NOT a.attisdropped AND a.attnotnull AND k.conkey=ARRAY[a.attnum]) AS "mandatoryColumn",
    CASE WHEN k.confrelid=0 THEN NULL WHEN rn.nspname=$1 THEN 'self' ELSE rn.nspname END AS "referenceNamespace"
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_class r ON r.oid=k.confrelid LEFT JOIN pg_namespace rn ON rn.oid=r.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname,k.conname`, [schema]);
  const constraintFacts = constraints.rows.flatMap(({ mandatoryColumn, ...row }) => {
    // NOT NULL is bound exactly by columns.attnotnull. PostgreSQL 18's named
    // pg_constraint duplicates are not another business constraint. Validate
    // their real single-column enforcement before projecting this display fact.
    if (row.type === 'n') {
      if (mandatoryColumn !== true || row.validated !== true || row.deferrable !== false ||
        row.deferred !== false || row.referenceNamespace !== null)
        throw Error('NOT NULL catalog record is not a validated mandatory column');
      return [];
    }
    if (!['p', 'u', 'c', 'f'].includes(row.type)) throw Error('Unsupported durable ledger constraint kind');
    return [row];
  });
  const indexes = await client.query(`SELECT c.relname AS relation,x.relname AS name,
    i.indisunique AS "unique",i.indisprimary AS "primary",i.indisvalid AS valid,i.indisready AS ready,
    pg_get_indexdef(i.indexrelid,0,false) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class x ON x.oid=i.indexrelid WHERE n.nspname=$1 ORDER BY c.relname,x.relname`, [schema]);
  const sequences = await client.query(`SELECT c.relname AS name,s.seqstart::text AS start,s.seqincrement::text AS increment,
    s.seqmax::text AS max,s.seqmin::text AS min,s.seqcache::text AS cache,s.seqcycle AS cycle
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname`, [schema]);
  const triggers = await client.query(`SELECT c.relname AS relation,t.tgname AS name,t.tgenabled AS enabled,
    pg_get_triggerdef(t.oid,false) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [schema]);
  // FK enforcement uses internal triggers whose generated names contain OIDs.
  // Bind their stable constraint/function/event roles, including enabled state.
  const internalTriggers = await client.query(`SELECT c.relname AS relation,k.conname AS constraint,
    t.tgenabled AS enabled,t.tgtype AS events,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,
    pn.nspname AS "functionNamespace",p.proname AS function,r.relname AS "constraintRelation",
    CASE WHEN rn.nspname=$1 THEN 'self' ELSE rn.nspname END AS "constraintNamespace"
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
    LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint
    LEFT JOIN pg_class r ON r.oid=t.tgconstrrelid LEFT JOIN pg_namespace rn ON rn.oid=r.relnamespace
    WHERE n.nspname=$1 AND t.tgisinternal ORDER BY c.relname,k.conname,p.proname,t.tgtype`, [schema]);
  const policies = await client.query(`SELECT c.relname AS relation,p.polname AS name,p.polcmd AS command,
    p.polpermissive AS permissive,pg_get_expr(p.polqual,p.polrelid,false) AS qualification,
    pg_get_expr(p.polwithcheck,p.polrelid,false) AS "withCheck"
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname,p.polname`, [schema]);
  const normalize = (rows: unknown[]) => rows.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>)
    .map(([key, value]) => [key, typeof value === 'string' ? value.replaceAll(`${schema}.`, '<namespace>.') : value])));
  return { relations: normalize(relations.rows), columns: normalize(columns.rows),
    constraints: normalize(constraintFacts), indexes: normalize(indexes.rows), sequences: normalize(sequences.rows),
    triggers: normalize(triggers.rows), internalTriggers: normalize(internalTriggers.rows), policies: normalize(policies.rows) };
}

export function assertCanonicalLedgerCatalog(actual: LedgerCatalog, expected: LedgerCatalog): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Durable ledger catalog differs from the canonical SQL schema');
}

/** Check the configured durable namespace without bootstrapping or repairing it. */
export async function assertLedgerDatabaseReady(pool: LedgerSqlPool, manifestHash: string, expected: LedgerCatalog) {
  const schema = releaseDatabaseSchema(manifestHash);
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await client.query("SET LOCAL statement_timeout='3000ms'");
    const namespace = await client.query("SELECT current_schema() AS schema,current_setting('search_path') AS path");
    if (namespace.rows.length !== 1 || namespace.rows[0].schema !== schema || namespace.rows[0].path !== schema)
      throw Error('Durable ledger namespace differs from the release');
    const identity = await client.query('SELECT singleton,manifest_hash FROM release_identity');
    if (identity.rows.length !== 1 || identity.rows[0].singleton !== true || identity.rows[0].manifest_hash !== manifestHash)
      throw Error('Durable ledger full release identity differs');
    const actual = await readLedgerCatalog(client, schema);
    assertCanonicalLedgerCatalog(actual, expected);
    const access = await client.query(`SELECT bool_and(has_table_privilege(current_user,c.oid,'SELECT')) AS readable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'`, [schema]);
    if (access.rows[0]?.readable !== true) throw Error('Durable ledger tables are not readable');
    await client.query('COMMIT'); transaction = false;
    return { schema, manifestHash };
  } finally {
    try { if (transaction) await client.query('ROLLBACK'); } finally { client.release?.(); }
  }
}
