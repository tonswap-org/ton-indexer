import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { loadConfig } from '../config';
import { TonDataSource } from '../data/dataSource';
import { IndexerService } from '../indexerService';
import { AccountState, JettonMetadata } from '../models';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';

const owner = `0:${'a'.repeat(64)}`;
const master = `0:${'b'.repeat(64)}`;
const wallet = `0:${'c'.repeat(64)}`;
const config = { ...loadConfig(), responseCacheEnabled: true, balanceCacheTtlMs: 60_000 };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const promptly = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Balance waited for unrelated work')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const sourceWith = (overrides: Partial<TonDataSource>): TonDataSource => ({
  network: 'testnet',
  async getMasterchainInfo() { return { seqno: 1 }; },
  async getAccountState() { return { balance: '123' }; },
  async getTransactions() { return []; },
  async runGetMethod() { return null; },
  async getJettonBalance() { return { wallet, balance: '1234567' }; },
  async getJettonMetadata() { return null; },
  async close() {},
  ...overrides,
});

const testConcurrentReadsAndMetadataEnrichment = async () => {
  const native = deferred<{ balance: string }>();
  const jetton = deferred<{ wallet: string; balance: string }>();
  const metadata = deferred<JettonMetadata | null>();
  let nativeCalls = 0;
  let jettonCalls = 0;
  let metadataCalls = 0;
  const service = new IndexerService(config, new MemoryStore(config), sourceWith({
    async getAccountState() { nativeCalls += 1; return native.promise; },
    async getJettonBalance() { jettonCalls += 1; return jetton.promise; },
    async getJettonMetadata() { metadataCalls += 1; return metadata.promise; },
  }), loadOpcodes(undefined), [{ master, symbol: 'UNKNOWN' }]);

  // The REST raw/formatted endpoints and SSE snapshots share one canonical read,
  // including when the same owner uses a friendly address representation.
  const rawRead = service.getBalance(owner);
  const formattedRead = service.getBalances(Address.parse(owner).toString());
  const streamRead = service.getBalances(owner);
  native.resolve({ balance: '123' });
  jetton.resolve({ wallet, balance: '1234567' });
  const [raw, formatted, stream] = await promptly(Promise.all([rawRead, formattedRead, streamRead]));
  assert.equal(nativeCalls, 1);
  assert.equal(jettonCalls, 1);
  assert.equal(metadataCalls, 1);
  assert.equal(raw.confirmed, true, 'Missing display metadata does not weaken verified raw balances');
  assert.equal(raw.jettons[0].balance, '1234567');
  assert.deepEqual(formatted.assets.find((item) => item.kind === 'native'), {
    kind: 'native', symbol: 'GRAM', address: owner, wallet: owner,
    balance_raw: '123', balance: '0.000000123', decimals: 9,
  });
  const asset = formatted.assets.find((item) => item.kind === 'jetton');
  assert.ok(asset);
  assert.equal(asset.balance_raw, '1234567');
  assert.equal(Object.hasOwn(asset, 'decimals'), false);
  assert.equal(Object.hasOwn(asset, 'balance'), false);
  assert.deepEqual(stream, formatted);

  metadata.resolve({ symbol: 'REAL', decimals: 6 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const enriched = await service.getBalances(owner);
  const enrichedAsset = enriched.assets.find((item) => item.kind === 'jetton');
  assert.equal(enrichedAsset?.symbol, 'REAL');
  assert.equal(enrichedAsset?.decimals, 6);
  assert.equal(enrichedAsset?.balance, '1.234567');
  assert.equal(metadataCalls, 1, 'Completed metadata is reused until its TTL expires');
};

const testColdNativeReadsDoNotWaitForHistory = async () => {
  const store = new MemoryStore(config);
  const history = deferred<void>();
  const locked = deferred<void>();
  const native = deferred<{ balance: string }>();
  let nativeCalls = 0;
  const service = new IndexerService(config, store, sourceWith({
    async getAccountState() { nativeCalls += 1; return native.promise; },
  }), loadOpcodes(undefined), []);
  const newer: AccountState = { address: owner, balance: '999', updatedAt: Date.now() };
  const historyWorkflow = store.withAddressLock(owner, async () => {
    locked.resolve();
    await history.promise;
    store.setBalance(owner, newer);
  });
  await locked.promise;
  try {
    const nativeRead = service.getNativeState(owner);
    const balanceRead = service.getBalances(owner);
    native.resolve({ balance: '123' });
    const [state, balances] = await promptly(Promise.all([nativeRead, balanceRead]));
    assert.equal(state.balance_raw, '123');
    assert.equal(balances.ton_raw, '123');
    assert.equal(nativeCalls, 1);
    assert.equal((await promptly(service.getNativeState(owner))).balance_raw, '123');
    assert.equal((await promptly(service.getBalances(owner))).ton_raw, '123');
    assert.equal(nativeCalls, 1, 'Sequential reads must reuse the resolved snapshot until it is published');
    assert.equal(store.get(owner)?.balance, undefined, 'Persistence must respect the history lock');
  } finally {
    history.resolve();
    await historyWorkflow;
  }
  await store.withAddressLock(owner, () => undefined);
  assert.equal(store.get(owner)?.balance, newer, 'A deferred cold read must not overwrite newer state');
  assert.equal((await service.getBalances(owner)).ton_raw, '999');
};

const testFailedNativeReadCanRetry = async () => {
  let calls = 0;
  const service = new IndexerService(config, new MemoryStore(config), sourceWith({
    async getAccountState() {
      calls += 1;
      if (calls === 1) throw new Error('Temporary source failure');
      return { balance: '456' };
    },
    async getJettonMetadata() { throw new Error('Metadata unavailable'); },
  }), loadOpcodes(undefined), [{ master, symbol: 'UNKNOWN' }]);
  const failures = await Promise.allSettled([service.getBalance(owner), service.getBalances(owner)]);
  assert.ok(failures.every((result) => result.status === 'rejected'));
  assert.equal(calls, 1);
  const recovered = await promptly(service.getBalances(owner));
  assert.equal(recovered.ton_raw, '456');
  assert.equal(recovered.confirmed, true);
  assert.equal(calls, 2);
};

const testFreshMetadataWithCachingDisabled = async () => {
  const uncachedConfig = { ...config, responseCacheEnabled: false, jettonMetadataTtlMs: 0 };
  let metadataCalls = 0;
  const service = new IndexerService(uncachedConfig, new MemoryStore(uncachedConfig), sourceWith({
    async getJettonMetadata() { metadataCalls += 1; return { decimals: 6 }; },
  }), loadOpcodes(undefined), [{ master, symbol: 'UNKNOWN' }]);
  const first = await service.getBalances(owner);
  const second = await service.getBalances(owner);
  assert.equal(first.assets.find((item) => item.kind === 'jetton')?.balance, '1.234567');
  assert.equal(second.assets.find((item) => item.kind === 'jetton')?.balance, '1.234567');
  assert.equal(metadataCalls, 2, 'A zero metadata TTL still includes fresh metadata and revalidates');
};

Promise.all([
  testConcurrentReadsAndMetadataEnrichment(),
  testColdNativeReadsDoNotWaitForHistory(),
  testFailedNativeReadCanRetry(),
  testFreshMetadataWithCachingDisabled(),
]).then(() => console.log('balance latency ok')).catch((error) => {
  console.error('balance latency test failed', error);
  process.exit(1);
});
