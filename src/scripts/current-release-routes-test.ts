import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { beginCell, Dictionary } from '@ton/core';
import { ChainReadError, type ChainHead, type ChainSource } from '../data/dataSource';
import { registerRoutes } from '../api/routes';
import { buildOpenApi } from '../api/openapi';
import { buildRuntimeManifestBundle } from '../config/releaseManifest';
import type { IndexerService } from '../indexerService';
import { OrderPageError, type CurrentOrdersRuntime } from '../runtime/ordersRuntime';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { operationRequestFixture } from './current-t3-operation-request-test';
import { directSpotOperationRequestFixture, orderCreateSpotOperationRequestFixture, orderSettlementSpotOperationRequestFixture } from './current-spot-operation-request-test';
import { SpotEvidenceError } from '../runtime/spotOperationRequest';
import { T3EvidenceError } from '../runtime/t3OperationRequest';

// Synthetic TL-B prices exercise the HTTP/parser contract only. Authentication
// of original masterchain configuration proofs is tested by the lite source.
function configPrices() {
  // Config 18 values are inline records, rather than references.
  const prices = Dictionary.empty(Dictionary.Keys.Uint(32), {
    serialize(value: number, builder: ReturnType<typeof beginCell>) {
      builder.storeUint(0xcc, 8).storeUint(value, 32).storeUint(value + 1, 64).storeUint(value + 2, 64).storeUint(99, 64).storeUint(100, 64);
    }, parse() { throw Error('write only'); },
  });
  prices.set(0, 0); prices.set(1, 0xffffffff);
  const config = Dictionary.empty(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
  config.set(18, beginCell().storeDictDirect(prices).endCell());
  const gas = beginCell().storeUint(0xd1, 8).storeUint(100, 64).storeUint(200, 64).storeUint(0xde, 8).storeUint(300, 64);
  for (let i = 0; i < 6; i++) gas.storeUint(i, 64);
  config.set(21, gas.endCell());
  config.set(25, beginCell().storeUint(0xea, 8).storeUint(400, 64).storeUint(500, 64).storeUint(600, 64).storeUint(0, 64).endCell());
  return beginCell().storeDictDirect(config).endCell().toBoc().toString('base64');
}
async function main() {
  const manifest = runtimeManifestFixture(), bundle = buildRuntimeManifestBundle(manifest);
  const head: ChainHead = { workchain: -1, shard: '-9223372036854775808', seqno: 100, rootHashHex: '1'.repeat(64), fileHashHex: '2'.repeat(64), utime: Math.floor(Date.now() / 1000) };
  let configReads = 0, headReads = 0, orderReads = 0, t3Reads = 0, walletClaimReads = 0, walletClaimUnavailable = false,
    orderClaimReads = 0, orderClaimUnavailable = false, spotReads = 0, spotUnavailable = false, mode: 'ok' | 'wrongHead' | 'invalid' | 'timeout' = 'ok';
  const source = { async head() { headReads++; return head; }, async getConfig(options: { at: ChainHead }) {
    configReads++; assert.deepEqual(options.at, head);
    if (mode === 'timeout') throw new ChainReadError('upstream_timeout');
    return { head: mode === 'wrongHead' ? { ...head, fileHashHex: 'f'.repeat(64) } : head, configBoc: mode === 'invalid' ? '' : configPrices() };
  } } as unknown as ChainSource;
  const orders: Pick<CurrentOrdersRuntime, 'page' | 'operationEvidence' | 'walletClaimEvidence' | 'orderWalletClaimEvidence' | 'spotOperationEvidence'> = { async page(query) {
    orderReads++;
    if (query.cursor === 'expired') throw new OrderPageError(409, 'cursor_mismatch');
    if (query.cursor === 'missing') throw new OrderPageError(503, 'upstream_unavailable');
    assert.deepEqual(query, { cursor: undefined, limit: 100 });
    return { headers: { 'x-tonswap-release': manifest.manifestHash, 'cache-control': 'no-store' },
      body: { schema: 'tonswap-open-orders-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
        asOf: { masterchainSeqno: 100, unixTime: head.utime, blockRootHash: head.rootHashHex }, coverage: { complete: false }, orders: [], nextCursor: null } } as any;
  }, async operationEvidence({ request }) {
    t3Reads++;
    return { schema: 'tonswap-t3-operation-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
      request: { kind: request.kind, owner: request.owner, bodyHash: request.bodyHash },
      coverage: { complete: false, gaps: [{ code: 'hub_history_incomplete', account: request.hub }] },
      hub: { address: request.hub, codeBoc: '', dataBoc: '' }, receipts: [], transactions: [] };
  }, async walletClaimEvidence({ request }, signal) {
    walletClaimReads++; assert(signal); if (walletClaimUnavailable) throw new T3EvidenceError(503, 'upstream_unavailable');
    return { schema: 'tonswap-t3-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
      request: { kind: 'redeem', owner: request.owner, wallet: request.wallet, bodyHash: request.bodyHash },
      coverage: { complete: false, gaps: [{ code: 'wallet_history_incomplete', account: request.wallet }] },
      wallet: { address: request.wallet, codeBoc: '', dataBoc: '' }, claims: { root: '0'.repeat(64), count: '0', records: [], failureRoot: '0'.repeat(64), failureCount: '0', failures: [] } };
  }, async orderWalletClaimEvidence({ request }, signal) {
    orderClaimReads++; assert(signal); if (orderClaimUnavailable) throw new SpotEvidenceError(503, 'upstream_unavailable');
    return { schema: 'tonswap-order-wallet-claim-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
      request: { kind: 'order-settlement', owner: request.owner, order: request.order, nonce: request.nonce, termsHash: request.termsHash, fundingBodyHash: request.funding?.bodyHash ?? null },
      coverage: { complete: false, gaps: [{ code: 'wallet_history_incomplete', account: request.order }] },
      order: { address: request.order, codeBoc: '', dataBoc: '' }, wallet: { address: request.order, codeBoc: '', dataBoc: '' },
      claims: { root: '0'.repeat(64), count: '0', records: [], failureRoot: '0'.repeat(64), failureCount: '0', failures: [] } };
  }, async spotOperationEvidence({ request }, signal) {
    spotReads++; assert(signal); if (spotUnavailable) throw new SpotEvidenceError(503, 'upstream_unavailable');
    const common = { schema: 'tonswap-spot-operation-evidence-v1' as const, releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
      coverage: { complete: false, gaps: [{ code: 'original_request_unobserved', account: request.owner }] },
      pool: { address: request.pool, codeBoc: '', dataBoc: '' }, accounts: [], transactions: [] };
    return request.kind === 'direct' ? { ...common, request: { kind: 'direct' as const, owner: request.owner, bodyHash: request.bodyHash },
      wallets: { pay: request.sourceWallet, receive: request.owner, poolPay: request.pool, poolReceive: request.pool } }
      : request.kind === 'order-create' ? { ...common, request: { kind: 'order-create' as const, owner: request.owner, nonce: request.nonce, termsHash: request.termsHash },
        factory: { address: request.factory, codeBoc: '', dataBoc: '' }, order: { address: request.order, codeBoc: '', dataBoc: '' } }
      : { ...common, request: { kind: 'order-settlement' as const, owner: request.owner, nonce: request.nonce, termsHash: request.termsHash, fundingBodyHash: request.funding?.bodyHash ?? null },
        factory: { address: request.factory, codeBoc: '', dataBoc: '' }, order: { address: request.order, codeBoc: '', dataBoc: '' }, absentAccounts: [],
        wallets: { ownerPay: request.owner, ownerReceive: request.owner, orderPay: request.order, poolPay: request.pool, poolReceive: request.pool } };
  } };
  const service = { getAdmissionStatus() { return { configured: false, ready: false }; } } as IndexerService;
  const app = Fastify();
  registerRoutes(app, { network: 'testnet' }, service, undefined, undefined, undefined, undefined, bundle.contracts, bundle.metadata, { source, orders });
  const path = `/api/indexer/v1/config-prices?masterchainSeqno=100&blockRootHash=${head.rootHashHex}`;
  const check = (reply: Awaited<ReturnType<typeof app.inject>>, status: number, code?: string) => {
    assert.equal(reply.statusCode, status, reply.body); assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['x-tonswap-release'], manifest.manifestHash);
    if (code) assert.equal(reply.json().code, code);
  };
  try {
    const first = await app.inject(path); check(first, 200);
    assert.deepEqual(first.json(), { schema: 'tonswap-config-prices-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      asOf: { masterchainSeqno: 100, unixTime: head.utime, blockRootHash: head.rootHashHex },
      basechain: { gas: { flatGasPrice: '200', flatLimit: '100', other: { gasPrice: '300' } },
        forward: { lumpPrice: '400', bitPrice: '500', cellPrice: '600' }, storage: { bit_price_ps: '1', cell_price_ps: '2' } } });
    check(await app.inject(path), 200); assert.equal(configReads, 2, 'completed prices must not be cached');
    check(await app.inject(path.replace('Seqno=100', 'Seqno=101')), 409, 'head_mismatch');
    check(await app.inject(path.replace(head.rootHashHex, '3'.repeat(64))), 409, 'head_mismatch');
    assert.equal(configReads, 2, 'mismatched head cannot run the config read');
    const readCount = headReads;
    for (const query of ['', '?masterchainSeqno=100', path.slice(path.indexOf('?')) + '&extra=1',
      path.slice(path.indexOf('?')).replace('=100', '=0100'), path.slice(path.indexOf('?')) + '&masterchainSeqno=100'])
      check(await app.inject('/api/indexer/v1/config-prices' + query), 400, 'bad_request');
    assert.equal(headReads, readCount, 'malformed queries cannot read the source');
    check(await app.inject({ url: path, headers: { 'x-tonswap-release': 'f'.repeat(64) } }), 409, 'release_mismatch');
    assert.equal(headReads, readCount);
    for (const value of ['wrongHead', 'invalid', 'timeout'] as const) {
      mode = value; check(await app.inject(path), value === 'timeout' ? 504 : 503, value === 'timeout' ? 'upstream_timeout' : 'upstream_unavailable');
    }
    mode = 'ok'; head.utime -= 31; const reads = configReads;
    check(await app.inject(path), 503, 'upstream_unavailable'); assert.equal(configReads, reads); head.utime += 31;
    check(await app.inject('/api/indexer/v1/orders/open?limit=100'), 200);
    for (const query of ['?cursor=', '?limit=0', '?limit=101', '?limit=01', '?limit=100&limit=100', '?other=1'])
      check(await app.inject('/api/indexer/v1/orders/open' + query), 400, 'invalid_cursor');
    assert.equal(orderReads, 1, 'invalid pagination cannot run the order reader');
    check(await app.inject('/api/indexer/v1/orders/open?cursor=expired'), 409, 'cursor_mismatch');
    check(await app.inject('/api/indexer/v1/orders/open?cursor=missing'), 503, 'upstream_unavailable');
    const t3 = operationRequestFixture().request, t3Path = '/api/indexer/v1/t3/operation-evidence';
    const pending = await app.inject({ method: 'POST', url: t3Path, payload: t3 }); check(pending, 200);
    assert.equal(pending.json().coverage.complete, false); assert.equal(pending.json().request.bodyHash, t3.bodyHash);
    check(await app.inject({ method: 'POST', url: t3Path, payload: { ...t3, extra: 1 } }), 400, 'bad_request');
    check(await app.inject({ method: 'POST', url: t3Path + '?unexpected=1', payload: t3 }), 400, 'bad_request');
    check(await app.inject({ method: 'POST', url: t3Path, payload: { ...t3, manifestHash: '0'.repeat(64) } }), 409, 'release_mismatch');
    check(await app.inject({ method: 'POST', url: t3Path, payload: t3, headers: { 'x-tonswap-release': '0'.repeat(64) } }), 409, 'release_mismatch');
    assert.equal(t3Reads, 1, 'invalid or mismatched T3 requests cannot collect evidence');
    const claim = operationRequestFixture('redeem').request, claimPath = '/api/indexer/v1/t3/wallet-claim-evidence';
    const claimed = await app.inject({ method: 'POST', url: claimPath, payload: claim }); check(claimed, 200);
    assert.equal(claimed.json().request.bodyHash, claim.bodyHash); assert.equal(claimed.json().coverage.complete, false);
    for (const payload of [t3, { ...claim, extra: true }, { ...claim, amountRaw: '11' }])
      check(await app.inject({ method: 'POST', url: claimPath, payload }), 400, 'bad_request');
    check(await app.inject({ method: 'POST', url: claimPath + '?unexpected=1', payload: claim }), 400, 'bad_request');
    check(await app.inject({ method: 'POST', url: claimPath, payload: { ...claim, manifestHash: '0'.repeat(64) } }), 409, 'release_mismatch');
    check(await app.inject({ method: 'POST', url: claimPath, payload: claim, headers: { 'x-tonswap-release': '0'.repeat(64) } }), 409, 'release_mismatch');
    check(await app.inject({ method: 'POST', url: claimPath, payload: JSON.stringify({ ...claim, extra: 'x'.repeat(192 * 1024) }), headers: { 'content-type': 'application/json' } }), 413);
    assert.equal(walletClaimReads, 1, 'invalid, mint and mismatched wallet claim requests cannot collect evidence');
    check(await app.inject({ method: 'POST', url: claimPath, payload: claim }), 200); assert.equal(walletClaimReads, 2, 'wallet proofs must never reuse completed responses');
    walletClaimUnavailable = true; check(await app.inject({ method: 'POST', url: claimPath, payload: claim }), 503, 'upstream_unavailable');
    const orderClaim = orderSettlementSpotOperationRequestFixture().request, orderClaimPath = '/api/indexer/v1/spot/order-wallet-claim-evidence';
    const orderClaimed = await app.inject({ method: 'POST', url: orderClaimPath, payload: orderClaim }); check(orderClaimed, 200);
    assert.equal(orderClaimed.json().request.order, orderClaim.order); assert.equal(orderClaimed.json().request.fundingBodyHash, orderClaim.funding!.bodyHash);
    const otherInput = { ...orderCreateSpotOperationRequestFixture(true).request, kind: 'order-settlement', funding: null };
    for (const payload of [t3, orderCreateSpotOperationRequestFixture().request, directSpotOperationRequestFixture().request, otherInput, { ...orderClaim, extra: 1 }])
      check(await app.inject({ method: 'POST', url: orderClaimPath, payload }), 400, 'bad_request');
    check(await app.inject({ method: 'POST', url: orderClaimPath + '?unexpected=1', payload: orderClaim }), 400, 'bad_request');
    check(await app.inject({ method: 'POST', url: orderClaimPath, payload: { ...orderClaim, manifestHash: '0'.repeat(64) } }), 409, 'release_mismatch');
    check(await app.inject({ method: 'POST', url: orderClaimPath, payload: orderClaim, headers: { 'x-tonswap-release': '0'.repeat(64) } }), 409, 'release_mismatch');
    check(await app.inject({ method: 'POST', url: orderClaimPath, payload: JSON.stringify({ ...orderClaim, extra: 'x'.repeat(192 * 1024) }), headers: { 'content-type': 'application/json' } }), 413);
    assert.equal(orderClaimReads, 1, 'invalid, unsupported and mismatched order wallet requests cannot collect evidence');
    check(await app.inject({ method: 'POST', url: orderClaimPath, payload: orderClaim }), 200); assert.equal(orderClaimReads, 2);
    orderClaimUnavailable = true; check(await app.inject({ method: 'POST', url: orderClaimPath, payload: orderClaim }), 503, 'upstream_unavailable');
    const spotPath = '/api/indexer/v1/spot/operation-evidence';
    for (const spot of [directSpotOperationRequestFixture().request, orderCreateSpotOperationRequestFixture().request, orderSettlementSpotOperationRequestFixture().request, orderSettlementSpotOperationRequestFixture(false).request]) {
      const observed = await app.inject({ method: 'POST', url: spotPath, payload: spot }); check(observed, 200);
      assert.equal(observed.json().request.kind, spot.kind); assert.equal(observed.json().coverage.complete, false);
      const count = spotReads;
      for (const changed of [{ ...spot, extra: 1 }, { ...spot, owner: 'invalid' }])
        check(await app.inject({ method: 'POST', url: spotPath, payload: changed }), 400, 'bad_request');
      check(await app.inject({ method: 'POST', url: spotPath + '?unexpected=1', payload: spot }), 400, 'bad_request');
      check(await app.inject({ method: 'POST', url: spotPath, payload: { ...spot, manifestHash: '0'.repeat(64) } }), 409, 'release_mismatch');
      check(await app.inject({ method: 'POST', url: spotPath, payload: spot, headers: { 'x-tonswap-release': '0'.repeat(64) } }), 409, 'release_mismatch');
      check(await app.inject({ method: 'POST', url: spotPath, payload: JSON.stringify({ ...spot, extra: 'x'.repeat(192 * 1024) }), headers: { 'content-type': 'application/json' } }), 413);
      assert.equal(spotReads, count, 'invalid or mismatched Spot requests cannot collect evidence');
      spotUnavailable = true; check(await app.inject({ method: 'POST', url: spotPath, payload: spot }), 503, 'upstream_unavailable'); spotUnavailable = false;
    }
    const info = (await app.inject('/api/indexer/v1/service-info')).json();
    assert.equal(info.endpoints.spotOperationEvidence, spotPath); assert.equal(info.endpoints.t3OperationEvidence, t3Path);
    assert.equal(info.endpoints.t3WalletClaimEvidence, claimPath);
    assert.equal(info.endpoints.orderWalletClaimEvidence, orderClaimPath);
    assert.equal(info.endpoints.openOrders, '/api/indexer/v1/orders/open'); assert.equal(info.endpoints.configPrices, '/api/indexer/v1/config-prices');
    const spec = buildOpenApi({ network: 'testnet' }, bundle.metadata);
    for (const route of ['/api/indexer/v1/orders/open', '/api/indexer/v1/config-prices', spotPath, t3Path, claimPath, orderClaimPath]) assert(route in spec.paths);
    assert(spec.components.schemas.SpotOperationEvidenceResponse); assert(spec.components.schemas.CurrentSpotRequest); assert(spec.components.schemas.ConfigPricesResponse); assert(spec.components.schemas.OpenOrdersResponse);
  } finally { await app.close(); }
  console.log('Current orders, config-price and T3/Spot evidence API strict requests, exact head, uncached reads, release fence, body bounds, errors and discovery passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
