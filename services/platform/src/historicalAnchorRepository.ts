import type { Database } from './db.js';
import { record } from './http.js';
import { historicalAnchorEvidenceMatches, historicalAnchorRevisionId, historicalAnchorCacheKey,
  type HistoricalAnchorEvidence, type HistoricalAnchorRequest, type HistoricalAnchorRevision } from './historicalAnchors.js';

/** Append-only source evidence. Cache availability never substitutes for this durable record. */
export class HistoricalAnchorRepository {
  constructor(private db: Database) {}

  async persist(evidence: HistoricalAnchorEvidence, now: Date): Promise<HistoricalAnchorRevision> {
    if (!historicalAnchorEvidenceMatches(evidence, evidence.request, now)) throw new Error('Invalid historical evidence cannot be published.');
    const revision: HistoricalAnchorRevision = { revisionId: historicalAnchorRevisionId(evidence), evidence };
    await this.db.query(`INSERT INTO platform_historical_anchor_revisions(id,request_key,fetched_at,evidence)
      VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [revision.revisionId, historicalAnchorCacheKey(evidence.request), evidence.fetchedAt, JSON.stringify(evidence)]);
    if (!await this.matches(revision, evidence.request, now)) throw new Error('Historical revision was not durably preserved.');
    return revision;
  }

  async matches(value: unknown, request: HistoricalAnchorRequest, now: Date): Promise<boolean> {
    const revision = record(value);
    if (typeof revision.revisionId !== 'string' || !/^[a-f0-9]{64}$/.test(revision.revisionId) ||
      !historicalAnchorEvidenceMatches(revision.evidence, request, now) ||
      historicalAnchorRevisionId(revision.evidence) !== revision.revisionId) return false;
    return Boolean(await this.read(revision.revisionId, now));
  }

  async read(revisionId: string, now: Date): Promise<HistoricalAnchorRevision | null> {
    if (!/^[a-f0-9]{64}$/.test(revisionId)) return null;
    const stored = (await this.db.query<{ request_key: string; fetched_at: Date | string; evidence: HistoricalAnchorEvidence }>(
      'SELECT request_key,fetched_at,evidence FROM platform_historical_anchor_revisions WHERE id=$1', [revisionId])).rows[0];
    if (!stored || !historicalAnchorEvidenceMatches(stored.evidence, stored.evidence.request, now) ||
      stored.request_key !== historicalAnchorCacheKey(stored.evidence.request) ||
      new Date(stored.fetched_at).toISOString() !== stored.evidence.fetchedAt || historicalAnchorRevisionId(stored.evidence) !== revisionId) return null;
    return { revisionId, evidence: stored.evidence };
  }
}
