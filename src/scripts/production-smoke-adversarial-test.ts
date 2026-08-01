import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runProductionSmoke } from './production-smoke';

type Route = {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  body: unknown;
};

type Routes = Record<string, Route>;

const openApiPaths = () => ({
  '/api/indexer/v1/service-info': {},
  '/api/indexer/v1/accounts/{addr}/balance': {},
  '/api/indexer/v1/accounts/{addr}/balances': {},
  '/api/indexer/v1/accounts/{addr}/assets': {},
  '/api/indexer/v1/accounts/{addr}/txs': {},
  '/api/indexer/v1/accounts/{addr}/state': {},
  '/api/indexer/v1/runGetMethod': {},
  '/api/indexer/v1/runGetMethods': {},
});

const validRoutes = (): Routes => ({
  '/api/indexer/v1/health': {
    body: {
      serviceId: 'ti.soramitsu.io',
      ecosystem: 'ton',
      chainId: 'ton:mainnet',
      network: 'mainnet',
      lastMasterSeqno: 123,
      indexerLagSec: 0,
      liteserverPoolStatus: 'ok',
    },
  },
  '/api/indexer/v1/service-info': {
    body: {
      schemaVersion: 1,
      serviceId: 'ti.soramitsu.io',
      ecosystem: 'ton',
      chainId: 'ton:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://ti.soramitsu.io',
      readOnly: true,
      endpoints: {
        openapi: '/api/indexer/v1/openapi.json',
      },
    },
  },
  '/api/indexer/v1/openapi.json': {
    body: {
      openapi: '3.0.3',
      info: { title: 'TONSWAP Indexer API' },
      paths: openApiPaths(),
    },
  },
});

const withServer = async (routes: Routes, run: (baseUrl: string) => Promise<void>) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const route = routes[path];
    if (!route) {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const send = () => {
      if (response.destroyed) return;
      response.statusCode = route.status ?? 200;
      response.setHeader('content-type', route.contentType ?? 'application/json');
      for (const [name, value] of Object.entries(route.headers ?? {})) response.setHeader(name, value);
      response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
};

const assertSmokeRejects = async (
  routes: Routes,
  expected: RegExp,
  options: Parameters<typeof runProductionSmoke>[1] = {},
) => {
  await withServer(routes, async (baseUrl) => {
    await assert.rejects(() => runProductionSmoke(baseUrl, options), expected);
  });
};

const assertSmokeRejectsFetchFailure = async (error: Error, expected: RegExp) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof fetch;
  try {
    await assert.rejects(() => runProductionSmoke('https://ti.soramitsu.io'), expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const assertSmokeRejectsBeforeFetch = async (baseUrl: string, expected: RegExp) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error('fetch should not be called for invalid smoke URL');
  }) as typeof fetch;
  try {
    await assert.rejects(() => runProductionSmoke(baseUrl), expected);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const main = async () => {
  await withServer(validRoutes(), async (baseUrl) => {
    await runProductionSmoke(baseUrl);
  });

  await assertSmokeRejectsBeforeFetch(
    'https://operator:secret@ti.soramitsu.io',
    /TON production smoke URL must not contain credentials/
  );
  await assertSmokeRejectsBeforeFetch(
    'file:///tmp/ton-indexer.json',
    /TON production smoke URL must use http or https/
  );
  await assertSmokeRejectsBeforeFetch(
    'https://ti.soramitsu.io?token=secret#fragment',
    /TON production smoke URL must not contain query strings or fragments/
  );
  await assertSmokeRejectsBeforeFetch(
    'http://ti.soramitsu.io',
    /TON production smoke URL must use HTTPS outside localhost smoke tests/
  );

  const redirect = validRoutes();
  redirect['/api/indexer/v1/health'] = {
    status: 302,
    headers: { location: '/redirect-target?secret=must-not-leak' },
    body: 'redirecting',
  };
  redirect['/redirect-target'] = validRoutes()['/api/indexer/v1/health'];
  await assertSmokeRejects(
    redirect,
    /refused redirect HTTP 302; production smoke redirects are forbidden/,
  );

  const slowHealth = validRoutes();
  slowHealth['/api/indexer/v1/health'].delayMs = 200;
  await assertSmokeRejects(
    slowHealth,
    /request .*timed out after 25ms.*Production routing must serve the TON indexer contract/,
    { timeoutMs: 25 },
  );

  const startedAt = Date.now();
  await assert.rejects(
    () => runProductionSmoke('https://ti.soramitsu.io', {
      timeoutMs: 25,
      fetchImpl: async () => new Promise<Response>(() => undefined),
    }),
    /timed out after 25ms/,
  );
  assert.ok(Date.now() - startedAt < 500, 'a non-cooperative fetch must still be deadline-bounded');

  const oversizedHealth = validRoutes();
  oversizedHealth['/api/indexer/v1/health'].body = {
    ...(oversizedHealth['/api/indexer/v1/health'].body as Record<string, unknown>),
    padding: 'x'.repeat(512),
  };
  await assertSmokeRejects(
    oversizedHealth,
    /response exceeded the 128-byte limit/,
    { maxResponseBytes: 128 },
  );

  for (const contentType of [
    'text/application/json',
    'application/jsonp',
    'application/json, text/html',
  ]) {
    const misleadingContentType = validRoutes();
    misleadingContentType['/api/indexer/v1/health'].contentType = contentType;
    await assertSmokeRejects(misleadingContentType, /did not return JSON\. Content-Type:/);
  }

  const structuredJson = validRoutes();
  structuredJson['/api/indexer/v1/health'].contentType = 'application/health+json; charset="utf-8"';
  await withServer(structuredJson, async (baseUrl) => runProductionSmoke(baseUrl));

  const solswapHealth = validRoutes();
  solswapHealth['/api/indexer/v1/health'].body = { ok: true };
  await assertSmokeRejects(solswapHealth, /TI production routing points at a Solswap indexer contract/);

  const genericHealth = validRoutes();
  genericHealth['/api/indexer/v1/health'].body = { status: 'ok' };
  await assertSmokeRejects(genericHealth, /TI production routing does not expose the TON health contract/);

  const networkError = new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND ti.soramitsu.io'), {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'ti.soramitsu.io',
    }),
  });
  await assertSmokeRejectsFetchFailure(
    networkError,
    /\/api\/indexer\/v1\/health request to https:\/\/ti\.soramitsu\.io\/api\/indexer\/v1\/health failed: fetch failed; cause: getaddrinfo ENOTFOUND ti\.soramitsu\.io; code=ENOTFOUND; syscall=getaddrinfo; hostname=ti\.soramitsu\.io.*Production routing must serve the TON indexer contract at ti\.soramitsu\.io/
  );

  const secretTransportError = new TypeError(
    'fetch failed password=transport-password',
    {
      cause: new Error(
        `upstream https://operator:transport-pass@ti.soramitsu.io/?api_key=transport-key Authorization: Bearer transport-bearer ${'x'.repeat(2_000)}`,
      ),
    },
  );
  await assert.rejects(
    () => runProductionSmoke('https://ti.soramitsu.io', {
      fetchImpl: async () => { throw secretTransportError; },
    }),
    (error: unknown) => {
      const diagnostic = String(error);
      assert.match(diagnostic, /<redacted>/);
      for (const secret of ['transport-password', 'transport-pass', 'transport-key', 'transport-bearer']) {
        assert.doesNotMatch(diagnostic, new RegExp(secret));
      }
      assert.ok(diagnostic.length < 1_000, 'transport diagnostics must stay bounded');
      return true;
    },
  );

  const oldDeployedHealth = validRoutes();
  oldDeployedHealth['/api/indexer/v1/health'].body = {
    lastMasterSeqno: 123,
    indexerLagSec: 0,
    liteserverPoolStatus: 'ok',
  };
  await assertSmokeRejects(
    oldDeployedHealth,
    /health serviceId must be ti\.soramitsu\.io; received <missing>.*Deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  const zeroMasterSeqno = validRoutes();
  (zeroMasterSeqno['/api/indexer/v1/health'].body as Record<string, unknown>).lastMasterSeqno = 0;
  await assertSmokeRejects(zeroMasterSeqno, /health lastMasterSeqno must be a positive safe integer/);

  const missingLag = validRoutes();
  delete (missingLag['/api/indexer/v1/health'].body as Record<string, unknown>).indexerLagSec;
  await assertSmokeRejects(missingLag, /health indexerLagSec must be a non-negative finite number/);

  const staleLag = validRoutes();
  (staleLag['/api/indexer/v1/health'].body as Record<string, unknown>).indexerLagSec = 301;
  await assertSmokeRejects(staleLag, /health indexerLagSec must be at most 300; received 301/);

  const futureSourceTimestamp = validRoutes();
  (futureSourceTimestamp['/api/indexer/v1/health'].body as Record<string, unknown>).indexerLagSec = -31;
  await assertSmokeRejects(
    futureSourceTimestamp,
    /health indexerLagSec must be a non-negative finite number; received -31/,
  );

  const wrongHealthIdentity = validRoutes();
  wrongHealthIdentity['/api/indexer/v1/health'].body = {
    serviceId: 'si.soramitsu.io',
    ecosystem: 'solana',
    chainId: 'solana:mainnet',
    network: 'mainnet',
    lastMasterSeqno: 123,
    indexerLagSec: 0,
  };
  await assertSmokeRejects(wrongHealthIdentity, /health serviceId must be ti\.soramitsu\.io/);

  const missingServiceInfo = validRoutes();
  delete missingServiceInfo['/api/indexer/v1/service-info'];
  await assertSmokeRejects(missingServiceInfo, /deploy the current ton-indexer image to ti\.soramitsu\.io/);

  const serviceInfoDeploying = validRoutes();
  serviceInfoDeploying['/api/indexer/v1/service-info'] = {
    status: 503,
    contentType: 'text/plain; charset=utf-8',
    body: 'deploy in progress',
  };
  await assertSmokeRejects(
    serviceInfoDeploying,
    /\/api\/indexer\/v1\/service-info returned HTTP 503\. Body preview: deploy in progress\..*deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  const secretDeployFailure = validRoutes();
  secretDeployFailure['/api/indexer/v1/service-info'] = {
    status: 503,
    contentType: 'application/json',
    body: '{"token":"body-token","password":"body-password","api_key":"body-key","authorization":"Bearer body-bearer"}',
  };
  await withServer(secretDeployFailure, async (baseUrl) => {
    await assert.rejects(
      () => runProductionSmoke(baseUrl),
      (error: unknown) => {
        const diagnostic = String(error);
        assert.match(diagnostic, /<redacted>/);
        for (const secret of ['body-token', 'body-password', 'body-key', 'body-bearer']) {
          assert.doesNotMatch(diagnostic, new RegExp(secret));
        }
        return true;
      },
    );
  });

  const missingSchemaVersion = validRoutes();
  delete (missingSchemaVersion['/api/indexer/v1/service-info'].body as Record<string, unknown>).schemaVersion;
  await assertSmokeRejects(
    missingSchemaVersion,
    /service-info schemaVersion must be 1; received <missing>.*Production service-info must expose schemaVersion=1, serviceId=ti\.soramitsu\.io.*Deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  const wrongIdentity = validRoutes();
  wrongIdentity['/api/indexer/v1/service-info'].body = {
    serviceId: 'si.soramitsu.io',
    ecosystem: 'solana',
    chainId: 'solana:mainnet',
    publicBaseUrl: 'https://si.soramitsu.io',
    readOnly: true,
  };
  await assertSmokeRejects(
    wrongIdentity,
    /service-info serviceId must be ti\.soramitsu\.io; received si\.soramitsu\.io.*Production service-info must expose schemaVersion=1, serviceId=ti\.soramitsu\.io.*Deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  const wrongNetwork = validRoutes();
  wrongNetwork['/api/indexer/v1/service-info'].body = {
    ...(wrongNetwork['/api/indexer/v1/service-info'].body as Record<string, unknown>),
    network: 'testnet',
  };
  await assertSmokeRejects(
    wrongNetwork,
    /service-info network must be mainnet; received testnet.*Production service-info must expose schemaVersion=1, serviceId=ti\.soramitsu\.io/
  );

  const nonJson = validRoutes();
  nonJson['/api/indexer/v1/health'] = {
    contentType: 'text/plain; charset=utf-8',
    body: 'ok',
  };
  await assertSmokeRejects(nonJson, /\/api\/indexer\/v1\/health did not return JSON\..*Body preview: ok/);

  const invalidOpenApiJson = validRoutes();
  invalidOpenApiJson['/api/indexer/v1/openapi.json'] = {
    contentType: 'application/json',
    body: '{"openapi":',
  };
  await assertSmokeRejects(
    invalidOpenApiJson,
    /\/api\/indexer\/v1\/openapi\.json returned invalid JSON\. Body preview: \{"openapi":\..*TON OpenAPI contract/
  );

  const missingOpenApiPath = validRoutes();
  const spec = missingOpenApiPath['/api/indexer/v1/openapi.json'].body as { paths: Record<string, unknown> };
  delete spec.paths['/api/indexer/v1/runGetMethods'];
  await assertSmokeRejects(
    missingOpenApiPath,
    /OpenAPI is missing \/api\/indexer\/v1\/runGetMethods.*Production OpenAPI must expose title TONSWAP Indexer API.*Deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  const missingTitle = validRoutes();
  missingTitle['/api/indexer/v1/openapi.json'].body = {
    openapi: '3.0.3',
    paths: openApiPaths(),
  };
  await assertSmokeRejects(
    missingTitle,
    /OpenAPI title must be TONSWAP Indexer API; received <missing>.*Production OpenAPI must expose title TONSWAP Indexer API.*Deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  const wrongTitle = validRoutes();
  wrongTitle['/api/indexer/v1/openapi.json'].body = {
    openapi: '3.0.3',
    info: { title: 'Solswap Indexer API' },
    paths: openApiPaths(),
  };
  await assertSmokeRejects(
    wrongTitle,
    /OpenAPI title must be TONSWAP Indexer API; received Solswap Indexer API.*Production OpenAPI must expose title TONSWAP Indexer API.*Deploy the current ton-indexer image to ti\.soramitsu\.io/
  );

  process.stdout.write('ton production smoke adversarial tests passed\n');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
