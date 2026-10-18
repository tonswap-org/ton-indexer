import type { Database } from './db.js';
import { record } from './http.js';
import { historicalDailyEvidenceMatches, historicalDailyRevisionId, historicalDailyCacheKey,
  type HistoricalDailyEvidence, type HistoricalDailyRequest, type HistoricalDailyRevision } from './historicalDaily.js';

/** Append-only source evidence. Cache availability never substitutes for this durable record. */
export class HistoricalDailyRepository {
  constructor(private db: Database) {}

  async persist(evidence: HistoricalDailyEvidence, now: Date): Promise<HistoricalDailyRevision> {
    if (!historicalDailyEvidenceMatches(evidence, record(evidence).request as HistoricalDailyRequest, now)) throw new Error('Invalid historical evidence cannot be published.');
    const revision: HistoricalDailyRevision = { revisionId: historicalDailyRevisionId(evidence), evidence };
    await this.db.query(`INSERT INTO platform_historical_daily_revisions(id,request_key,fetched_at,evidence)
      VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [revision.revisionId, historicalDailyCacheKey(evidence.request), evidence.fetchedAt, JSON.stringify(evidence)]);
    if (!await this.matches(revision, evidence.request, now)) throw new Error('Historical revision was not durably preserved.');
    return revision;
  }

  async matches(value: unknown, request: HistoricalDailyRequest, now: Date): Promise<boolean> {
    const revision = record(value);
    if (Object.keys(revision).sort().join(',') !== 'evidence,revisionId' || typeof revision.revisionId !== 'string' || !/^[a-f0-9]{64}$/.test(revision.revisionId) ||
      !historicalDailyEvidenceMatches(revision.evidence, request, now) ||
      historicalDailyRevisionId(revision.evidence) !== revision.revisionId) return false;
    return Boolean(await this.read(revision.revisionId, now));
  }

  async read(revisionId: string, now: Date): Promise<HistoricalDailyRevision | null> {
    if (!/^[a-f0-9]{64}$/.test(revisionId)) return null;
    const stored = (await this.db.query<{ request_key: string; fetched_at: Date | string; evidence: HistoricalDailyEvidence }>(
      'SELECT request_key,fetched_at,evidence FROM platform_historical_daily_revisions WHERE id=$1', [revisionId])).rows[0];
    if (!stored || !historicalDailyEvidenceMatches(stored.evidence, record(stored.evidence).request as HistoricalDailyRequest, now) ||
      stored.request_key !== historicalDailyCacheKey(stored.evidence.request) ||
      new Date(stored.fetched_at).toISOString() !== stored.evidence.fetchedAt || historicalDailyRevisionId(stored.evidence) !== revisionId) return null;
    return { revisionId, evidence: stored.evidence };
  }
}
