import type { NewNotification } from './store.js';

export class NotificationStageTimeError extends Error {}

type Common = Pick<NewNotification, 'href' | 'occurredAt' | 'evidence'>;
export type NotificationTransaction = { account: string; lt: string; hash: string; utime: number };

/** Call only after the stage's principal/state evidence has been qualified.
 * The latest required chain transaction completes this particular stage;
 * index publication and unrelated later stages never supply its time. */
export function stageTime(common: Common, transactions: readonly NotificationTransaction[], canonical: readonly NotificationTransaction[] = transactions): Common {
  if (!transactions.length) throw new NotificationStageTimeError('notification_stage_time_unavailable');
  const published = new Map<string, NotificationTransaction>();
  for (const ref of canonical) {
    const key = `${ref.account}:${ref.lt}:${ref.hash}`, existing = published.get(key);
    if (existing && existing.utime !== ref.utime) throw new NotificationStageTimeError('notification_stage_time_contradiction');
    published.set(key, ref);
  }
  const unique = new Map<string, NotificationTransaction>();
  for (const ref of transactions) {
    if (!Number.isSafeInteger(ref.utime) || ref.utime <= 0 || ref.utime * 1000 > Date.now())
      throw new NotificationStageTimeError('notification_stage_time_invalid');
    const key = `${ref.account}:${ref.lt}:${ref.hash}`, existing = unique.get(key);
    if (published.get(key)?.utime !== ref.utime) throw new NotificationStageTimeError('notification_stage_time_unbound');
    if (existing && existing.utime !== ref.utime) throw new NotificationStageTimeError('notification_stage_time_contradiction');
    unique.set(key, ref);
  }
  return { ...common, occurredAt: new Date(Math.max(...transactions.map(ref => ref.utime)) * 1000).toISOString(),
    evidence: { ...common.evidence, requestOccurredAt: common.occurredAt, stageTransactions: [...unique.values()] } };
}
