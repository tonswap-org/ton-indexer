import { describe, expect, it } from 'vitest';
import { stageTime } from '../src/notificationEvidence.js';

const now = Math.floor(Date.now() / 1000), common = { href: '/wallet', occurredAt: new Date((now - 100) * 1000).toISOString(), evidence: {} };
const ref = { account: 'owner', lt: '1', hash: 'hash', utime: now - 30 };
describe('qualified notification-stage chronology', () => {
  it('selects the latest required transaction without mutating source evidence', () => {
    const refs = [ref, { ...ref, lt: '2', utime: now - 20 }], before = structuredClone(refs);
    const result = stageTime(common, refs);
    expect(result.occurredAt).toBe(new Date((now - 20) * 1000).toISOString());
    expect(result.evidence).toMatchObject({ requestOccurredAt: common.occurredAt, stageTransactions: refs });
    expect(refs).toEqual(before); expect(common.evidence).toEqual({});
  });
  it('does not inherit later unrelated canonical evidence', () => {
    const result = stageTime(common, [ref], [ref, { ...ref, lt: '99', utime: now - 1 }]);
    expect(result.occurredAt).toBe(new Date(ref.utime * 1000).toISOString());
  });
  it.each([
    ['missing', []], ['future', [{ ...ref, utime: now + 60 }]],
    ['fractional', [{ ...ref, utime: now - 0.5 }]], ['conflicting identity', [ref, { ...ref, utime: now - 10 }]],
  ])('rejects %s time evidence', (_label, refs) => {
    expect(() => stageTime(common, refs as typeof ref[])).toThrow(/notification_stage_time/);
  });
  it('rejects a different timestamp or missing identity in the published canonical evidence', () => {
    expect(() => stageTime(common, [ref], [{ ...ref, utime: now - 10 }])).toThrow('notification_stage_time_unbound');
    expect(() => stageTime(common, [ref], [{ ...ref, lt: '2' }])).toThrow('notification_stage_time_unbound');
    expect(() => stageTime(common, [ref], [ref, { ...ref, utime: now - 10 }])).toThrow('notification_stage_time_contradiction');
  });
});
