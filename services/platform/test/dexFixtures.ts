import { createHash } from 'node:crypto';
import { Address, beginCell } from '@ton/core';
import type { Config } from '../src/config.js';
import type { Fetcher } from '../src/http.js';
import { parseDexReleaseManifest } from '../src/dexPrices.js';
import { config } from './helpers.js';
import { nativeLocalnetManifestText } from '../../../src/scripts/fixtures/runtimeManifest.js';

export const NOW = new Date('2026-10-09T07:00:00.000Z');
export const T3 = `0:${'1'.repeat(64)}`;
export const ASSET = `0:${'2'.repeat(64)}`;
export const POOL = `0:${'3'.repeat(64)}`;
export const ROOT_CODE = beginCell().storeUint(1, 8).endCell();
export const POOL_CODE = beginCell().storeUint(2, 8).endCell();
const stableJson = (value: any): string => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]` :
  value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}` : JSON.stringify(value);
export function signDexManifest(manifest: Record<string, any>): Record<string, any> {
  const { manifestHash: _omit, ...contents } = manifest;
  return { ...contents, manifestHash: createHash('sha256').update(stableJson(contents)).digest('hex') };
}
/** Preserve the native producer's complete schema; network/URLs are synthetic startup inputs. */
export function currentNativeDexManifest(): Record<string, any> {
  const manifest = JSON.parse(nativeLocalnetManifestText);
  return signDexManifest({ ...manifest, network: 'ton:testnet', releaseId: `testnet-schema-${manifest.source.build.slice(0, 12)}`,
    services: { indexer: 'https://indexer.example.test/api/indexer', tonRpc: 'https://rpc.example.test', platform: 'https://platform.example.test' } });
}
/** Synthetic two-token DEX responses, retaining all current native manifest fields. */
export function dexManifest(): Record<string, any> {
  const manifest = currentNativeDexManifest();
  const spot = manifest.spotMarkets.find((market: any) => market.symbol === 'USDT');
  return signDexManifest({ ...manifest,
    contracts: { ...manifest.contracts, T3Hub: { address: T3, codeHash: ROOT_CODE.hash().toString('hex') },
      USDT: { address: ASSET, codeHash: ROOT_CODE.hash().toString('hex') } },
    templates: { ...manifest.templates, DlmmPool: POOL_CODE.hash().toString('hex') },
    tokens: [{ symbol: 'T3', root: T3, decimals: 9, masterCodeHash: ROOT_CODE.hash().toString('hex'), walletCodeHash: manifest.templates.T3Wallet },
      { symbol: 'USDT', root: ASSET, decimals: 9, masterCodeHash: ROOT_CODE.hash().toString('hex'),
        walletCodeHash: manifest.tokens.find((token: any) => token.symbol === 'USDT').walletCodeHash }],
    spotMarkets: [{ ...spot, symbol: 'USDT', pool: POOL, xDecimals: 9, binSpacing: 1, feePips: 3000 }], perpsMarkets: [], options: [],
  });
}
export function dexConfig(overrides: Partial<Config> = {}): Config {
  const release = parseDexReleaseManifest(dexManifest());
  return config({ dexRelease: release, indexerUrls: { testnet: release.indexerUrl }, ...overrides });
}
const num = (value: string | number | bigint) => ['num', String(value)];
const addr = (value: string) => ['slice', { bytes: beginCell().storeAddress(Address.parse(value)).endCell().toBoc().toString('base64') }];
export interface FixtureCall { kind: string; address: string; method?: string; stack?: unknown[] }
export function oracleFixture(overrides: Record<string, number | bigint> = {}): string {
  const t = BigInt(Math.floor(NOW.getTime() / 1000) - 1);
  const v = { servedAt: t, at: t, flags: 15, spot: 1_000_000_000n, short: 1_000_000_000n, medium: 1_000_000_000n, long: 1_000_000_000n, ...overrides };
  return beginCell().storeUint(v.servedAt!,64).storeUint(v.at!,64).storeUint(v.flags!,8).storeUint(v.spot!,128)
    .storeUint(v.short!,128).storeUint(v.medium!,128).storeUint(v.long!,128).endCell().toBoc().toString('base64');
}
export function poolIdFixture(overrides: Record<string, any> = {}): string {
  const market = dexManifest().spotMarkets[0], v = { ...market, xMaster: ASSET, ...overrides }, budget = beginCell();
  for (const [key,width] of [['senderGas',32],['walletBounceGas',32],['burnWalletGas',32],['smallPayloadCells',16],['largeWalletGas',32],['largeSenderGas',32],['rentSeconds',32],['rentBits',32],['rentCells',16],['initBits',32],['initCells',16],['initCopies',8],['transferBits',16],['transferCells',8],['transferCopies',8]] as const) budget.storeUint(v.walletBudgetX[key],width);
  budget.storeBit(v.walletBudgetX.creditProtection);
  return beginCell().storeAddress(Address.parse(v.xMaster)).storeUint(v.binSpacing,16).storeUint(v.feePips,32).storeUint(v.xDecimals,8)
    .storeUint(v.walletGasX,32).storeCoins(BigInt(v.walletGramX)).storeRef(budget.endCell()).endCell().toBoc().toString('base64');
}
export function freshDexBody(calls: FixtureCall[], now = NOW): Record<string, any> {
  const chainTime = Math.floor(now.getTime() / 1000) - 1, release = dexConfig().dexRelease!;
  return { network: 'testnet', release: { releaseId: release.releaseId, manifestHash: release.manifestHash },
    readContext: { source: 'lite', queriedAt: now.getTime(),
      head: { workchain: -1, shard: '-9223372036854775808', seqno: 90_000_000, rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64), utime: chainTime } },
    results: calls.map(call => {
      if (call.kind === 'account') return { kind: 'account', address: call.address, account_state: 'active', balance_raw: '1',
        code_boc: (call.address === POOL ? POOL_CODE : ROOT_CODE).toBoc().toString('base64'),
        data_boc: beginCell().endCell().toBoc().toString('base64') };
      const stack = {
        get_pool_info: [['cell',{bytes:poolIdFixture()}], addr(release.factory), addr(release.feeSink), addr(release.treasury), addr(T3),
          num(1),num(-1),num(0),num(10n ** 13n),num(10n ** 13n),num(0),num(1),num(1),num(0)],
        oracle_evidence: [['cell',{bytes:oracleFixture({ servedAt:chainTime, at:chainTime })}]],
      }[call.method!];
      return { kind: 'getter', address: call.address, exit_code: stack ? 0 : 11, stack: stack ?? [], gas_used: null };
    }) };
}
export function dexFetcher(transform: (body: Record<string, any>, calls: FixtureCall[]) => void = () => {}): Fetcher {
  return async (_url, init) => {
    const calls: FixtureCall[] = JSON.parse(String(init?.body)).calls;
    const body = freshDexBody(calls); transform(body, calls);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
