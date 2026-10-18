import type { Database } from './db.js';
import { record } from './http.js';
import { historicalFxEvidenceMatches, historicalFxRevisionId, historicalFxCacheKey,
  type HistoricalFxEvidence, type HistoricalFxRequest, type HistoricalFxRevision } from './historicalFx.js';

/** Append-only source evidence. Cache availability never substitutes for this durable record. */
export class HistoricalFxRepository {
  constructor(private db: Database) {}

  async persist(evidence: HistoricalFxEvidence, now: Date): Promise<HistoricalFxRevision> {
    if (!historicalFxEvidenceMatches(evidence, evidence.request, now)) throw new Error('Invalid historical evidence cannot be published.');
    const revision: HistoricalFxRevision = { revisionId: historicalFxRevisionId(evidence), evidence };
    await this.db.query(`INSERT INTO platform_historical_fx_revisions(id,request_key,fetched_at,evidence)
      VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [revision.revisionId, historicalFxCacheKey(evidence.request), evidence.fetchedAt, JSON.stringify(evidence)]);
    if (!await this.matches(revision, evidence.request, now)) throw new Error('Historical revision was not durably preserved.');
    return revision;
  }

  async matches(value: unknown, request: HistoricalFxRequest, now: Date): Promise<boolean> {
    const revision = record(value);
    if (typeof revision.revisionId !== 'string' || !/^[a-f0-9]{64}$/.test(revision.revisionId) ||
      !historicalFxEvidenceMatches(revision.evidence, request, now) ||
      historicalFxRevisionId(revision.evidence) !== revision.revisionId) return false;
    return Boolean(await this.read(revision.revisionId, now));
  }

  async read(revisionId: string, now: Date): Promise<HistoricalFxRevision | null> {
    if (!/^[a-f0-9]{64}$/.test(revisionId)) return null;
    const stored = (await this.db.query<{ request_key: string; fetched_at: Date | string; evidence: HistoricalFxEvidence }>(
      'SELECT request_key,fetched_at,evidence FROM platform_historical_fx_revisions WHERE id=$1', [revisionId])).rows[0];
    if (!stored || !historicalFxEvidenceMatches(stored.evidence, stored.evidence.request, now) ||
      stored.request_key !== historicalFxCacheKey(stored.evidence.request) ||
      new Date(stored.fetched_at).toISOString() !== stored.evidence.fetchedAt || historicalFxRevisionId(stored.evidence) !== revisionId) return null;
    return { revisionId, evidence: stored.evidence };
  }
}
