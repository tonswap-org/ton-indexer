import assert from 'node:assert/strict';
import { createLiteChainSource } from '../data/liteClientSource';
import { ChainReadError } from '../data/dataSource';
import { FakeLiteEngine, masterAnswer, proofBlock } from './support/fakeLiteEngine';
import { errorDiagnostic, type Logger } from '../utils/logger';
import { BoundedLiteQueryError } from '../data/boundedLiteEngine';

const currentTime = Math.floor(Date.now() / 1_000);
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

  // Failure is a typed public boundary; operational evidence remains bounded.
  const warnings: { message: string; detail?: Record<string, unknown> }[] = [];
  const logger: Logger = { info() {}, debug() {}, error() {}, warn(message, detail) { warnings.push({ message, detail }); } };
  const block = proofBlock(100, currentTime, -1);
  let fails = true;
  const peers = [0, 1].map(() => new FakeLiteEngine(async request => {
    if (request.kind === 'liteServer.getMasterchainInfoExt') return masterAnswer(block);
    if (fails) throw error;
    return { id: request.id, shardblk: block.id, exitCode: 0, result: null };
  }));
  const source = createLiteChainSource({ network: 'testnet', logger,
    peers: peers.map((_, port) => ({ host: '127.0.0.1', port: port + 1, publicKey: Buffer.alloc(32) })),
    engineFactory: peer => peers[peer.port - 1] });
  const address = `0:${'a'.repeat(64)}`;
  try {
    await assert.rejects(source.runGetMethod(address, 'perps_oracle_snapshot', []), ChainReadError);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].message, 'liteserver getter unavailable');
    assert.equal(warnings[0].detail?.address, address);
    assert.equal(warnings[0].detail?.method, 'perps_oracle_snapshot');
    const evidence = JSON.stringify(warnings[0].detail?.error);
    assert.ok(evidence.includes('ChainReadError'));
    assert.ok(evidence.includes('BoundedLiteQueryError'));
    assert.ok(evidence.includes('endpointIndex'));
    assert.equal(evidence.includes('must not be copied'), false);
    fails = false;
    assert.deepEqual(await source.runGetMethod(address, 'perps_oracle_snapshot', []), { exitCode: 0, stack: [] });
    assert.equal(warnings.length, 1, 'Successful reads do not emit failure diagnostics');
  } finally { await source.close(); }
  console.log('lite datasource diagnostics ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
