import assert from 'node:assert/strict';
import Fastify, { FastifyInstance } from 'fastify';
import { registerRoutes } from '../api/routes';
import { PUBLIC_RPC_ZERO_STATES } from '../api/rpcNetwork';
import type { IndexerService } from '../indexerService';

type RouteConfig = Parameters<typeof registerRoutes>[1];
type FetchCall = { url: string; request: { method: string; params: object; id: unknown } | null };
const upstream = 'https://upstream.invalid/jsonRPC';
const secondUpstream = 'https://second.invalid/jsonRPC';
const masterchain = (network: 'mainnet' | 'testnet') => ({
  '@type': 'blocks.masterchainInfo',
  last: { '@type': 'ton.blockIdExt', workchain: -1, shard: '-9223372036854775808', seqno: 123 },
  init: { '@type': 'ton.blockIdExt', shard: '0', seqno: 0, ...PUBLIC_RPC_ZERO_STATES[network] }
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const invoke = async (app: FastifyInstance, method: string, params: object = {}, url = '/jsonRPC') => {
  const response = await app.inject({ method: 'POST', url,
    payload: { id: 'sdk-request', jsonrpc: '2.0', method, params } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.id, 'sdk-request');
  assert.equal(body.jsonrpc, '2.0');
  return body;
};

async function scenario(
  config: Partial<RouteConfig>,
  respond: (call: FetchCall, calls: FetchCall[]) => Response | Promise<Response>,
  check: (app: FastifyInstance, calls: FetchCall[]) => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), request: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return respond(call, calls);
  };
  const app = Fastify({ logger: false });
  try {
    registerRoutes(app, {
      network: 'testnet', rpcProxyEndpoint: upstream, rpcProxyRetryAttempts: 1,
      rpcProxyRetryDelayMs: 0, ...config
    }, {} as IndexerService);
    await check(app, calls);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
}

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);

test('route registration requires a validated, explicit network', async () => {
  for (const network of [undefined, null, '', 'TESTNET', 'unsupported']) {
    const app = Fastify();
    try {
      assert.throws(() => registerRoutes(app, { network } as RouteConfig, {} as IndexerService),
        /explicit mainnet, testnet, or localnet network/);
    } finally { await app.close(); }
  }
});

for (const network of ['mainnet', 'testnet'] as const) {
  for (const envelope of ['toncenter', 'jsonrpc'] as const) {
    test(`${network} metadata preserves the ${envelope} SDK result`, async () => {
      const result = masterchain(network);
      await scenario({ network }, () => json(envelope === 'toncenter' ? { ok: true, result } : { result }),
        async (app, calls) => {
          for (const path of ['/jsonRPC', '/api/v2/jsonRPC']) {
            const body = await invoke(app, 'getMasterchainInfo', {}, path);
            assert.equal(body.ok, true); assert.deepEqual(body.result, result);
          }
          assert.equal(calls.length, 2, 'validate each metadata response without an extra probe');
          const info = (await app.inject('/api/indexer/v1/service-info')).json();
          assert.equal(info.network, network);
        });
    });
  }
  test(`${network} skips a wrong-network configured endpoint`, async () => {
    const wrongNetwork = network === 'mainnet' ? 'testnet' : 'mainnet';
    await scenario({ network, rpcProxyEndpoints: [upstream, secondUpstream], rpcProxyRetryAttempts: 4 },
      call => json({ ok: true, result: masterchain(call.url === upstream ? wrongNetwork : network) }),
      async (app, calls) => {
        const body = await invoke(app, 'getMasterchainInfo');
        assert.equal(body.ok, true); assert.deepEqual(body.result, masterchain(network));
        assert.deepEqual(calls.map(call => call.url), [upstream, secondUpstream]);
      });
  });
  test(`${network} discovery candidates receive the same network check`, async () => {
    const wrongNetwork = network === 'mainnet' ? 'testnet' : 'mainnet';
    await scenario({ network, rpcProxyEndpoint: undefined, rpcProxyEndpoints: [] }, call => {
      if (call.request === null) {
        assert.match(call.url, /^https:\/\/ton\.access\.orbs\.network\/mngr\/nodes\?/);
        return json(['wrong', 'right'].map(NodeId => ({ NodeId, Healthy: '1', Weight: 1,
          Mngr: { health: { [`v2-${network}`]: true } } })));
      }
      assert.match(call.url, new RegExp(`/1/${network}/toncenter-api-v2/jsonRPC$`));
      return json({ ok: true, result: masterchain(call.url.includes('/wrong/') ? wrongNetwork : network) });
    }, async (app, calls) => {
      const body = await invoke(app, 'getMasterchainInfo');
      assert.equal(body.ok, true); assert.deepEqual(body.result, masterchain(network));
      assert.equal(calls.length, 3);
    });
  });
}

const badIdentities: [string, unknown][] = [
  ['mainnet', masterchain('mainnet')], ['missing init', {}], ['null result', null],
  ['array init', { init: [] }], ['wrong workchain', { init: { ...PUBLIC_RPC_ZERO_STATES.testnet, workchain: 0 } }],
  ['missing workchain', { init: { root_hash: PUBLIC_RPC_ZERO_STATES.testnet.root_hash,
    file_hash: PUBLIC_RPC_ZERO_STATES.testnet.file_hash } }],
  ['wrong root', { init: { ...PUBLIC_RPC_ZERO_STATES.testnet, root_hash: PUBLIC_RPC_ZERO_STATES.mainnet.root_hash } }],
  ['wrong file', { init: { ...PUBLIC_RPC_ZERO_STATES.testnet, file_hash: PUBLIC_RPC_ZERO_STATES.mainnet.file_hash } }]
];
for (const [description, result] of badIdentities) {
  test(`rejects ${description} without exposing endpoint credentials`, async () => {
    await scenario({ rpcProxyEndpoint: 'https://user:secret@upstream.invalid/jsonRPC?api_key=private',
      rpcProxyApiKey: 'another-secret', rpcProxyRetryAttempts: 4 }, () => json({ ok: true, result }),
    async (app, calls) => {
      const body = await invoke(app, 'getMasterchainInfo');
      assert.deepEqual(body, { id: 'sdk-request', jsonrpc: '2.0', ok: false, code: 502,
        error: 'Upstream RPC network identity does not match testnet.' });
      assert.equal(calls.length, 1, 'do not retry an identity rejected in this request');
    });
  });
}

for (const method of ['sendBoc', 'sendBocReturnHash', 'estimateFee']) {
  test(`${method} reaches only an upstream with a fresh matching identity`, async () => {
    const params = { boc: 'test-body' };
    await scenario({ enableWriteRpc: true, rpcProxyEndpoints: [upstream, secondUpstream] }, call => {
      if (call.request?.method === 'getMasterchainInfo') {
        return json({ ok: true, result: masterchain(call.url === upstream ? 'mainnet' : 'testnet') });
      }
      assert.equal(call.url, secondUpstream); assert.equal(call.request?.method, method);
      assert.deepEqual(call.request?.params, params);
      return json({ result: method === 'estimateFee' ? { source_fees: {} } : 'sdk-hash' });
    }, async (app, calls) => {
      const body = await invoke(app, method, params);
      assert.equal(body.ok, true);
      assert.deepEqual(body.result, method === 'sendBoc' ? { '@type': 'ok' }
        : method === 'estimateFee' ? { source_fees: {} } : 'sdk-hash');
      assert.deepEqual(calls.map(call => call.request?.method), ['getMasterchainInfo', 'getMasterchainInfo', method]);
    });
  });
  test(`${method} is never forwarded when all upstreams use another network`, async () => {
    await scenario({ enableWriteRpc: true }, () => json({ result: masterchain('mainnet') }),
      async (app, calls) => {
        assert.equal((await invoke(app, method, { boc: 'test-body' })).ok, false);
        assert.deepEqual(calls.map(call => call.request?.method), ['getMasterchainInfo']);
      });
  });
}

test('a previously accepted endpoint is checked again after its backend changes', async () => {
  let network: 'mainnet' | 'testnet' = 'testnet';
  await scenario({ enableWriteRpc: true }, call => json({ result: call.request?.method === 'getMasterchainInfo'
    ? masterchain(network) : 'sdk-hash' }), async (app, calls) => {
    assert.equal((await invoke(app, 'sendBoc', { boc: 'first' })).ok, true);
    network = 'mainnet';
    assert.equal((await invoke(app, 'sendBoc', { boc: 'second' })).ok, false);
    assert.deepEqual(calls.map(call => call.request?.method), ['getMasterchainInfo', 'sendBoc', 'getMasterchainInfo']);
  });
});

test('transient identity failures retry before forwarding any write', async () => {
  await scenario({ enableWriteRpc: true, rpcProxyRetryAttempts: 2 }, (call, calls) => {
    if (calls.length === 1) return json({ ok: false, code: 503, error: 'unavailable' }, 503);
    return json({ result: call.request?.method === 'getMasterchainInfo' ? masterchain('testnet') : 'sdk-hash' });
  }, async (app, calls) => {
    assert.equal((await invoke(app, 'sendBoc', { boc: 'test-body' })).ok, true);
    assert.deepEqual(calls.map(call => call.request?.method), ['getMasterchainInfo', 'getMasterchainInfo', 'sendBoc']);
  });
});

test('read-only proxy refuses writes before any network request', async () => {
  await scenario({ enableWriteRpc: false }, () => { throw new Error('must not fetch'); }, async (app, calls) => {
    for (const method of ['sendBoc', 'sendBocReturnHash', 'estimateFee']) {
      assert.equal((await invoke(app, method)).code, 403);
    }
    assert.equal(calls.length, 0);
  });
});

test('explicit localnet endpoint retains its own metadata and SDK write support', async () => {
  const localInfo = { init: { workchain: -1, root_hash: 'local-root', file_hash: 'local-file' } };
  await scenario({ network: 'localnet', enableWriteRpc: true }, call => json({ result:
    call.request?.method === 'getMasterchainInfo' ? localInfo : 'sdk-hash' }), async (app, calls) => {
    assert.deepEqual((await invoke(app, 'getMasterchainInfo')).result, localInfo);
    assert.deepEqual((await invoke(app, 'sendBoc', { boc: 'test-body' })).result, { '@type': 'ok' });
    assert.deepEqual(calls.map(call => call.request?.method), ['getMasterchainInfo', 'sendBoc']);
  });
});

test('localnet never discovers public RPC endpoints', async () => {
  await scenario({ network: 'localnet', rpcProxyEndpoint: undefined, rpcProxyEndpoints: [], enableWriteRpc: true },
    () => { throw new Error('must not discover'); }, async (app, calls) => {
      assert.equal((await invoke(app, 'getMasterchainInfo')).code, 404);
      assert.equal((await invoke(app, 'sendBoc')).code, 404);
      assert.equal(calls.length, 0);
    });
});

async function main() {
  for (const [name, run] of tests) {
    await run();
    process.stdout.write(`PASS ${name}\n`);
  }
  process.stdout.write(`RPC network identity: ${tests.length} cases passed\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
