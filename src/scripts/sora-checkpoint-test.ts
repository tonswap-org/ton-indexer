import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import {
  type ResolvedTonTrustedCheckpoint,
  SoraTonCheckpointResolver
} from '../soraCheckpoint';

const bareCheckpointHex = (() => {
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(123456, 0);
  Buffer.from('11'.repeat(32), 'hex').copy(bytes, 4);
  return `0x${bytes.toString('hex')}`;
})();

const wrappedCheckpointHex = `0x01${bareCheckpointHex.slice(2)}`;

const runStaticOverrideCase = async () => {
  const resolver = new SoraTonCheckpointResolver({
    ...loadConfig(),
    soraRpcEndpoint: undefined,
    soraTonTrustedCheckpointSeqno: 77,
    soraTonTrustedCheckpointHash: `0x${'22'.repeat(32)}`,
  });
  const resolved = await resolver.resolveTonTrustedCheckpoint();
  assert.deepEqual(resolved, {
    mcSeqno: 77,
    mcBlockHashHex: `0x${'22'.repeat(32)}`,
    source: 'env'
  } satisfies ResolvedTonTrustedCheckpoint);
};

const runRpcCase = async (storageValueHex: string) => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method: string;
      params: unknown[];
    };
    calls.push({ method: body.method, params: body.params });
    if (body.method === 'chain_getFinalizedHead') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${'aa'.repeat(32)}` }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (body.method === 'state_getStorage') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: storageValueHex }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected method ${body.method}`);
  }) as typeof fetch;

  try {
    const resolver = new SoraTonCheckpointResolver({
      ...loadConfig(),
      soraRpcEndpoint: 'http://127.0.0.1:9933',
      soraRpcTimeoutMs: 5_000,
      soraCheckpointCacheTtlMs: 60_000,
      soraTonTrustedCheckpointSeqno: undefined,
      soraTonTrustedCheckpointHash: undefined,
    });
    const resolved = await resolver.resolveTonTrustedCheckpoint();
    assert.deepEqual(resolved, {
      mcSeqno: 123456,
      mcBlockHashHex: `0x${'11'.repeat(32)}`,
      source: 'rpc'
    } satisfies ResolvedTonTrustedCheckpoint);
    assert.equal(calls[0]?.method, 'chain_getFinalizedHead');
    assert.equal(calls[1]?.method, 'state_getStorage');
    assert.equal(calls[1]?.params?.[1], `0x${'aa'.repeat(32)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const main = async () => {
  await runStaticOverrideCase();
  await runRpcCase(bareCheckpointHex);
  await runRpcCase(wrappedCheckpointHex);
  console.log('sora checkpoint ok');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
