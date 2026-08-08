import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashRegistry,
  hashReleaseManifest,
  readCanonicalReleaseManifest,
} from '../config/releaseManifest';
import {
  CANONICAL_RELEASE_CONTRACT_COUNT,
  runProductionSmoke,
  type ProductionSmokeOptions,
} from './production-smoke';

type Route = {
  status?: number;
  contentType?: string;
  body: unknown;
  expectedSearchParams?: Record<string, string>;
};

type Routes = Record<string, Route>;
type ServerOptions = {
  corsOrigins?: string[];
  preflightCorsOrigins?: string[];
  preflightAllowMethods?: string;
  preflightAllowHeaders?: string;
};

const releaseId = 'tonswap-v1-test';
const expectedCorsOrigin = 'https://test.tonswap.org';
const hostileCorsOrigin = 'https://hostile.tonswap.invalid';
const smokeEnvironmentNames = [
  'TON_INDEXER_BASE_URL',
  'TON_INDEXER_EXPECTED_NETWORK',
  'TON_INDEXER_EXPECTED_SERVICE_ID',
  'TON_INDEXER_EXPECTED_PUBLIC_BASE_URL',
  'TON_INDEXER_EXPECTED_RELEASE_ID',
  'TON_INDEXER_EXPECTED_REGISTRY_HASH',
  'TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH',
  'TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH',
  'TON_INDEXER_EXPECTED_CORS_ORIGIN',
  'TON_INDEXER_HOSTILE_CORS_ORIGIN',
] as const;

const address = (value: number) => `0:${value.toString(16).padStart(64, '0')}`;
const cloneRoutes = (routes: Routes): Routes => JSON.parse(JSON.stringify(routes)) as Routes;

const openApiPaths = () => ({
  '/api/indexer/v1/service-info': {},
  '/api/indexer/v1/contracts': {},
  '/api/indexer/v1/accounts/{addr}/balance': {},
  '/api/indexer/v1/accounts/{addr}/balances': {},
  '/api/indexer/v1/accounts/{addr}/assets': {},
  '/api/indexer/v1/accounts/{addr}/txs': {},
  '/api/indexer/v1/accounts/{addr}/state': {},
  '/api/indexer/v1/markets/{market}/candles': {},
  '/api/indexer/v1/runGetMethod': {},
  '/api/indexer/v1/runGetMethods': {},
});

const openApi = () => ({
  openapi: '3.0.3',
  info: { title: 'TONSWAP Indexer API', version: '1.0.0' },
  servers: [{ url: '/' }],
  paths: openApiPaths(),
});

const basicRoutes = (): Routes => ({
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
      endpoints: { openapi: '/api/indexer/v1/openapi.json' },
      release: { releaseId: null, registryHash: null, releaseManifestHash: null },
    },
  },
  '/api/indexer/v1/contracts': {
    body: {
      network: 'mainnet',
      count: 1,
      contracts: { T3Root: address(1) },
      registry_hash: null,
      release_id: null,
      release_manifest_hash: null,
    },
  },
  '/api/indexer/v1/openapi.json': { body: openApi() },
});

const releaseMarkets = () => {
  let nextAddress = 20;
  return (['fixed', 'bonding', 'dutch'] as const).map((saleModel, index) => ({
    saleModel,
    symbol: ['FIX', 'BOND', 'DUTCH'][index],
    tokenRoot: address(nextAddress++),
    sale: address(nextAddress++),
    lpVault: address(nextAddress++),
    pool: address(nextAddress++),
    optionAddress: address(nextAddress++),
    perpsMarketId: index + 1,
    optionSeriesId: `series-${index + 1}`,
    coverPolicyId: `cover-${index + 1}`,
    decimals: 9,
    quoteDecimals: 9,
  }));
};

const releaseContracts = (markets: ReturnType<typeof releaseMarkets>) => {
  const contracts: Record<string, string> = {
    KusdDiscovery: address(2),
    KusdRoot: address(2),
    UsdcDiscovery: address(3),
    UsdcRoot: address(3),
    UsdtDiscovery: address(4),
    UsdtRoot: address(4),
  };
  for (const market of markets) {
    const model = `${market.saleModel[0].toUpperCase()}${market.saleModel.slice(1)}`;
    contracts[`Launchpad${model}TokenRoot`] = market.tokenRoot;
    contracts[`Launchpad${model}Sale`] = market.sale;
    contracts[`Launchpad${model}LpVault`] = market.lpVault;
    contracts[`Launchpad${model}Pool`] = market.pool;
    contracts[`Launchpad${model}Option`] = market.optionAddress;
  }
  let filler = 1;
  while (Object.keys(contracts).length < CANONICAL_RELEASE_CONTRACT_COUNT) {
    contracts[`CanonicalRole${String(filler).padStart(2, '0')}`] = address(100 + filler);
    filler += 1;
  }
  return Object.fromEntries(
    Object.entries(contracts).sort(([left], [right]) => left.localeCompare(right))
  );
};

const writeReleaseManifest = (
  root: string,
  name: string,
  contracts: Record<string, string>,
  markets: ReturnType<typeof releaseMarkets>
) => {
  const unsigned = {
    schema: 'tonswap-testnet-release-v1',
    schemaVersion: 1,
    network: 'ton:testnet',
    releaseId,
    registryHash: hashRegistry(contracts),
    contracts,
    markets,
  };
  const manifest = { ...unsigned, manifestHash: hashReleaseManifest(unsigned) };
  const manifestPath = join(root, name);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
};

const strictFixture = (root: string) => {
  const markets = releaseMarkets();
  const contracts = releaseContracts(markets);
  const { manifest, manifestPath } = writeReleaseManifest(
    root,
    'release-manifest.json',
    contracts,
    markets
  );
  const parsed = readCanonicalReleaseManifest(manifestPath, 'testnet');
  const routes: Routes = {
    '/api/indexer/v1/health': {
      body: {
        serviceId: 'ti.soramitsu.io',
        ecosystem: 'ton',
        chainId: 'ton:testnet',
        network: 'testnet',
        lastMasterSeqno: 123,
      },
    },
    '/api/indexer/v1/service-info': {
      body: {
        schemaVersion: 1,
        serviceId: 'ti.soramitsu.io',
        ecosystem: 'ton',
        chainId: 'ton:testnet',
        network: 'testnet',
        publicBaseUrl: 'https://ti.soramitsu.io',
        readOnly: true,
        endpoints: { openapi: '/api/indexer/v1/openapi.json' },
        release: {
          releaseId,
          registryHash: parsed.registryHash,
          releaseManifestHash: parsed.releaseManifestHash,
        },
      },
    },
    '/api/indexer/v1/contracts': {
      body: {
        network: 'testnet',
        count: CANONICAL_RELEASE_CONTRACT_COUNT,
        contracts: parsed.contracts,
        registry_hash: parsed.registryHash,
        release_id: releaseId,
        release_manifest_hash: parsed.releaseManifestHash,
      },
    },
    '/api/indexer/v1/openapi.json': { body: openApi() },
  };
  for (const [index, market] of parsed.markets.entries()) {
    const routePath = `/api/indexer/v1/markets/${encodeURIComponent(market.marketKey)}/candles`;
    routes[routePath] = {
      expectedSearchParams: {
        market_address: market.marketAddress,
        asset_symbol: market.assetSymbol,
        quote_symbol: market.quoteSymbol,
        asset_decimals: String(market.assetDecimals),
        quote_decimals: String(market.quoteDecimals),
        interval: '1m',
        limit: '2',
      },
      body: {
        market_key: market.marketKey,
        market_address: market.marketAddress,
        interval: '1m',
        from_utime: null,
        to_utime: null,
        candle_count: 2,
        history_complete: true,
        synced_at: 200,
        network: 'testnet',
        candles: [
          {
            ts: 120,
            open: index + 2,
            high: index + 2,
            low: index + 2,
            close: index + 2,
            volumeBase: 1,
            volumeQuote: index + 2,
            tradeCount: 1,
            sourceTxIds: [`${index + 1}:tx-a`],
          },
          {
            ts: 180,
            open: index + 3,
            high: index + 3,
            low: index + 3,
            close: index + 3,
            volumeBase: 1,
            volumeQuote: index + 3,
            tradeCount: 1,
            sourceTxIds: [`${index + 1}:tx-b`],
          },
        ],
      },
    };
  }
  const options: ProductionSmokeOptions = {
    expectedNetwork: 'testnet',
    expectedReleaseId: releaseId,
    expectedRegistryHash: parsed.registryHash,
    expectedReleaseManifestHash: parsed.releaseManifestHash,
    expectedReleaseManifestPath: manifestPath,
    expectedCorsOrigin,
    hostileCorsOrigin,
  };
  return { contracts, manifest, manifestPath, markets, options, routes };
};

const withServer = async (
  routes: Routes,
  run: (baseUrl: string) => Promise<void>,
  options: ServerOptions = {}
) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = request.headers.origin;
    if (request.method === 'OPTIONS' && url.pathname === '/api/indexer/v1/runGetMethod') {
      const preflightOrigins = options.preflightCorsOrigins ?? options.corsOrigins;
      if (typeof origin === 'string' && preflightOrigins?.includes(origin)) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-credentials', 'true');
        response.setHeader('access-control-allow-methods', options.preflightAllowMethods ?? 'POST');
        response.setHeader(
          'access-control-allow-headers',
          options.preflightAllowHeaders ?? 'content-type,accept'
        );
        response.setHeader('vary', 'Origin');
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    const route = routes[url.pathname];
    if (!route) {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    if (route.expectedSearchParams) {
      const actual = Object.fromEntries([...url.searchParams.entries()].sort());
      const expected = Object.fromEntries(Object.entries(route.expectedSearchParams).sort());
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: 'unexpected_search_parameters' }));
        return;
      }
    }
    if (typeof origin === 'string' && options.corsOrigins?.includes(origin)) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('vary', 'Origin');
    }
    response.statusCode = route.status ?? 200;
    response.setHeader('content-type', route.contentType ?? 'application/json');
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverAddress = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${serverAddress.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const runSmokeCli = async (
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '--silent', 'smoke:production', '--', ...args], {
      cwd: join(__dirname, '..', '..'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });

const smokeCliEnvironment = (
  values: Partial<Record<(typeof smokeEnvironmentNames)[number], string>> = {}
): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const name of smokeEnvironmentNames) delete environment[name];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const assertSmokeRejects = async (
  routes: Routes,
  expected: RegExp,
  smokeOptions: ProductionSmokeOptions = { allowUnboundRelease: true },
  serverOptions: ServerOptions = {}
) => {
  await withServer(
    routes,
    async (baseUrl) => {
      await assert.rejects(() => runProductionSmoke(baseUrl, smokeOptions), expected);
    },
    serverOptions
  );
};

const withSmokeEnvironment = async (
  values: Partial<Record<(typeof smokeEnvironmentNames)[number], string>>,
  run: () => Promise<void>
) => {
  const previous = Object.fromEntries(
    smokeEnvironmentNames.map((name) => [name, process.env[name]])
  ) as Record<(typeof smokeEnvironmentNames)[number], string | undefined>;
  try {
    for (const name of smokeEnvironmentNames) delete process.env[name];
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) process.env[name] = value;
    }
    await run();
  } finally {
    for (const name of smokeEnvironmentNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const main = async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ton-production-smoke-')));
  await withSmokeEnvironment({}, async () => {
    await withServer(basicRoutes(), async (baseUrl) => {
      await assert.rejects(
        () => runProductionSmoke(baseUrl),
        /Release-bound production smoke requires explicit/
      );
      await runProductionSmoke(baseUrl, { allowUnboundRelease: true });
    });

    const testnet = basicRoutes();
    for (const path of ['/api/indexer/v1/health', '/api/indexer/v1/service-info']) {
      const body = testnet[path].body as Record<string, unknown>;
      body.network = 'testnet';
      body.chainId = 'ton:testnet';
    }
    (testnet['/api/indexer/v1/contracts'].body as Record<string, unknown>).network = 'testnet';
    await withServer(testnet, async (baseUrl) => {
      await runProductionSmoke(baseUrl, {
        expectedNetwork: 'testnet',
        allowUnboundRelease: true,
      });
    });

    const strict = strictFixture(root);
    await withServer(
      strict.routes,
      async (baseUrl) => runProductionSmoke(baseUrl, strict.options),
      { corsOrigins: [expectedCorsOrigin] }
    );
    await withSmokeEnvironment(
      {
        TON_INDEXER_EXPECTED_NETWORK: 'testnet',
        TON_INDEXER_EXPECTED_RELEASE_ID: releaseId,
        TON_INDEXER_EXPECTED_REGISTRY_HASH: strict.options.expectedRegistryHash,
        TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH:
          strict.options.expectedReleaseManifestHash,
        TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH:
          strict.options.expectedReleaseManifestPath,
        TON_INDEXER_EXPECTED_CORS_ORIGIN: expectedCorsOrigin,
      },
      async () => {
        await withServer(
          strict.routes,
          async (baseUrl) => runProductionSmoke(baseUrl),
          { corsOrigins: [expectedCorsOrigin] }
        );
      }
    );

    const unboundCli = await runSmokeCli(
      ['http://127.0.0.1:9', 'testnet'],
      smokeCliEnvironment()
    );
    assert.notEqual(unboundCli.status, 0);
    assert.match(
      `${unboundCli.stdout}\n${unboundCli.stderr}`,
      /Release-bound production smoke requires explicit/
    );

    const redactedCli = await runSmokeCli(
      ['https://visible-user:secret-value@127.0.0.1/?token=private-value', 'testnet'],
      smokeCliEnvironment()
    );
    const redactedOutput = `${redactedCli.stdout}\n${redactedCli.stderr}`;
    assert.notEqual(redactedCli.status, 0);
    assert.doesNotMatch(redactedOutput, /secret-value|private-value|token=/);
    assert.match(redactedOutput, /https:\/\/127\.0\.0\.1\//);

    await withServer(
      strict.routes,
      async (baseUrl) => {
        const cli = await runSmokeCli(
          [],
          smokeCliEnvironment({
            TON_INDEXER_BASE_URL: baseUrl,
            TON_INDEXER_EXPECTED_NETWORK: 'testnet',
            TON_INDEXER_EXPECTED_RELEASE_ID: releaseId,
            TON_INDEXER_EXPECTED_REGISTRY_HASH: strict.options.expectedRegistryHash,
            TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH:
              strict.options.expectedReleaseManifestHash,
            TON_INDEXER_EXPECTED_RELEASE_MANIFEST_PATH:
              strict.options.expectedReleaseManifestPath,
            TON_INDEXER_EXPECTED_CORS_ORIGIN: expectedCorsOrigin,
          })
        );
        assert.equal(cli.status, 0, cli.stderr);
        assert.match(cli.stdout, /ton production smoke ok:/);
      },
      { corsOrigins: [expectedCorsOrigin] }
    );

    await assertSmokeRejects(
      strict.routes,
      /TON_INDEXER_EXPECTED_NETWORK must be explicitly set/,
      {
        expectedReleaseId: strict.options.expectedReleaseId,
        expectedRegistryHash: strict.options.expectedRegistryHash,
        expectedReleaseManifestHash: strict.options.expectedReleaseManifestHash,
        expectedReleaseManifestPath: strict.options.expectedReleaseManifestPath,
        expectedCorsOrigin,
      }
    );
    await assertSmokeRejects(
      strict.routes,
      /TON_INDEXER_EXPECTED_REGISTRY_HASH must be an explicit/,
      { expectedNetwork: 'testnet', expectedReleaseId: releaseId }
    );
    await assertSmokeRejects(
      strict.routes,
      /release manifest registryHash must be/,
      { ...strict.options, expectedRegistryHash: 'b'.repeat(64) }
    );
    await assertSmokeRejects(
      strict.routes,
      /release manifest manifestHash must be/,
      { ...strict.options, expectedReleaseManifestHash: 'b'.repeat(64) }
    );

    const wrongServiceManifest = cloneRoutes(strict.routes);
    const wrongServiceRelease = (
      wrongServiceManifest['/api/indexer/v1/service-info'].body as {
        release: Record<string, unknown>;
      }
    ).release;
    wrongServiceRelease.releaseManifestHash = 'b'.repeat(64);
    await assertSmokeRejects(
      wrongServiceManifest,
      /service-info releaseManifestHash must be/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const shortContracts = cloneRoutes(strict.routes);
    const shortContractBody = shortContracts['/api/indexer/v1/contracts'].body as {
      count: number;
      contracts: Record<string, string>;
    };
    delete shortContractBody.contracts.CanonicalRole01;
    shortContractBody.count -= 1;
    await assertSmokeRejects(
      shortContracts,
      /contracts payload must contain exactly 62 contracts/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const mismatchedDiscoveryContracts = {
      ...strict.contracts,
      KusdDiscovery: address(999),
    };
    const mismatchedManifest = writeReleaseManifest(
      root,
      'mismatched-discovery.json',
      mismatchedDiscoveryContracts,
      strict.markets
    );
    const mismatchParsed = readCanonicalReleaseManifest(
      mismatchedManifest.manifestPath,
      'testnet'
    );
    await assertSmokeRejects(
      strict.routes,
      /release manifest KusdDiscovery must exactly equal KusdRoot/,
      {
        ...strict.options,
        expectedRegistryHash: mismatchParsed.registryHash,
        expectedReleaseManifestHash: mismatchParsed.releaseManifestHash,
        expectedReleaseManifestPath: mismatchedManifest.manifestPath,
      }
    );

    const writable = cloneRoutes(strict.routes);
    (writable['/api/indexer/v1/service-info'].body as Record<string, unknown>).readOnly = false;
    await assertSmokeRejects(
      writable,
      /service-info readOnly must be true/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    await assertSmokeRejects(
      strict.routes,
      /allowed CORS origin must be/,
      strict.options
    );
    await assertSmokeRejects(
      strict.routes,
      /hostile CORS origin .* must be denied/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin, hostileCorsOrigin] }
    );
    await assertSmokeRejects(
      strict.routes,
      /allowed production preflight must permit POST/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin], preflightAllowMethods: 'GET' }
    );
    await assertSmokeRejects(
      strict.routes,
      /hostile preflight origin .* must be denied/,
      strict.options,
      {
        corsOrigins: [expectedCorsOrigin],
        preflightCorsOrigins: [expectedCorsOrigin, hostileCorsOrigin],
      }
    );

    const shortHistory = cloneRoutes(strict.routes);
    const firstMarket = readCanonicalReleaseManifest(strict.manifestPath, 'testnet').markets[0];
    const history = shortHistory[
      `/api/indexer/v1/markets/${encodeURIComponent(firstMarket.marketKey)}/candles`
    ].body as { candle_count: number; candles: unknown[] };
    history.candle_count = 1;
    history.candles.pop();
    await assertSmokeRejects(
      shortHistory,
      /candle_count must be exactly 2/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const malformedHistory = cloneRoutes(strict.routes);
    const firstHistory = malformedHistory[
      `/api/indexer/v1/markets/${encodeURIComponent(firstMarket.marketKey)}/candles`
    ].body as { candles: Array<Record<string, unknown>> };
    delete firstHistory.candles[0].volumeQuote;
    await assertSmokeRejects(
      malformedHistory,
      /volumeQuote must be a positive finite number/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const duplicateHistoryTransactions = cloneRoutes(strict.routes);
    const parsedMarkets = readCanonicalReleaseManifest(strict.manifestPath, 'testnet').markets;
    const firstMarketHistory = duplicateHistoryTransactions[
      `/api/indexer/v1/markets/${encodeURIComponent(parsedMarkets[0].marketKey)}/candles`
    ].body as { candles: Array<{ sourceTxIds: string[] }> };
    const secondMarketHistory = duplicateHistoryTransactions[
      `/api/indexer/v1/markets/${encodeURIComponent(parsedMarkets[1].marketKey)}/candles`
    ].body as { candles: Array<{ sourceTxIds: string[] }> };
    secondMarketHistory.candles[0].sourceTxIds = [
      firstMarketHistory.candles[0].sourceTxIds[0],
    ];
    await assertSmokeRejects(
      duplicateHistoryTransactions,
      /all release-market candle source transactions must be distinct/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const solswapHealth = basicRoutes();
    solswapHealth['/api/indexer/v1/health'].body = { ok: true };
    await assertSmokeRejects(
      solswapHealth,
      /TI production routing points at a Solswap indexer contract/
    );

    const genericHealth = basicRoutes();
    genericHealth['/api/indexer/v1/health'].body = { status: 'ok' };
    await assertSmokeRejects(
      genericHealth,
      /TI production routing does not expose the TON health contract/
    );

    const nonJson = basicRoutes();
    nonJson['/api/indexer/v1/health'] = {
      contentType: 'text/plain; charset=utf-8',
      body: 'ok',
    };
    await assertSmokeRejects(nonJson, /\/api\/indexer\/v1\/health did not return JSON/);

    const missingOpenApiPath = basicRoutes();
    const spec = missingOpenApiPath['/api/indexer/v1/openapi.json'].body as {
      paths: Record<string, unknown>;
    };
    delete spec.paths['/api/indexer/v1/runGetMethods'];
    await assertSmokeRejects(
      missingOpenApiPath,
      /OpenAPI is missing \/api\/indexer\/v1\/runGetMethods/
    );

    const wrongTitle = basicRoutes();
    wrongTitle['/api/indexer/v1/openapi.json'].body = {
      ...openApi(),
      info: { title: 'Solswap Indexer API', version: '1.0.0' },
    };
    await assertSmokeRejects(wrongTitle, /OpenAPI title must be TONSWAP Indexer API/);

    assert.equal(
      JSON.parse(readFileSync(strict.manifestPath, 'utf8')).manifestHash,
      strict.options.expectedReleaseManifestHash
    );
    process.stdout.write('ton production smoke adversarial tests passed\n');
  }).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
