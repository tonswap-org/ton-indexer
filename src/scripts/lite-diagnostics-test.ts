import assert from 'node:assert/strict';
import { LiteClientDataSource } from '../data/liteClientSource';
import { errorDiagnostic, type Logger } from '../utils/logger';
import { BoundedLiteQueryError } from '../data/boundedLiteEngine';

async function main() {
  const upstream = new Error('Timeout');
  const error = new Error('Liteserver query failed after 3 attempts', { cause: upstream });
  Object.assign(error, { authorization: 'must not be copied', stack: 'must not be copied' });
  assert.deepEqual(errorDiagnostic(error), {
    name: 'Error', message: 'Liteserver query failed after 3 attempts',
    cause: { name: 'Error', message: 'Timeout' },
  });
  const cyclic = new Error('x\n' + 'y'.repeat(2048));
  cyclic.cause = cyclic;
  const diagnostic = errorDiagnostic(cyclic);
  assert.equal((diagnostic.message as string).length, 1024);
  assert.ok(!(diagnostic.message as string).includes('\n'));
  assert.ok(JSON.stringify(diagnostic).includes('"truncated":true'));
  assert.deepEqual(errorDiagnostic({ password: 'must not be copied' }), { name: 'NonError', type: 'object' });
  const failedPeers = new BoundedLiteQueryError([{ endpointIndex: 2, cause: upstream },
    { endpointIndex: 0, cause: new Error('block not applied') }]);
  assert.deepEqual(errorDiagnostic(failedPeers).attempts, [
    { endpointIndex: 2, error: { name: 'Error', message: 'Timeout' } },
    { endpointIndex: 0, error: { name: 'Error', message: 'block not applied' } },
  ]);
  const manyFailures = new BoundedLiteQueryError(Array.from({ length: 9 },
    (_, endpointIndex) => ({ endpointIndex, cause: upstream })));
  const boundedAttempts = errorDiagnostic(manyFailures);
  assert.equal((boundedAttempts.attempts as unknown[]).length, 8);
  assert.equal(boundedAttempts.attemptsTruncated, true);

  // Exercise the real datasource catch with a failed underlying getter. The
  // public nullable result remains separate from internal operational evidence.
  const warnings: { message: string; detail?: Record<string, unknown> }[] = [];
  const logger: Logger = { info() {}, debug() {}, error() {}, warn(message, detail) { warnings.push({ message, detail }); } };
  const block = { workchain: -1, shard: '-9223372036854775808', seqno: 100,
    rootHash: Buffer.alloc(32, 1), fileHash: Buffer.alloc(32, 2) };
  let fails = true;
  const client = {
    getMasterchainInfo: async () => ({ last: block }),
    runMethod: async () => {
      if (fails) throw error;
      return { block, exitCode: 0, result: null };
    },
  };
  const source = Reflect.construct(LiteClientDataSource, ['testnet', client, logger]) as LiteClientDataSource;
  const address = `0:${'a'.repeat(64)}`;
  assert.equal(await source.runGetMethod(address, 'perps_oracle_snapshot', []), null);
  assert.deepEqual(warnings, [{ message: 'liteserver getter unavailable', detail: {
    address, method: 'perps_oracle_snapshot', error: errorDiagnostic(error),
  } }]);
  fails = false;
  assert.deepEqual(await source.runGetMethod(address, 'perps_oracle_snapshot', []), { exitCode: 0, stack: [] });
  assert.equal(warnings.length, 1, 'Successful reads do not emit failure diagnostics');
  console.log('lite datasource diagnostics ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
