import { createHash } from 'node:crypto';
import { Address, beginCell } from '@ton/core';
import type { Config } from '../src/config.js';
import type { Fetcher } from '../src/http.js';
import { parseDexReleaseManifest } from '../src/dexPrices.js';
import { config } from './helpers.js';

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
export function dexManifest(): Record<string, any> {
  return signDexManifest({ schema: 'tonswap-release-v1', network: 'ton:testnet', globalId: -3,
    releaseId: 'testnet-r2-0123456789ab', createdAt: '2026-10-07T08:26:48.000Z',
    source: { contracts: 'c'.repeat(40), build: `0123456789ab${'a'.repeat(52)}` },
    services: { indexer: 'https://indexer.example.test/api/indexer-r2', tonRpc: 'https://rpc.example.test', platform: 'https://platform.example.test' },
    contracts: { T3Root: { address: T3, codeHash: ROOT_CODE.hash().toString('hex') }, USDT: { address: ASSET, codeHash: ROOT_CODE.hash().toString('hex') } },
    templates: { DlmmPool: POOL_CODE.hash().toString('hex') },
    tokens: [{ symbol: 'T3', root: T3, decimals: 9 }, { symbol: 'USDT', root: ASSET, decimals: 9 }],
    spotMarkets: [{ symbol: 'USDT', pool: POOL, binSpacing: 1, feePips: 3000 }], perpsMarkets: [], options: [],
  });
}
export function dexConfig(overrides: Partial<Config> = {}): Config {
  const release = parseDexReleaseManifest(dexManifest());
  return config({ dexRelease: release, indexerUrls: { testnet: release.indexerUrl }, ...overrides });
}
const num = (value: string | number | bigint) => ['num', String(value)];
const addr = (value: string) => ['slice', { bytes: beginCell().storeAddress(Address.parse(value)).endCell().toBoc().toString('base64') }];
export interface FixtureCall { kind: string; address: string; method?: string }
export function freshDexBody(calls: FixtureCall[], now = NOW): Record<string, any> {
  const chainTime = Math.floor(now.getTime() / 1000) - 1;
  const activityTime = chainTime - 172800;
  return { network: 'testnet', release: { releaseId: dexConfig().dexRelease!.releaseId, manifestHash: dexConfig().dexRelease!.manifestHash },
    readContext: { source: 'http4', queriedAt: now.getTime(),
      head: { workchain: -1, shard: '-9223372036854775808', seqno: 90_000_000, rootHashHex: 'a'.repeat(64), fileHashHex: 'b'.repeat(64) } },
    results: calls.map(call => {
      if (call.kind === 'account') return { kind: 'account', address: call.address, account_state: 'active', balance_raw: '1',
        code_boc: (call.address === POOL ? POOL_CODE : ROOT_CODE).toBoc().toString('base64'),
        data_boc: beginCell().endCell().toBoc().toString('base64') };
      const stack = {
        pool_state: [addr(T3), addr(ASSET), addr(T3), addr(T3), num(1), num(0), num(3000), num(10000), num(1), num(1), num(8), num(128), num(10n ** 13n)],
        active_price_q64: [num(0), num(1n << 64n)],
        observation: [num(0), num(activityTime), num(10n ** 13n)],
        oracle_depth_health: [num(1), num(activityTime), num(10n ** 13n), num(10n ** 13n), num(172800)],
        perps_oracle_snapshot: [num(-1), num(chainTime), num(activityTime), ['cell', { bytes: beginCell().endCell().toBoc().toString('base64') }]],
      }[call.method!];
      return { kind: 'getter', address: call.address, exit_code: 0, stack, gas_used: null };
    }) };
}
export function dexFetcher(transform: (body: Record<string, any>, calls: FixtureCall[]) => void = () => {}): Fetcher {
  return async (_url, init) => {
    const calls: FixtureCall[] = JSON.parse(String(init?.body)).calls;
    const body = freshDexBody(calls); transform(body, calls);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
