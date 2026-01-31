import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const cwd = process.cwd();
const tolkRoot = process.env.TONSWAP_TOLK_PATH
  ? resolve(process.env.TONSWAP_TOLK_PATH)
  : resolve(cwd, '..', 'tonswap_tolk');
const debugRoot = resolve(tolkRoot, 'tmp_debug');

const moduleAddresses = readJson<Record<string, string>>(resolve(debugRoot, 'module_addresses.json')) ?? {};
const t3Root = readText(resolve(debugRoot, 't3.root.address'));
const tsRoot = readText(resolve(debugRoot, 'ts.root.address'));
const usdtRoot = readText(resolve(debugRoot, 't3.usdt.root.address'));
const usdcRoot = readText(resolve(debugRoot, 't3.usdc.root.address'));
const kusdRoot = readText(resolve(debugRoot, 't3.kusd.root.address'));
const dlmmRegistry = readText(resolve(debugRoot, 'dlmm.registry.address'));
const dlmmFactory = readText(resolve(debugRoot, 'dlmm.factory.address'));
const dlmmTokenX = readText(resolve(debugRoot, 'dlmm.token_x.address'));
const dlmmPool = readText(resolve(debugRoot, 'dlmm.pool.address'));

const registryPath = resolve(cwd, 'registry', 'testnet.json');
const existing = readJson<Record<string, string>>(registryPath) ?? {};

const mapping: Record<string, string | null | undefined> = {
  ClmmRouter: moduleAddresses.ClmmRouter,
  ClmmPoolFactory: moduleAddresses.ClmmPoolFactory,
  ClmmSeedingExecutor: moduleAddresses.ClmmSeedingExecutor,
  FeeRouter: moduleAddresses.FeeRouter,
  Treasury: moduleAddresses.Treasury,
  ReferralRegistry: moduleAddresses.ReferralRegistry,
  T3Root: t3Root,
  TSRoot: tsRoot,
  UsdtRoot: usdtRoot,
  UsdcRoot: usdcRoot,
  KusdRoot: kusdRoot,
  DlmmRegistry: dlmmRegistry,
  DlmmPoolFactory: dlmmFactory,
  DlmmTokenX: dlmmTokenX,
  DlmmPool: dlmmPool,
};

const next: Record<string, string> = { ...existing };
for (const [key, value] of Object.entries(mapping)) {
  if (value) next[key] = value;
}

writeFileSync(registryPath, JSON.stringify(next, null, 2) + '\n');
console.log('Updated registry/testnet.json from', debugRoot);
