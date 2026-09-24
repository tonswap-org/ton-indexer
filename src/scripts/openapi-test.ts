import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { buildOpenApi } from '../api/openapi';

const spec = buildOpenApi(loadConfig());
assert.equal(spec.openapi, '3.1.0');
const assertNoLegacyNullableKeyword = (value: unknown, path = '$'): void => {
  if (!value || typeof value !== 'object') return;
  if ('nullable' in value) {
    assert.fail(`OpenAPI 3.1 schema uses legacy nullable keyword at ${path}`);
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoLegacyNullableKeyword(child, `${path}.${key}`);
  }
};
assertNoLegacyNullableKeyword(spec);
assert.ok(spec.paths['/api/indexer/v1/health']);
assert.ok(spec.paths['/api/indexer/v1/contracts']);
assert.ok(spec.paths['/api/indexer/v1/service-info']);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/txs']);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/ledger']);
assert.ok(spec.components.schemas.LedgerEvent.properties.movements);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/txs'].get.responses[503]);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/swaps']);
assert.ok(spec.paths['/api/indexer/v1/markets/{market}/candles']);
assert.ok(spec.paths['/api/indexer/v1/jettons/{jetton}/transfer/{owner}/payload']);
assert.ok(spec.paths['/api/indexer/v1/perps/{engine}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/vol-index/{volIndex}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/governance/{voting}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/pools/{pool}/farms']);
assert.ok(spec.paths['/api/indexer/v1/options/{factory}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/cover/{manager}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/openapi.json']);
assert.equal('security' in spec.paths['/api/indexer/v1/runGetMethod'].post, false);
assert.equal('security' in spec.paths['/api/indexer/v1/runGetMethods'].post, false);
assert.deepEqual(spec.paths['/api/indexer/v1/metrics'].get.security, [{ AdminToken: [] }, { AdminBearer: [] }]);
assert.ok(spec.components?.securitySchemes?.AdminToken);
assert.ok(spec.components?.securitySchemes?.AdminBearer);
assert.deepEqual(spec.paths['/api/indexer/v1/snapshot/save'].post.security, [
  { AdminToken: [] },
  { AdminBearer: [] },
]);
assert.ok(spec.paths['/api/indexer/v1/snapshot/save'].post.responses[401]);
assert.deepEqual(spec.paths['/api/indexer/v1/debug'].get.security, [{ AdminToken: [] }, { AdminBearer: [] }]);
assert.ok(spec.paths['/api/indexer/v1/debug'].get.responses[401]);
const txEntry =
  spec.components?.schemas?.TxEntry?.properties?.detail?.properties ??
  ({} as Record<string, unknown>);
assert.ok('executionType' in txEntry);
assert.ok('twapSlice' in txEntry);
assert.ok('twapTotal' in txEntry);
assert.ok('queryId' in txEntry);
assert.ok('querySequence' in txEntry);
assert.ok('queryNonce' in txEntry);
assert.ok(spec.components?.schemas?.SwapsResponse);
assert.ok(spec.components?.schemas?.MarketCandle);
assert.ok(spec.components?.schemas?.MarketCandlesResponse);
const assetBalanceSchema = spec.components?.schemas?.AssetBalanceResponse;
assert.ok(assetBalanceSchema);
assert.equal(assetBalanceSchema.required?.includes('balance'), false);
assert.equal(assetBalanceSchema.required?.includes('decimals'), false);
assert.deepEqual(assetBalanceSchema.dependentRequired, {
  balance: ['decimals'],
  decimals: ['balance'],
});
assert.deepEqual(assetBalanceSchema.allOf?.[0]?.then?.required, ['balance', 'decimals']);
assert.match(
  spec.components.schemas.BalanceResponse.properties.confirmed.description,
  /every configured jetton balance/
);
const swapsResponseProps =
  spec.components?.schemas?.SwapsResponse?.properties ??
  ({} as Record<string, unknown>);
assert.ok('synced_at' in swapsResponseProps);
const candleProps =
  spec.components?.schemas?.MarketCandle?.properties ??
  ({} as Record<string, unknown>);
assert.ok('sourceTxIds' in candleProps);
assert.ok(spec.components?.schemas?.SwapExecutionEntry);
assert.ok(spec.components?.schemas?.SwapsSummary);
assert.ok(spec.components?.schemas?.TwapRunSummaryEntry);
assert.ok(spec.components?.schemas?.PendingLimitOrderEntry);
assert.ok(spec.components?.schemas?.JettonTransferPayloadResponse);
assert.ok(spec.components?.schemas?.VolIndexSnapshotResponse);
const perpsStatusProps =
  spec.components?.schemas?.PerpsStatusResponse?.properties ??
  ({} as Record<string, unknown>);
assert.ok('feeBps' in perpsStatusProps);
assert.ok(spec.components?.schemas?.PerpsStatusResponse?.required?.includes('feeBps'));
assert.match(perpsStatusProps.feeBps.description, /33-field/);
const perpsAutomationProps = spec.components?.schemas?.PerpsAutomationResponse?.properties ?? {};
assert.ok('controlRequestHash' in perpsAutomationProps);
const perpsMarketProps = spec.components?.schemas?.PerpsMarketStateResponse?.properties ?? {};
for (const retired of [
  'marketKind', 'kindConfig', 'timerVolatilityBps', 'timerEmaVolatilityBps', 'timerLastUpdateTs',
  'timerWeightBps', 'correlationBps', 'correlationDispersionBps', 'correlationLastUpdateTs',
  'correlationWeightBps', 'lastVolatilityTimestamp', 'lastVolatilityRequestHash', 'crossMargin', 'flags',
]) {
  assert.equal(retired in perpsMarketProps, false, `${retired} must remain outside current Perps market state`);
}
const coverStateProps = spec.components?.schemas?.CoverStateResponse?.properties ?? {};
assert.ok('governance' in coverStateProps);
const coverPolicyProps = spec.components?.schemas?.CoverPolicyResponse?.properties ?? {};
for (const field of ['coveredNotional', 'lastVolatilityTimestamp', 'lastVolatilityRequestHash', 'startsAt', 'expiresAt', 'graceEndsAt', 'riskPositionKey', 'closeReason', 'closeQueryId', 'closeRequester', 'premiumFinal', 'exitNativeEscrow']) {
  assert.ok(field in coverPolicyProps);
}
for (const retired of ['clmmFactory', 'clmmPoolHashHigh', 'clmmPoolHashLow', 'marketKind', 'kindConfig']) {
  assert.equal(JSON.stringify(spec).includes(retired), false, `${retired} must remain outside the first-release OpenAPI surface`);
}
const serviceInfoProps =
  spec.components?.schemas?.ServiceInfoResponse?.properties ??
  ({} as Record<string, { enum?: string[] }>);
assert.equal(serviceInfoProps.serviceId?.enum?.[0], 'ti.soramitsu.io');
assert.equal(serviceInfoProps.ecosystem?.enum?.[0], 'ton');
const healthProps =
  spec.components?.schemas?.HealthStatus?.properties ??
  ({} as Record<string, { enum?: string[] }>);
assert.equal(healthProps.serviceId?.enum?.[0], 'ti.soramitsu.io');
assert.equal(healthProps.ecosystem?.enum?.[0], 'ton');

console.log('openapi ok');
