import assert from 'node:assert/strict';
import { createOperationEvidenceGate } from '../runtime/operationEvidenceGate';

async function main() {
  const gate = createOperationEvidenceGate(), unavailable = () => Error('busy or stopped');
  const started: AbortSignal[] = [], releases: Array<() => void> = [];
  const block = (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    started.push(signal); releases.push(() => resolve('done'));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const caller = new AbortController();
  const first = gate.run(block, unavailable, caller.signal), second = gate.run(block, unavailable);
  const rejected = assert.rejects(first, /caller stopped/);
  await assert.rejects(gate.run(block, unavailable), /busy/); assert.equal(started.length, 2);
  caller.abort(Error('caller stopped')); await rejected;
  assert(started[0].aborted); assert(!started[1].aborted, 'one caller cannot cancel another');
  let observations = 0;
  assert.equal(await gate.run(async () => ++observations, unavailable), 1);
  assert.equal(await gate.run(async () => ++observations, unavailable), 2, 'a completed current observation is never reused');
  const preAborted = new AbortController(); preAborted.abort(Error('before work'));
  await assert.rejects(gate.run(async () => { observations++; }, unavailable, preAborted.signal), /before work/); assert.equal(observations, 2);
  const stopped = assert.rejects(second, /service stopped/); await gate.stop(); await stopped;
  assert(started[1].aborted); await assert.rejects(gate.run(block, unavailable), /stopped/);
  const timed = createOperationEvidenceGate(10);
  // Keep the test event loop alive while the production timer remains unref'd.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(timed.run(block, unavailable), /deadline/); } finally { clearTimeout(keepAlive); await timed.stop(); }
  for (const invalid of [0, 20_001, 1.1, NaN]) assert.throws(() => createOperationEvidenceGate(invalid));
  console.log('Shared evidence cap, independent cancellation, abort-before-work, deadline, no completed-result reuse and shutdown passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
