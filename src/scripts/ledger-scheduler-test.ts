import assert from 'node:assert/strict';
import { LedgerScheduler, type LedgerPriority } from '../ledger/scheduler';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let time = 0, id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return { now: () => time,
    setTimer: (run: () => void, delay: number) => { const key = ++id; timers.set(key, { at: time + delay, run }); return key as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (handle: ReturnType<typeof setTimeout> | number) => { timers.delete(handle as unknown as number); },
    advance: async (milliseconds: number) => {
      time += milliseconds;
      for (const [key, timer] of timers) if (timer.at <= time) { timers.delete(key); timer.run(); }
      await flush();
    }, timers,
  };
}
async function main() {
  const time = clock(), calls: Array<[string, LedgerPriority]> = [], finish = new Map<string, () => void>();
  const scheduler = new LedgerScheduler({ workers: 3, ...time, run: (account, priority) => {
    calls.push([account, priority]); return new Promise<void>(resolve => finish.set(account, resolve));
  } });
  for (let i = 0; i < 50; i++) scheduler.request(`background-${i}`, 'background');
  await flush(); assert.equal(calls.length, 2, 'one slot remains reserved for foreground');
  scheduler.request('waiting-wallet', 'foreground'); await flush();
  assert.deepEqual(calls.at(-1), ['waiting-wallet', 'foreground']);
  scheduler.request('background-49', 'foreground'); scheduler.request('background-49', 'background');
  await time.advance(750); assert.equal(scheduler.oldestForegroundAgeMs(), 750);
  finish.get('background-0')!(); await flush();
  assert.deepEqual(calls.at(-1), ['background-49', 'foreground'], 'upgraded entry precedes fifty queued background owners');
  assert.equal(scheduler.depth(), 47);
  scheduler.request('waiting-wallet', 'background'); scheduler.request('waiting-wallet', 'foreground'); scheduler.request('waiting-wallet', 'foreground');
  finish.get('waiting-wallet')!(); await flush();
  assert.equal(calls.filter(([account]) => account === 'waiting-wallet').length, 2, 'running requests coalesce into exactly one follow-up');
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false, 'stop waits for active work');
  for (const done of finish.values()) done();
  await stopping; assert.equal(scheduler.depth(), 0); assert.equal(scheduler.request('later', 'foreground'), false);
  assert.equal(time.timers.size, 0);

  const retryClock = clock(), starts: number[] = [];
  let fail = true;
  const retry = new LedgerScheduler({ workers: 2, ...retryClock, run: async () => { starts.push(retryClock.now()); return { retry: fail }; } });
  retry.request('account', 'background'); await flush();
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const count = starts.length;
    retry.request('account', 'foreground'); retry.request('account', 'background');
    await retryClock.advance(delay - 1); assert.equal(starts.length, count, 'new requests do not bypass persisted in-memory retry delay');
    await retryClock.advance(1); assert.equal(starts.length, count + 1);
  }
  assert.deepEqual(starts, [0, 2000, 6000, 14000, 30000, 62000, 122000, 182000]);
  fail = false; await retryClock.advance(60000); assert.equal(retry.depth(), 0);
  assert.equal(retryClock.timers.size, 0, 'successful completion leaves no polling timer');
  await retry.stop();

  let attempts = 0;
  const thrownClock = clock();
  const thrown = new LedgerScheduler({ workers: 2, ...thrownClock, run: async () => { if (++attempts === 1) throw Error('offline'); } });
  thrown.request('failed', 'foreground'); await flush(); assert.equal(attempts, 1);
  await thrownClock.advance(2000); assert.equal(attempts, 2); await thrown.stop();
  console.log('scheduler priorities, reserved worker, in-place upgrade, coalesced follow-up, bounded retry, metrics and draining stop passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
