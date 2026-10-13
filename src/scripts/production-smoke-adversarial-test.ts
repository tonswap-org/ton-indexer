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
  runProductionSmoke,
  type ProductionSmokeOptions,
} from './production-smoke';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

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
  mount?: string;
  requests?: string[];
};

const releaseId = runtimeManifestFixture().releaseId;
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
  '/api/indexer/v1/accounts/{addr}/balances': {},
  '/api/indexer/v1/accounts/{addr}/txs': {},
  '/api/indexer/v1/accounts/{addr}/state': {},
  '/api/indexer/v1/markets/{market}/candles': {},
  '/api/indexer/v1/runGetMethod': {},
});

const openApi = () => ({
  openapi: '3.1.0',
  info: { title: 'TONSWAP Indexer API', version: '1.0.0' },
  servers: [{ url: '/' }],
  paths: openApiPaths(),
});

const balanceBody = (account: string, network: string, tokens: Array<{root:string;symbol:string;decimals:number}> = []) => ({
  address: account, network, head_seqno: 123, head_utime: 1700000000, complete: true,
  assets: [{kind:'native',symbol:'GRAM',status:'ok',balance_raw:'1000000000',decimals:9},
    ...tokens.map(token => ({kind:'jetton',...token,wallet:address(900),status:'not_deployed',balance_raw:'0'}))],
});

const basicRoutes = (): Routes => ({
  [`/api/indexer/v1/accounts/${address(1)}/balances`]: {body:balanceBody(address(1),'mainnet')},
  '/api/indexer/v1/health': {
    body: {
      serviceId: 'ti.soramitsu.io',
      ecosystem: 'ton',
      chainId: 'ton:mainnet',
      network: 'mainnet',
      chain: {peersConfigured: 2, peersReady: 2, headSeqno: 123, headAgeSec: 1}, ledger: 'ready', disk: 'ok',
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
      release: { releaseId: null, manifestHash: null },
    },
  },
  '/api/indexer/v1/contracts': {
    body: {
      network: 'mainnet',
      count: 1,
      contracts: { T3Root: address(1) },
      release: { releaseId: null, manifestHash: null },
    },
  },
  '/api/indexer/v1/openapi.json': { body: openApi() },
});

const releaseMarkets = () => {
  const fixture = runtimeManifestFixture();
  return fixture.spotMarkets.map(spot => ({ ...spot,
    tokenRoot: fixture.tokens.find(token => token.symbol === spot.symbol)!.root, decimals: 9 }));
};
const releaseContracts = (_markets: ReturnType<typeof releaseMarkets>) => Object.fromEntries(
  Object.entries(runtimeManifestFixture().contracts).map(([role, contract]) => [role, contract!.address])
);
const writeReleaseManifest = (
  root: string,
  name: string,
  contracts: Record<string, string>,
  markets: ReturnType<typeof releaseMarkets>,
  spots = markets,
  indexer = 'https://ti.soramitsu.io/api/indexer',
) => {
  const manifest = runtimeManifestFixture({
    services: { ...runtimeManifestFixture().services, indexer },
    contracts: Object.fromEntries(Object.entries(contracts).map(([role, address]) => [role, { address, codeHash: 'a'.repeat(64) }])),
    spotMarkets: spots.map(({ symbol, pool, binSpacing, feePips }) => ({ symbol, pool, binSpacing, feePips })),
    perpsMarkets: markets.map((market, i) => ({ marketId: i + 1, symbol: market.symbol, pool: market.pool })),
  });
  const manifestPath = join(root, name);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, manifestPath };
};

const strictFixture = (root: string, comparisonOnly = false, indexer = 'https://ti.soramitsu.io/api/indexer') => {
  const markets = releaseMarkets();
  const contracts = releaseContracts(markets);
  const { manifest, manifestPath } = writeReleaseManifest(
    root,
    `${comparisonOnly ? 'paired-' : ''}${indexer.includes('indexer-r2') ? 'r2-' : ''}${indexer.endsWith('/') ? 'trailing-' : ''}release-manifest.json`,
    contracts,
    comparisonOnly ? markets.slice(0, 1) : markets,
    comparisonOnly ? markets.slice(0, 2) : markets,
    indexer,
  );
  const parsed = readCanonicalReleaseManifest(manifestPath, 'testnet');
  const routes: Routes = {
    '/api/indexer/v1/health': {
      body: {
        serviceId: `${new URL(indexer).host}${new URL(indexer).pathname.replace(/\/$/, '')}`,
        ecosystem: 'ton',
        chainId: 'ton:testnet',
        network: 'testnet',
        chain: {peersConfigured: 2, peersReady: 2, headSeqno: 123, headAgeSec: 1}, ledger: 'ready', disk: 'ok',
      },
    },
    '/api/indexer/v1/service-info': {
      body: {
        schemaVersion: 1,
        serviceId: `${new URL(indexer).host}${new URL(indexer).pathname.replace(/\/$/, '')}`,
        ecosystem: 'ton',
        chainId: 'ton:testnet',
        network: 'testnet',
        publicBaseUrl: indexer,
        readOnly: true,
        endpoints: { openapi: '/api/indexer/v1/openapi.json' },
        release: {
          releaseId,
          manifestHash: parsed.manifestHash,
        },
      },
    },
    '/api/indexer/v1/contracts': {
      body: {
        network: 'testnet',
        count: Object.keys(contracts).length,
        contracts: parsed.contracts,
        release: { releaseId, manifestHash: parsed.manifestHash },
      },
    },
    '/api/indexer/v1/openapi.json': { body: openApi() },
  };
  routes[`/api/indexer/v1/accounts/${parsed.contracts.T3Root}/balances`] = {body:balanceBody(parsed.contracts.T3Root!, 'testnet', parsed.runtime.tokens)};
  for (const [index, market] of parsed.spotMarkets.entries()) {
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
        token_root: market.tokenRoot, asset_symbol: market.assetSymbol, quote_symbol: market.quoteSymbol,
        asset_decimals: market.assetDecimals, quote_decimals: market.quoteDecimals,
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
    expectedReleaseManifestHash: parsed.manifestHash,
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
    options.requests?.push(`${request.method} ${url.pathname}`);
    if (request.method === 'OPTIONS' && url.pathname === `${options.mount ?? '/api/indexer'}/v1/runGetMethod`) {
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
      response.end(JSON.stringify({ error: 'not found', code: 'not_found' }));
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
    (testnet[`/api/indexer/v1/accounts/${address(1)}/balances`].body as any).network = 'testnet';
    await withServer(testnet, async (baseUrl) => {
      await runProductionSmoke(baseUrl, {
        expectedNetwork: 'testnet',
        allowUnboundRelease: true,
      });
    });

    const wrongBalances = basicRoutes();
    (wrongBalances[`/api/indexer/v1/accounts/${address(1)}/balances`].body as any).ton_raw = '1000000000';
    await assertSmokeRejects(wrongBalances, /deep-equal/);
    const wrongCompleteness = basicRoutes();
    (wrongCompleteness[`/api/indexer/v1/accounts/${address(1)}/balances`].body as any).complete = false;
    await assertSmokeRejects(wrongCompleteness, /strictly equal/);
    const wrongError = basicRoutes();
    wrongError['/api/indexer/v1/smoke-unknown-route'] = {status:404,body:{statusCode:404,error:'not found',code:'not_found'}};
    await assertSmokeRejects(wrongError, /deep-equal/);

    const paired = strictFixture(root, true);
    assert.equal(paired.manifest.perpsMarkets.length, 1);
    assert.equal(paired.manifest.spotMarkets.length, 2);
    await withServer(paired.routes, async baseUrl => runProductionSmoke(baseUrl, paired.options), {corsOrigins: [expectedCorsOrigin]});
    const emptyComparison = cloneRoutes(paired.routes), secondSpot = readCanonicalReleaseManifest(paired.manifestPath, 'testnet').spotMarkets[1],
      comparisonPath = `/api/indexer/v1/markets/${encodeURIComponent(secondSpot.marketKey)}/candles`;
    Object.assign(emptyComparison[comparisonPath].body as object, {candle_count: 0, candles: []});
    await withServer(emptyComparison, async baseUrl => runProductionSmoke(baseUrl, paired.options), {corsOrigins: [expectedCorsOrigin]});
    for (const [field, value] of [['history_complete', false], ['token_root', address(900)], ['asset_symbol', 'FALSE'], ['quote_symbol', 'USDC'], ['asset_decimals', 18], ['quote_decimals', 6]] as const) {
      const corrupted = cloneRoutes(emptyComparison);
      (corrupted[comparisonPath].body as Record<string, unknown>)[field] = value;
      await assertSmokeRejects(corrupted, /history_complete must be true|mismatch/, paired.options, {corsOrigins: [expectedCorsOrigin]});
    }
    // A release on a distinct public mount uses only that mount, including preflight
    // and encoded market queries. These route expectations do not call the URL helper.
    const r2 = strictFixture(root, false, 'https://test.tonswap.org/api/indexer-r2');
    const mountR2Routes = (source: Routes): Routes => {
      const routes = Object.fromEntries(Object.entries(cloneRoutes(source)).map(([path, route]) =>
        [path.replace('/api/indexer/', '/api/indexer-r2/'), route]));
      (routes['/api/indexer-r2/v1/service-info'].body as { endpoints: { openapi: string } }).endpoints.openapi =
        '/api/indexer-r2/v1/openapi.json';
      const spec = routes['/api/indexer-r2/v1/openapi.json'].body as { paths: Record<string, unknown> };
      spec.paths = Object.fromEntries(Object.entries(spec.paths).map(([path, operation]) =>
        [path.replace('/api/indexer/', '/api/indexer-r2/'), operation]));
      return routes;
    };
    const r2Routes = mountR2Routes(r2.routes);
    const requests: string[] = [];
    await withServer(r2Routes, async baseUrl => {
      await runProductionSmoke(baseUrl, r2.options);
      await runProductionSmoke(`${baseUrl}/api/indexer-r2`, r2.options);
      await runProductionSmoke(`${baseUrl}/api/indexer-r2/`, r2.options);
      const before = requests.length;
      await assert.rejects(() => runProductionSmoke(`${baseUrl}/api/indexer`, r2.options), /target path differs/);
      assert.equal(requests.length, before, 'A wrong mount must fail before any request');
      await assert.rejects(() => runProductionSmoke(baseUrl, { ...r2.options, expectedPublicBaseUrl: 'https://test.tonswap.org/api/indexer' }), /public URL differs/);
      assert.equal(requests.length, before, 'A conflicting advertised URL must fail before any request');
    }, { corsOrigins: [expectedCorsOrigin], mount: '/api/indexer-r2', requests });
    assert.ok(requests.includes('OPTIONS /api/indexer-r2/v1/runGetMethod'));
    assert.ok(requests.some(request => request.startsWith('GET /api/indexer-r2/v1/markets/')));
    assert.ok(requests.every(request => /^(GET|OPTIONS) \/api\/indexer-r2\/v1\//.test(request)));
    assert.equal(requests.some(request => request.includes('/api/indexer-r2/api/indexer')), false);
    await assertSmokeRejects(r2.routes, /HTTP 404|returned 404|failed.*404/i, r2.options, { corsOrigins: [expectedCorsOrigin] });
    const staleDiscovery = cloneRoutes(r2Routes);
    (staleDiscovery['/api/indexer-r2/v1/service-info'].body as { endpoints: { openapi: string } }).endpoints.openapi = '/api/indexer/v1/openapi.json';
    await assertSmokeRejects(staleDiscovery, /openapi endpoint/, r2.options, { corsOrigins: [expectedCorsOrigin], mount: '/api/indexer-r2' });
    const staleSpec = cloneRoutes(r2Routes);
    staleSpec['/api/indexer-r2/v1/openapi.json'].body = openApi();
    await assertSmokeRejects(staleSpec, /missing.*indexer-r2|indexer-r2.*missing/i, r2.options, { corsOrigins: [expectedCorsOrigin], mount: '/api/indexer-r2' });

    const trailing = strictFixture(root, false, 'https://test.tonswap.org/api/indexer-r2/');
    await withServer(mountR2Routes(trailing.routes), async baseUrl => {
      await runProductionSmoke(baseUrl, trailing.options);
      await runProductionSmoke(`${baseUrl}/api/indexer-r2/`, trailing.options);
      await assert.rejects(() => runProductionSmoke(baseUrl, {
        ...trailing.options, expectedPublicBaseUrl: 'https://test.tonswap.org/api/indexer-r2',
      }), /public URL differs/, 'Metadata must retain the exact native string even though route joining removes its trailing slash');
    }, { corsOrigins: [expectedCorsOrigin], mount: '/api/indexer-r2' });

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
        expectedReleaseManifestHash: strict.options.expectedReleaseManifestHash,
        expectedReleaseManifestPath: strict.options.expectedReleaseManifestPath,
        expectedCorsOrigin,
      }
    );
    await assertSmokeRejects(
      strict.routes,
      /TON_INDEXER_EXPECTED_RELEASE_MANIFEST_HASH must be an explicit/,
      { expectedNetwork: 'testnet', expectedReleaseId: releaseId }
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
    wrongServiceRelease.manifestHash = 'b'.repeat(64);
    await assertSmokeRejects(
      wrongServiceManifest,
      /service-info manifestHash must be/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const shortContracts = cloneRoutes(strict.routes);
    const shortContractBody = shortContracts['/api/indexer/v1/contracts'].body as {
      count: number;
      contracts: Record<string, string>;
    };
    delete shortContractBody.contracts.ControlMesh;
    shortContractBody.count -= 1;
    await assertSmokeRejects(
      shortContracts,
      /contracts payload count must match the supplied release manifest/,
      strict.options,
      { corsOrigins: [expectedCorsOrigin] }
    );

    const retiredManifestPath = join(root, 'retired-schema.json');
    const retired = { ...strict.manifest, schema: 'tonswap-first-release-manifest-v1' };
    writeFileSync(retiredManifestPath, JSON.stringify({ ...retired, manifestHash: hashReleaseManifest(retired) }));
    assert.throws(() => readCanonicalReleaseManifest(retiredManifestPath, 'testnet'), /schema must be tonswap-release-v1/);

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
    await assertSmokeRejects(
      shortHistory,
      /candle_count must match its array/,
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
    delete spec.paths['/api/indexer/v1/accounts/{addr}/balances'];
    await assertSmokeRejects(
      missingOpenApiPath,
      /OpenAPI is missing .*balances/
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
