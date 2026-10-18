import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../utils/logger';

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await delay(5);
  assert.ok(check(), 'log write completed within 500 ms');
}

class RecoverableDestination extends EventEmitter {
  fail = true;
  writes: string[] = [];
  write(line: string, callback: (error?: Error) => void): boolean {
    if (this.fail) {
      const error = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      callback(error);
      this.emit('error', error);
    } else { this.writes.push(line); callback(); }
    return true;
  }
}

async function main() {
  const destination = new RecoverableDestination();
  const logger = createLogger('info', destination as unknown as NodeJS.WritableStream);
  logger.info('failed line');
  await until(() => logger.dropped() === 1);
  destination.fail = false;
  logger.info('healthy line', { value: 3 });
  await until(() => destination.writes.length === 1);
  assert.equal(logger.dropped(), 1, 'callback and error event count one lost line');
  assert.equal(JSON.parse(destination.writes[0]).msg, 'healthy line');
  assert.equal(JSON.parse(destination.writes[0]).value, 3);
  assert.equal(JSON.parse(destination.writes[0]).level, 30);
  assert.equal(destination.writes.some(line => line.includes('failed line')), false, 'failed lines are not replayed');

  const throws = Object.defineProperty({}, 'bad', { enumerable: true, get: () => { throw new Error('bad log value'); } });
  assert.doesNotThrow(() => logger.info('serialization failed', throws));
  assert.equal(logger.dropped(), 2);
  const throwing = new EventEmitter() as EventEmitter & { write(): never };
  throwing.write = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  const throwingLogger = createLogger('info', throwing as unknown as NodeJS.WritableStream);
  throwingLogger.info('synchronous error');
  await until(() => throwingLogger.dropped() === 1);

  const directory = mkdtempSync(join(tmpdir(), 'indexer-logger-test-'));
  try {
    const file = join(directory, 'destination.log');
    const fd = openSync(file, 'w');
    const numeric = createLogger('info', fd);
    closeSync(fd);
    numeric.error('closed fd');
    assert.equal(numeric.dropped(), 1, 'numeric logging reports write failure synchronously');
    // tsx/runtime workers can release lower descriptors independently. Retain
    // those owned filler handles until the exact failed descriptor is reopened.
    const reopened: number[] = [];
    try {
      while (reopened.at(-1) !== fd) {
        assert.ok(reopened.length < 1024, 'bounded descriptor-reuse setup');
        const current = openSync(file, 'a'); reopened.push(current);
        assert.ok(current <= fd, 'failed descriptor is still free for the recovery test');
      }
      numeric.info('fd recovered');
      await until(() => readFileSync(file, 'utf8').includes('fd recovered'));
      assert.equal(numeric.dropped(), 1);
    } finally { for (const recovered of reopened) closeSync(recovered); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  console.log('Logger survives ENOSPC, synchronous errors and closed descriptors, counts dropped lines, and recovers');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
