import type { Database } from './db.js';
import { record } from './http.js';
import { ptaxCacheKey, ptaxEvidenceMatches, ptaxRevisionId, type PtaxEvidence, type PtaxRequest, type PtaxRevision } from './ptax.js';

/** All FX sources use the existing append-only FX archive and database immutability guards.
 * PTAX identity includes its source/method; it cannot match a blended FX revision. */
export class PtaxRepository {
  constructor(private db: Database) {}
  async persist(evidence: PtaxEvidence, now: Date): Promise<PtaxRevision> {
    if (!ptaxEvidenceMatches(evidence, evidence.request, now)) throw Error('Invalid PTAX evidence cannot be published.');
    const revision = { revisionId: ptaxRevisionId(evidence), evidence };
    await this.db.query(`INSERT INTO platform_historical_fx_revisions(id,request_key,fetched_at,evidence)
      VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [revision.revisionId, ptaxCacheKey(evidence.request), evidence.fetchedAt, JSON.stringify(evidence)]);
    if (!await this.matches(revision, evidence.request, now)) throw Error('PTAX revision was not durably preserved.');
    return revision;
  }
  async matches(value: unknown, request: PtaxRequest, now: Date): Promise<boolean> {
    const r = record(value);
    return typeof r.revisionId === 'string' && /^[a-f0-9]{64}$/.test(r.revisionId) && ptaxEvidenceMatches(r.evidence, request, now) &&
      ptaxRevisionId(r.evidence) === r.revisionId && Boolean(await this.read(r.revisionId, now));
  }
  async read(id: string, now: Date): Promise<PtaxRevision | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const row = (await this.db.query<{request_key: string; fetched_at: Date | string; evidence: PtaxEvidence}>(
      'SELECT request_key,fetched_at,evidence FROM platform_historical_fx_revisions WHERE id=$1', [id])).rows[0];
    if (!row || !ptaxEvidenceMatches(row.evidence, row.evidence.request, now) || row.request_key !== ptaxCacheKey(row.evidence.request) ||
      new Date(row.fetched_at).toISOString() !== row.evidence.fetchedAt || ptaxRevisionId(row.evidence) !== id) return null;
    return { revisionId: id, evidence: row.evidence };
  }
}
