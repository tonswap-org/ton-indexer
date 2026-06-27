import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runProductionSmoke } from './production-smoke';

type Route = {
  status?: number;
  contentType?: string;
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

    response.statusCode = route.status ?? 200;
    response.setHeader('content-type', route.contentType ?? 'application/json');
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
};

const assertSmokeRejects = async (routes: Routes, expected: RegExp) => {
  await withServer(routes, async (baseUrl) => {
    await assert.rejects(() => runProductionSmoke(baseUrl), expected);
  });
};

const main = async () => {
  await withServer(validRoutes(), async (baseUrl) => {
    await runProductionSmoke(baseUrl);
  });

  const solswapHealth = validRoutes();
  solswapHealth['/api/indexer/v1/health'].body = { ok: true };
  await assertSmokeRejects(solswapHealth, /TI production routing points at a Solswap indexer contract/);

  const genericHealth = validRoutes();
  genericHealth['/api/indexer/v1/health'].body = { status: 'ok' };
  await assertSmokeRejects(genericHealth, /TI production routing does not expose the TON health contract/);

  const missingServiceInfo = validRoutes();
  delete missingServiceInfo['/api/indexer/v1/service-info'];
  await assertSmokeRejects(missingServiceInfo, /deploy the current ton-indexer image to ti\.soramitsu\.io/);

  const wrongIdentity = validRoutes();
  wrongIdentity['/api/indexer/v1/service-info'].body = {
    serviceId: 'si.soramitsu.io',
    ecosystem: 'solana',
    chainId: 'solana:mainnet',
    publicBaseUrl: 'https://si.soramitsu.io',
    readOnly: true,
  };
  await assertSmokeRejects(wrongIdentity, /service-info serviceId must be ti\.soramitsu\.io/);

  const wrongNetwork = validRoutes();
  wrongNetwork['/api/indexer/v1/service-info'].body = {
    ...(wrongNetwork['/api/indexer/v1/service-info'].body as Record<string, unknown>),
    network: 'testnet',
  };
  await assertSmokeRejects(wrongNetwork, /service-info network must be mainnet/);

  const nonJson = validRoutes();
  nonJson['/api/indexer/v1/health'] = {
    contentType: 'text/plain; charset=utf-8',
    body: 'ok',
  };
  await assertSmokeRejects(nonJson, /\/api\/indexer\/v1\/health did not return JSON/);

  const missingOpenApiPath = validRoutes();
  const spec = missingOpenApiPath['/api/indexer/v1/openapi.json'].body as { paths: Record<string, unknown> };
  delete spec.paths['/api/indexer/v1/runGetMethods'];
  await assertSmokeRejects(missingOpenApiPath, /OpenAPI is missing \/api\/indexer\/v1\/runGetMethods/);

  const wrongTitle = validRoutes();
  wrongTitle['/api/indexer/v1/openapi.json'].body = {
    openapi: '3.0.3',
    info: { title: 'Solswap Indexer API' },
    paths: openApiPaths(),
  };
  await assertSmokeRejects(wrongTitle, /OpenAPI title must be TONSWAP Indexer API/);

  process.stdout.write('ton production smoke adversarial tests passed\n');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
