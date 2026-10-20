import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeLocalnetManifestText } from '../../../src/scripts/fixtures/runtimeManifest.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, beginCell } from '@ton/core';
import { loadConfig } from '../src/config.js';
import { DexPrices, dexTwapRatio, loadDexReleaseManifest, parseDexReleaseManifest } from '../src/dexPrices.js';
import { ASSET, NOW, POOL, ROOT_CODE, T3, currentNativeDexManifest, dexConfig, dexFetcher, dexManifest, freshDexBody, oracleFixture, poolIdFixture, signDexManifest, type FixtureCall } from './dexFixtures.js';

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

describe('covered T3 TWAP arithmetic', () => {
  it('uses whole-token E9 prices directly without inversion or token precision scaling', () => {
    expect(dexTwapRatio(2_000_000_000n)).toEqual({ numerator: '2', denominator: '1', price: '2' });
    expect(dexTwapRatio(500_000_000n)).toEqual({ numerator: '1', denominator: '2', price: '0.5' });
    expect(dexTwapRatio(1_234_567_891n)).toEqual({ numerator: '1234567891', denominator: '1000000000', price: '1.234567891' });
  });
  it.each([0n, -1n, 999_999n, 1n << 120n])('rejects invalid oracle price %s', price => expect(() => dexTwapRatio(price)).toThrow());
});

describe('current covered DEX TWAP quote', () => {
  const replaceOracle = (body: any, calls: FixtureCall[], values: Record<string, bigint | number>) => {
    stack(body, calls, 'oracle_evidence')[0][1].bytes = oracleFixture(values);
  };
  it('uses only current getters at one pinned lite head and retains original oracle evidence', async () => {
    const fetcher = vi.fn(dexFetcher());
    const response = await new DexPrices(dexConfig({ indexerApiKey: 'test-key' }), fetcher, clock).prices('testnet', [ASSET]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${dexConfig().dexRelease!.indexerUrl}/readFresh`);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key', 'x-tonswap-release': dexConfig().dexRelease!.manifestHash });
    expect(init?.redirect).toBe('error');
    const calls = JSON.parse(String(init?.body)).calls;
    expect(calls).toHaveLength(5);
    expect(calls.filter((call: any) => call.kind === 'getter')).toEqual([
      { kind:'getter', address:POOL, method:'get_pool_info', stack:[] },
      { kind:'getter', address:POOL, method:'oracle_evidence', stack:[['num','0']] },
    ]);
    expect(response.quotes[0]).toMatchObject({ assetId:ASSET, price:'1', observedAt:'2026-10-09T06:59:59.000Z', status:'available', stale:false,
      evidence:{ method:'pool_twap_median_v1', precision:'indicative_display', source:'ton-indexer/lite',
        exactRatio:{numerator:'1',denominator:'1'}, oracle:{evidenceBoc:oracleFixture(),windowsSeconds:[300,1800,7200],medianPriceE9:'1000000000'},
        pool:{ idBoc:poolIdFixture(),ready:true,flags:1,activeBin:0 }, head:{utime:Math.floor(NOW.getTime()/1000)-1} } });
    for (const retired of ['q64','lastMarketObservationAt','executableDepthT3Raw','executableDepthAssetRaw','perpsOracleSafetyAvailable'])
      expect(response.quotes[0]!.evidence).not.toHaveProperty(retired);
  });
  it('uses the median of covered windows, never the current spot or an assumed USD peg', async () => {
    const response = await mutate((body,calls) => replaceOracle(body,calls,{spot:9_000_000_000n,short:3_000_000_000n,medium:1_000_000_000n,long:2_000_000_000n}));
    expect(response.quotes[0]).toMatchObject({price:'2',evidence:{exactRatio:{numerator:'2',denominator:'1'},oracle:{medianPriceE9:'2000000000'}}});
    expect(JSON.stringify(response)).not.toContain('USD"');
  });
  it('does not fabricate native, T3 identity or symbol-based prices', async () => {
    const fetcher = vi.fn(dexFetcher()), dex = new DexPrices(dexConfig(),fetcher,clock);
    const response = await dex.prices('testnet',['native',T3,'tether']); expect(fetcher).not.toHaveBeenCalled();
    expect(response.quotes.every(quote=>quote.price===null&&quote.status==='unavailable')).toBe(true);
    expect(dex.catalogue('testnet')).toMatchObject([{assetId:T3,priceConfigured:false},{assetId:ASSET,priceConfigured:true}]);
    expect(dex.catalogue('mainnet')).toEqual([]);
  });
  it('does not fetch without current release and network configuration', async () => {
    const fetcher=vi.fn(dexFetcher());
    for(const config of [dexConfig({dexRelease:undefined}),dexConfig({indexerUrls:{}})]) {
      const dex=new DexPrices(config,fetcher,clock); expect(dex.configured('testnet')).toBe(false);
      expect((await dex.prices('testnet',[ASSET])).quotes[0]!.issues).toEqual(['dex_release_not_configured']);
    }
    expect((await new DexPrices(dexConfig(),fetcher,clock).prices('mainnet',[ASSET])).quoteAssetId).toBe(null);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['wrong network',(b:any)=>{b.network='mainnet';},'dex_release_mismatch'],
    ['wrong release',(b:any)=>{b.release.releaseId='old';},'dex_release_mismatch'],
    ['wrong hash',(b:any)=>{b.release.manifestHash='f'.repeat(64);},'dex_release_mismatch'],
    ['wrong result address',(b:any)=>{b.results[2].address=ASSET;},'dex_result_identity_mismatch'],
    ['missing result',(b:any)=>{b.results.pop();},'dex_result_identity_mismatch'],
    ['frozen root',(b:any)=>{b.results[1].account_state='frozen';},'dex_account_inactive'],
    ['wrong root code',(b:any)=>{b.results[0].code_boc=beginCell().storeUint(4,8).endCell().toBoc().toString('base64');},'dex_code_hash_mismatch'],
    ['wrong pool code',(b:any)=>{b.results[2].code_boc=ROOT_CODE.toBoc().toString('base64');},'dex_code_hash_mismatch'],
    ['retired http source',(b:any)=>{b.readContext.source='http4';},'dex_invalid_read_context'],
    ['bad block hash',(b:any)=>{b.readContext.head.rootHashHex='invalid';},'dex_invalid_read_context'],
    ['old query',(b:any)=>{b.readContext.queriedAt-=31000;},'dex_stale_state'],
    ['future query',(b:any)=>{b.readContext.queriedAt+=6000;},'dex_future_timestamp'],
    ['old head',(b:any)=>{b.readContext.head.utime-=31;},'dex_stale_state'],
    ['future head',(b:any)=>{b.readContext.head.utime+=7;},'dex_future_timestamp'],
  ])('fails closed for %s',async(_label,change,issue)=>{
    const response=await mutate(change); expect(response.quotes[0]).toMatchObject({price:null,status:'unavailable',issues:[issue],stale:issue==='dex_stale_state'});
  });
  it.each([
    ['wrong X root',{xMaster:T3}],['wrong fee',{feePips:1000}],['wrong spacing',{binSpacing:2}],['wrong precision',{xDecimals:6}],
    ['wrong wallet gas',{walletGasX:30001}],['wrong wallet attachment',{walletGramX:'1'}],
    ['wrong wallet budget',{walletBudgetX:{...dexManifest().spotMarkets[0].walletBudgetX,creditProtection:true}}],
  ])('rejects current PoolId %s',async(_label,values)=>{
    const response=await mutate((b,c)=>{stack(b,c,'get_pool_info')[0][1].bytes=poolIdFixture(values);});
    expect(response.quotes[0]!.issues).toEqual(['dex_pool_binding_mismatch']);
  });
  it.each([1,2,3,4])('rejects wrong immutable pool peer %s',async index=>{
    const response=await mutate((b,c)=>{stack(b,c,'get_pool_info')[index]=['slice',{bytes:beginCell().storeAddress(Address.parse(POOL)).endCell().toBoc().toString('base64')}];});
    expect(response.quotes[0]!.issues).toEqual(['dex_pool_binding_mismatch']);
  });
  it.each([
    ['paused',5,'3','dex_pool_unavailable'],['unknown flags',5,'5','dex_pool_unavailable'],['not ready',6,'0','dex_pool_unavailable'],
    ['invalid TVM bool',6,'1','dex_integer_out_of_range'],['active bin overflow',7,'2147483648','dex_integer_out_of_range'],
    ['negative reserve',8,'-1','dex_integer_out_of_range'],['reserve overflow',9,(1n<<120n).toString(),'dex_integer_out_of_range'],
  ])('rejects pool %s',async(_label,index,value,issue)=>{
    const response=await mutate((b,c)=>{stack(b,c,'get_pool_info')[Number(index)][1]=value;});expect(response.quotes[0]!.issues).toEqual([issue]);
  });
  it.each([
    ['missing short',{flags:13,short:0n}],['missing medium',{flags:11,medium:0n}],['missing long',{flags:7,long:0n}],
    ['unhealthy active bin',{flags:14,spot:0n}],['historical',{flags:30,spot:0n}],['unknown flags',{flags:47}],
    ['invalid price',{short:999999n}],['price overflow',{long:1n<<120n}],['wrong current at',{at:1n}],
  ])('rejects %s oracle evidence',async(_label,values)=>{
    const response=await mutate((b,c)=>replaceOracle(b,c,values)); expect(response.quotes[0]!.issues).toEqual(['dex_twap_unavailable']);
  });
  it('binds oracle served time to the exact head',async()=>{
    const response=await mutate((b,c)=>replaceOracle(b,c,{servedAt:1n,at:1n}));expect(response.quotes[0]!.issues).toEqual(['dex_oracle_head_mismatch']);
  });
  it('rejects malformed current getter shapes and cells',async()=>{
    for(const change of [
      (b:any,c:FixtureCall[])=>{stack(b,c,'get_pool_info').pop();},
      (b:any,c:FixtureCall[])=>{stack(b,c,'oracle_evidence').push(['num','1']);},
      (b:any,c:FixtureCall[])=>{stack(b,c,'oracle_evidence')[0][1].bytes=beginCell().endCell().toBoc().toString('base64');},
    ]) expect((await mutate(change)).quotes[0]!.status).toBe('unavailable');
  });
  it('never returns a previous quote as current when the next read fails',async()=>{
    let succeeds=true;const fetcher=vi.fn(async(_url,init)=>succeeds?new Response(JSON.stringify(freshDexBody(JSON.parse(String(init?.body)).calls))):new Response('unavailable',{status:503}));
    const dex=new DexPrices(dexConfig(),fetcher,clock); expect((await dex.prices('testnet',[ASSET])).quotes[0]!.price).toBe('1');
    succeeds=false;expect((await dex.prices('testnet',[ASSET])).quotes[0]).toMatchObject({price:null,status:'unavailable',issues:['dex_source_unavailable']});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
