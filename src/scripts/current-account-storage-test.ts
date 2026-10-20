import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Cell, CellType, beginCell, loadShardAccount } from '@ton/core';
import { readAccountStorage } from '../runtime/accountStorage';
import { boundaryState } from '../runtime/physicalEvidence';
import { fakeChainSource } from './support/fakeChainSource';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import type { ChainHead } from '../data/dataSource';
import type { IndexerService } from '../indexerService';

async function main() {
  // Original retained account/configuration bytes with a synthetic source/head.
  // Authentication itself is exercised separately by lite-proof-test.
  const account = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/predecessor.boc')))[0];
  const config = Cell.fromBoc(readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/config.boc')))[0];
  const address = loadShardAccount(account.beginParse()).account!.addr.toRawString();
  const manifest = runtimeManifestFixture(), bundle = buildRuntimeManifestBundle(manifest);
  const head: ChainHead = { workchain: -1, shard: '-9223372036854775808', seqno: 100,
    rootHashHex: '1'.repeat(64), fileHashHex: '2'.repeat(64), utime: Math.floor(Date.now() / 1000) };
  const state = { ...boundaryState(address, account.toBoc().toString('base64'), 100).state,
    anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: head.utime } };
  let mode = '', reads = 0;
  const source = fakeChainSource({ network: 'testnet', head: async () => head,
    getAccountState: async (requested, options) => {
      assert.equal(requested, address); assert.equal(options?.at, head); reads++;
      if (mode === 'uninitialized') return { ...state, accountState: 'uninitialized' };
      if (mode === 'missing') return { ...state, shardAccountBoc: undefined };
      if (mode === 'wrong-balance') return { ...state, balance: '1' };
      if (mode === 'wrong-pointer') return { ...state, lastTxLt: '1' };
      return state;
    }, getConfig: async options => {
      assert.equal(options?.at, head); reads++;
      const pruned = beginCell().storeUint(CellType.PrunedBranch, 8).storeUint(1, 8).storeBuffer(config.hash(0))
        .storeUint(config.depth(0), 16).endCell({ exotic: true });
      return { head: mode === 'wrong-head' ? { ...head, fileHashHex: 'f'.repeat(64) } : head,
        configBoc: (mode === 'pruned' ? beginCell().storeRef(pruned).endCell() : config).toBoc().toString('base64') };
    } });
  const app = Fastify(); const service = {  } as IndexerService;
  registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, bundle.contracts, bundle.metadata, { source });
  const path = `/api/indexer/v1/account-storage?address=${encodeURIComponent(address)}&masterchainSeqno=100&blockRootHash=${head.rootHashHex}`;
  const check = async (url: string, status: number, code?: string, headers?: Record<string, string>) => {
    const reply = await app.inject({ url, headers }); assert.equal(reply.statusCode, status, reply.body);
    assert.equal(reply.headers['x-tonswap-release'], manifest.manifestHash); assert.equal(reply.headers['cache-control'], 'no-store');
    if (code) assert.equal(reply.json().code, code); return reply.json();
  };
  try {
    const result = await check(path, 200);
    assert.deepEqual(result, { schema: 'tonswap-account-storage-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      asOf: { masterchainSeqno: 100, unixTime: head.utime, blockRootHash: head.rootHashHex },
      account: { address, shardAccountBoc: account.toBoc().toString('base64') }, configBoc: config.toBoc().toString('base64') });
    await check(path, 200); assert.equal(reads, 4, 'completed account/config responses are never cached');
    await check(path.replace('Seqno=100', 'Seqno=101'), 409, 'head_mismatch');
    await check(path.replace(head.rootHashHex, '3'.repeat(64)), 409, 'head_mismatch');
    for (const url of [path + '&extra=1', path + '&address=x', path.replace('Seqno=100', 'Seqno=0100'), path.replace(encodeURIComponent(address), 'bad'), path.split('?')[0]])
      await check(url, 400, 'bad_request');
    await check(path, 409, 'release_mismatch', { 'x-tonswap-release': '0'.repeat(64) }); assert.equal(reads, 4);
    for (mode of ['uninitialized', 'missing', 'wrong-balance', 'wrong-pointer', 'wrong-head', 'pruned']) await check(path, 503, 'upstream_unavailable');
    mode = ''; const controller = new AbortController(); controller.abort();
    await assert.rejects(readAccountStorage(manifest, source, address, head, controller.signal));
    const info = (await app.inject('/api/indexer/v1/service-info')).json(); assert.equal(info.endpoints.accountStorage, '/api/indexer/v1/account-storage');
    const spec = buildOpenApi({ network: 'testnet' }, bundle.metadata); assert(spec.paths['/api/indexer/v1/account-storage']); assert(spec.components.schemas.AccountStorageResponse);
  } finally { await app.close(); }
  console.log('Exact-head original active account/config storage, release fences, no cache, unavailable/pruned rejection and cancellation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
