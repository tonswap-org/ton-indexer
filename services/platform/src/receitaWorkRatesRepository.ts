import type { Database } from './db.js';
import { receitaWorkRatesRecord, receitaWorkRatesSnapshot, type ReceitaWorkRatesRequest, type ReceitaWorkRatesEvidence, type ReceitaWorkRatesRevision } from './receitaWorkRates.js';
import { receitaWorkRatesCacheKey, receitaWorkRatesEvidenceMatches, receitaWorkRatesRevisionId } from './receitaWorkRatesProvider.js';
/** Distinct Receita request/method keys share the immutable FX archive and its mutation guards. */
export class ReceitaWorkRatesRepository {
  constructor(private db: Database) {}
  async persist(value: ReceitaWorkRatesEvidence, now: Date): Promise<ReceitaWorkRatesRevision> {
    const evidence = receitaWorkRatesSnapshot(value) as ReceitaWorkRatesEvidence;
    if (!receitaWorkRatesEvidenceMatches(evidence, evidence.request, now)) throw Error('Invalid Receita evidence cannot be archived.');
    const revision = { revisionId: receitaWorkRatesRevisionId(evidence), evidence };
    await this.db.query(`INSERT INTO platform_historical_fx_revisions(id,request_key,fetched_at,evidence) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
      [revision.revisionId, receitaWorkRatesCacheKey(evidence.request), evidence.fetchedAt, JSON.stringify(evidence)]);
    if (!await this.matches(revision, evidence.request, now)) throw Error('Receita evidence was not durably preserved.');
    return revision;
  }
  async matches(value: unknown, request: ReceitaWorkRatesRequest, now: Date): Promise<boolean> {
    try {
      const revision = receitaWorkRatesRecord(receitaWorkRatesSnapshot(value));
      return typeof revision.revisionId === 'string' && /^[a-f0-9]{64}$/.test(revision.revisionId) && receitaWorkRatesEvidenceMatches(revision.evidence, request, now) &&
        receitaWorkRatesRevisionId(revision.evidence) === revision.revisionId && Boolean(await this.read(revision.revisionId, now));
    } catch { return false; }
  }
  async read(id: string, now: Date): Promise<ReceitaWorkRatesRevision | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const row = (await this.db.query<{request_key:string;fetched_at:Date|string;evidence:ReceitaWorkRatesEvidence}>(
      'SELECT request_key,fetched_at,evidence FROM platform_historical_fx_revisions WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    try {
      const evidence = receitaWorkRatesSnapshot(row.evidence) as ReceitaWorkRatesEvidence;
      if (!receitaWorkRatesEvidenceMatches(evidence, evidence.request, now) || row.request_key !== receitaWorkRatesCacheKey(evidence.request) ||
        new Date(row.fetched_at).toISOString() !== evidence.fetchedAt || receitaWorkRatesRevisionId(evidence) !== id) return null;
      return { revisionId: id, evidence };
    } catch { return null; }
  }
}
