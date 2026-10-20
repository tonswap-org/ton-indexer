import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeLocalnetManifestText } from '../../../src/scripts/fixtures/runtimeManifest.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, beginCell } from '@ton/core';
import { Decimal } from '../src/decimal.js';
import { loadConfig } from '../src/config.js';
import { DexPrices, dexQ64Ratio, loadDexReleaseManifest, parseDexReleaseManifest } from '../src/dexPrices.js';
import { ASSET, NOW, POOL, ROOT_CODE, T3, currentNativeDexManifest, dexConfig, dexFetcher, dexManifest, freshDexBody, signDexManifest, type FixtureCall } from './dexFixtures.js';

const clock = () => new Date(NOW);
const stack = (body: Record<string, any>, calls: FixtureCall[], method: string) => body.results[calls.findIndex(call => call.method === method)].stack;
const mutate = (change: (body: Record<string, any>, calls: FixtureCall[]) => void) => new DexPrices(dexConfig(), dexFetcher(change), clock).prices('testnet', [ASSET]);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

describe('release-bound DEX configuration', () => {
  it('binds canonical roots, explicit decimals, pool code and release identity', () => {
    const binding = parseDexReleaseManifest(dexManifest());
    expect(binding).toMatchObject({ network: 'testnet', quoteAssetId: T3, quoteRoot: T3, quoteDecimals: 9,
      indexerUrl: 'https://indexer.example.test/api/indexer/v1', markets: [{ assetId: ASSET, marketKey: 'spot:USDT-T3', address: POOL }] });
  });
  it('loads the complete native schema through startup configuration with synthetic testnet services', () => {
    // Exact producer bytes remain localnet sandbox evidence, not a deployed r4 claim.
    expect(createHash('sha256').update(nativeLocalnetManifestText).digest('hex')).toBe('d6d327121711c74450cf70bcafddbb5769503f2707adcd4ccc6904ddcd141fea');
    const original = JSON.parse(nativeLocalnetManifestText);
    expect(signDexManifest(original).manifestHash).toBe(original.manifestHash);
    const manifest = currentNativeDexManifest();
    for (const field of ['contracts', 'templates', 'tokens', 'vendor', 'campaign', 'supplyBase', 'orderKeeper', 'spotMarkets', 'perpsMarkets', 'options']) {
      expect(manifest[field]).toEqual(original[field]);
    }
    const directory = mkdtempSync(join(tmpdir(), 'tonswap-current-manifest-test-')); directories.push(directory);
    const path = join(directory, 'release-manifest.json'); writeFileSync(path, JSON.stringify(manifest));
    const configuration = loadConfig({ DATABASE_URL: 'postgres://test/unused', DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      APP_ORIGIN: 'https://app.example.test', PLATFORM_URL: manifest.services.platform,
      INDEXER_URL_TESTNET: `${manifest.services.indexer}/v1`, INDEXER_RELEASE_MANIFEST: path });
    expect(configuration.dexRelease).toMatchObject({ manifestHash: manifest.manifestHash,
      quoteRoot: manifest.contracts.T3Hub.address, quoteCodeHash: manifest.contracts.T3Hub.codeHash });
    expect(configuration.dexRelease!.tokens.map(token => token.codeHash)).toEqual(manifest.tokens.map((token: any) => token.masterCodeHash));
    expect(configuration.dexRelease!.markets.map(market => market.codeHash)).toEqual(manifest.spotMarkets.map(() => manifest.templates.DlmmPool));
    expect(() => parseDexReleaseManifest(original)).toThrow();
  });
  it.each([
    ['obsolete T3Root role', (m: any) => { m.contracts.T3Root = m.contracts.T3Hub; delete m.contracts.T3Hub; }],
    ['obsolete global wallet template', (m: any) => { m.templates.JettonWallet = m.templates.JettonV21Wallet; }],
    ['missing token master pin', (m: any) => { delete m.tokens[0].masterCodeHash; }],
    ['missing token wallet pin', (m: any) => { delete m.tokens[0].walletCodeHash; }],
    ['mismatched token master pin', (m: any) => { m.tokens[0].masterCodeHash = 'f'.repeat(64); }],
    ['mismatched T3 wallet pin', (m: any) => { m.tokens.find((t: any) => t.symbol === 'T3').walletCodeHash = 'f'.repeat(64); }],
    ['mismatched TS wallet pin', (m: any) => { m.tokens.find((t: any) => t.symbol === 'TS').walletCodeHash = 'f'.repeat(64); }],
    ['mismatched TS master template', (m: any) => { m.templates.JettonV21Minter = 'f'.repeat(64); }],
    ['missing vendor', (m: any) => { delete m.vendor; }],
    ['unbound vendor asset path', (m: any) => { m.vendor.stablecoin.wallet.sha256 = 'f'.repeat(64); }],
    ['unknown vendor field', (m: any) => { m.vendor.stablecoin.wallet.unreviewed = true; }],
    ['missing campaign', (m: any) => { delete m.campaign; }],
    ['zero campaign total', (m: any) => { m.campaign.total = '0'; }],
    ['campaign id overflow', (m: any) => { m.campaign.id = (1n << 256n).toString(); }],
    ['missing supplyBase', (m: any) => { delete m.supplyBase; }],
    ['excess supplyBase', (m: any) => { m.supplyBase = (BigInt(m.campaign.total) + 1n).toString(); }],
    ['missing keeper', (m: any) => { delete m.orderKeeper; }],
    ['null keeper', (m: any) => { m.orderKeeper = null; }],
    ['obsolete keeper tuning', (m: any) => { m.orderKeeper.maxSteps = 1; }],
    ['keeper aliases a contract', (m: any) => { m.orderKeeper.address = m.contracts.T3Hub.address; }],
    ['keeper aliases a pool', (m: any) => { m.orderKeeper.address = m.spotMarkets[0].pool; }],
    ['missing wallet profile', (m: any) => { delete m.spotMarkets[0].walletBudgetX; }],
    ['incorrect market precision', (m: any) => { m.spotMarkets[0].xDecimals = 18; }],
    ['inconsistent sender budget', (m: any) => { m.spotMarkets[0].walletBudgetX.senderGas = m.spotMarkets[0].walletGasX + 1; }],
    ['unbounded wallet rent', (m: any) => { m.spotMarkets[0].walletBudgetX.rentSeconds = 2 ** 32; }],
    ['excess wallet attachment', (m: any) => { m.spotMarkets[0].walletGramX = '500000001'; }],
    ['unbound perps pool', (m: any) => { m.perpsMarkets[0].pool = m.orderKeeper.address; }],
    ['invalid option comparison', (m: any) => { m.options[0].kind = 'outperformance'; m.options[0].comparisonSymbol = m.options[0].symbol; }],
    ['partial listed option', (m: any) => { m.options[0].seriesId = '1'; delete m.options[0].option; }],
    ['obsolete indexer mount', (m: any) => { m.services.indexer += '-r2'; }],
  ])('rejects current-schema %s even with a recomputed hash', (_label, change) => {
    const manifest = currentNativeDexManifest(); change(manifest);
    expect(() => parseDexReleaseManifest(signDexManifest(manifest))).toThrow();
  });
  it('rejects a manifest whose contents changed after its hash was computed', () => {
    const manifest = dexManifest(); manifest.tokens[1].decimals = 6;
    expect(() => parseDexReleaseManifest(manifest)).toThrow('manifestHash');
  });
  it.each([
    ['wrong network identity', (m: any) => { m.globalId = -239; }],
    ['wrong release identity', (m: any) => { m.releaseId = 'testnet-r2-ffffffffffff'; }],
    ['duplicate token symbol', (m: any) => { m.tokens[1].symbol = 'T3'; }],
    ['duplicate token root', (m: any) => { m.tokens[1].root = T3; }],
    ['unbound root', (m: any) => { delete m.contracts.USDT; }],
    ['wrong T3 role', (m: any) => { m.contracts.T3Hub.address = `0:${'4'.repeat(64)}`; }],
    ['missing pool template', (m: any) => { delete m.templates.DlmmPool; }],
    ['self-market', (m: any) => { m.spotMarkets[0].symbol = 'T3'; }],
    ['pool address aliases token root', (m: any) => { m.spotMarkets[0].pool = ASSET; }],
    ['wrong or missing market asset', (m: any) => { m.spotMarkets[0].symbol = 'NOT_RELEASED'; }],
    ['insecure endpoint', (m: any) => { m.services.indexer = 'http://indexer.example.test'; }],
    ['credential-bearing endpoint', (m: any) => { m.services.indexer = 'https://secret@indexer.example.test'; }],
  ])('rejects %s even with a recomputed hash', (_label, change) => {
    const manifest = dexManifest(); change(manifest);
    expect(() => parseDexReleaseManifest(signDexManifest(manifest))).toThrow();
  });
  it('loads an explicit manifest and refuses a different configured release endpoint or network', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tonswap-dex-test-')); directories.push(directory);
    const path = join(directory, 'release-manifest.json'); writeFileSync(path, JSON.stringify(dexManifest()));
    const environment = { DATABASE_URL: 'postgres://test/unused', DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      APP_ORIGIN: 'https://app.example.test', PLATFORM_URL: 'https://app.example.test/platform',
      INDEXER_URL_TESTNET: dexConfig().dexRelease!.indexerUrl, INDEXER_RELEASE_MANIFEST: path };
    expect(loadConfig(environment).dexRelease).toEqual(parseDexReleaseManifest(dexManifest()));
    expect(() => loadConfig({ ...environment, INDEXER_URL_TESTNET: 'https://other.example.test/v1' })).toThrow('must match');
    expect(() => loadConfig({ ...environment, NETWORKS: 'mainnet' })).toThrow('must match');
    writeFileSync(path, JSON.stringify(dexManifest()).replace('"schema":', '"schema":"tonswap-release-v1","schema":'));
    expect(() => loadDexReleaseManifest(path)).toThrow('duplicate JSON keys');
  });
});

describe('T3 quote arithmetic', () => {
  it('inverts the pool price in both directions and scales atomic quantities before dividing', () => {
    expect(dexQ64Ratio(2n << 64n, 9, 9)).toEqual({ numerator: '1', denominator: '2', price: '0.5' });
    expect(dexQ64Ratio(1n << 63n, 9, 9)).toEqual({ numerator: '2', denominator: '1', price: '2' });
    expect(dexQ64Ratio(2n << 64n, 6, 9)).toEqual({ numerator: '1', denominator: '2000', price: '0.0005' });
    expect(dexQ64Ratio(2n << 64n, 9, 6)).toEqual({ numerator: '500', denominator: '1', price: '500' });
  });
  it('retains exact rational evidence when a decimal cannot terminate', () => {
    const ratio = dexQ64Ratio(3n << 64n, 9, 9);
    expect(ratio.numerator).toBe('1'); expect(ratio.denominator).toBe('3');
    expect(ratio.price).toBe(`0.${'3'.repeat(80)}`);
    expect(new Decimal(ratio.price).eq(new Decimal(ratio.numerator).div(ratio.denominator))).toBe(true);
  });
  it.each([0n, -1n, 1n << 128n])('rejects invalid Q64 %s', q64 => expect(() => dexQ64Ratio(q64, 9, 9)).toThrow());
});

describe('current DEX pool quote', () => {
  it('uses one pinned readFresh batch and distinguishes fresh state from old market activity', async () => {
    const fetcher = vi.fn(dexFetcher());
    const prices = new DexPrices(dexConfig({ indexerApiKey: 'test-key' }), fetcher, clock);
    const response = await prices.prices('testnet', [ASSET]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${dexConfig().dexRelease!.indexerUrl}/readFresh`);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body)).calls).toHaveLength(8);
    expect(response).toMatchObject({ network: 'testnet', currency: 'T3', quoteAssetId: T3,
      release: { manifestHash: dexConfig().dexRelease!.manifestHash }, quotes: [{ assetId: ASSET, price: '1',
        observedAt: '2026-10-09T06:59:59.000Z', source: 'tonswap-dex', status: 'available', stale: false, change24h: null,
        evidence: { currency: 'T3', method: 'active_pool_q64', precision: 'indicative_display', source: 'ton-indexer/http4',
          exactRatio: { numerator: '1', denominator: '1' }, lastMarketObservationAt: '2026-10-07T06:59:59.000Z',
          executableDepthT3Raw: '10000000000000', executableDepthAssetRaw: '10000000000000' }, issues: [] }] });
    expect(response.quotes[0]!.evidence.observedAt).toBe(response.quotes[0]!.observedAt);
  });
  it('prices a nonunit live quote without treating a stablecoin symbol as a USD peg', async () => {
    const response = await mutate((body, calls) => { stack(body, calls, 'active_price_q64')[1][1] = String(2n << 64n); });
    expect(response.quotes[0]).toMatchObject({ price: '0.5', evidence: { exactRatio: { numerator: '1', denominator: '2' } } });
    expect(JSON.stringify(response)).not.toContain('USD"');
  });
  it('does not fabricate native, T3 identity or symbol-based prices and never contacts another provider', async () => {
    const fetcher = vi.fn(dexFetcher());
    const dex = new DexPrices(dexConfig(), fetcher, clock);
    const response = await dex.prices('testnet', ['native', T3, 'tether']);
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.quotes.every(quote => quote.price === null && quote.status === 'unavailable')).toBe(true);
    expect(dex.catalogue('testnet')).toMatchObject([{ assetId: T3, priceConfigured: false }, { assetId: ASSET, priceConfigured: true }]);
    expect(dex.catalogue('mainnet')).toEqual([]);
  });
  it('does not fetch when release configuration or network binding is absent', async () => {
    const fetcher = vi.fn(dexFetcher());
    for (const configuration of [dexConfig({ dexRelease: undefined }), dexConfig({ indexerUrls: {} })]) {
      const dex = new DexPrices(configuration, fetcher, clock);
      expect(dex.configured('testnet')).toBe(false);
      expect((await dex.prices('testnet', [ASSET])).quotes[0]!.issues).toEqual(['dex_release_not_configured']);
    }
    expect((await new DexPrices(dexConfig(), fetcher, clock).prices('mainnet', [ASSET])).quoteAssetId).toBe(null);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['wrong network', (b: any) => { b.network = 'mainnet'; }, 'dex_release_mismatch'],
    ['wrong release', (b: any) => { b.release.releaseId = 'old-release'; }, 'dex_release_mismatch'],
    ['wrong manifest hash', (b: any) => { b.release.manifestHash = 'f'.repeat(64); }, 'dex_release_mismatch'],
    ['missing release', (b: any) => { delete b.release; }, 'dex_release_mismatch'],
    ['wrong result address', (b: any) => { b.results[2].address = ASSET; }, 'dex_result_identity_mismatch'],
    ['missing result', (b: any) => { b.results.pop(); }, 'dex_result_identity_mismatch'],
    ['inactive token', (b: any) => { b.results[1].account_state = 'frozen'; }, 'dex_account_inactive'],
    ['changed quote-root code', (b: any) => { b.results[0].code_boc = beginCell().storeUint(4, 8).endCell().toBoc().toString('base64'); }, 'dex_code_hash_mismatch'],
    ['changed pool code', (b: any) => { b.results[2].code_boc = ROOT_CODE.toBoc().toString('base64'); }, 'dex_code_hash_mismatch'],
    ['provider origin changed', (b: any) => { b.readContext.source = 'cache'; }, 'dex_invalid_read_context'],
    ['invalid head', (b: any) => { b.readContext.head.rootHashHex = 'invalid'; }, 'dex_invalid_read_context'],
    ['old query', (b: any) => { b.readContext.queriedAt -= 121_000; }, 'dex_stale_state'],
    ['future query', (b: any) => { b.readContext.queriedAt += 6_000; }, 'dex_future_timestamp'],
  ])('fails closed for %s', async (_label, change, issue) => {
    const response = await mutate(change);
    expect(response.quotes[0]).toMatchObject({ price: null, observedAt: null, status: 'unavailable', issues: [issue], stale: issue === 'dex_stale_state' });
  });
  it.each([
    ['wrong token binding', 'pool_state', (s: any) => { s[1] = ['slice', { bytes: beginCell().storeAddress(Address.parse(T3)).endCell().toBoc().toString('base64') }]; }, 'dex_pool_binding_mismatch'],
    ['wrong fee', 'pool_state', (s: any) => { s[6][1] = '1000'; }, 'dex_pool_binding_mismatch'],
    ['changed active bin', 'active_price_q64', (s: any) => { s[0][1] = '1'; }, 'dex_active_bin_mismatch'],
    ['zero Q64', 'active_price_q64', (s: any) => { s[1][1] = '0'; }, 'dex_invalid_price'],
    ['inexact number encoding', 'active_price_q64', (s: any) => { s[1][1] = '1e18'; }, 'dex_invalid_integer'],
    ['unsafe numeric tuple', 'active_price_q64', (s: any) => { s[1][1] = 18446744073709551616; }, 'dex_invalid_stack'],
    ['unhealthy depth', 'oracle_depth_health', (s: any) => { s[0][1] = '0'; }, 'dex_insufficient_executable_liquidity'],
    ['zero executable asset depth', 'oracle_depth_health', (s: any) => { s[3][1] = '0'; }, 'dex_insufficient_executable_liquidity'],
    ['zero executable T3 depth', 'oracle_depth_health', (s: any) => { s[2][1] = '0'; }, 'dex_insufficient_executable_liquidity'],
    ['old chain state', 'perps_oracle_snapshot', (s: any) => { s[1][1] = String(NOW.getTime() / 1000 - 121); }, 'dex_stale_state'],
    ['future chain state', 'perps_oracle_snapshot', (s: any) => { s[1][1] = String(NOW.getTime() / 1000 + 6); }, 'dex_future_timestamp'],
    ['invalid TVM safety flag', 'perps_oracle_snapshot', (s: any) => { s[0][1] = '1'; }, 'dex_integer_out_of_range'],
    ['mismatched activity time', 'perps_oracle_snapshot', (s: any) => { s[2][1] = String(NOW.getTime() / 1000); }, 'dex_activity_timestamp_mismatch'],
  ])('rejects %s', async (_label, method, change, issue) => {
    const response = await mutate((body, calls) => change(stack(body, calls, method)));
    expect(response.quotes[0]).toMatchObject({ price: null, status: 'unavailable', issues: [issue], stale: issue === 'dex_stale_state' });
  });
  it('rejects a failed getter and a successful getter with a different shape', async () => {
    const failed = await mutate(body => { body.results[4].exit_code = 9; });
    expect(failed.quotes[0]!.issues).toEqual(['dex_getter_failed']);
    const transposed = await mutate(body => { [body.results[4], body.results[5]] = [body.results[5], body.results[4]]; });
    expect(transposed.quotes[0]!.issues).toEqual(['dex_getter_failed']);
  });
  it('never returns a previous quote as current when a subsequent read fails', async () => {
    let succeeds = true;
    const fetcher = vi.fn(async (_url, init) => succeeds ? new Response(JSON.stringify(freshDexBody(JSON.parse(String(init?.body)).calls))) : new Response('unavailable', { status: 503 }));
    const dex = new DexPrices(dexConfig(), fetcher, clock);
    expect((await dex.prices('testnet', [ASSET])).quotes[0]!.price).toBe('1');
    succeeds = false;
    expect((await dex.prices('testnet', [ASSET])).quotes[0]).toMatchObject({ price: null, status: 'unavailable', issues: ['dex_source_unavailable'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
