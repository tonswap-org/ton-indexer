import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { buildOpenApi } from '../api/openapi';
import { runtimeMetadataFixture } from './fixtures/runtimeManifest';

const config = loadConfig();
const spec = buildOpenApi(config, runtimeMetadataFixture(config.network));
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
assert.ok(spec.paths['/api/indexer/v1/ledger/readiness'].get.responses[503]);
assert.deepEqual(spec.components.schemas.LedgerReadiness.properties.build.required, ['sha256', 'sqlSha256']);
assert.ok(spec.components.schemas.LedgerEvent.properties.movements);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/txs'].get.responses[503]);
assert.ok(spec.paths['/api/indexer/v1/markets/{market}/candles']);
assert.ok(spec.paths['/api/indexer/v1/vol-index/{volIndex}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/governance/{voting}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/pools/{pool}/farms']);
assert.ok(spec.paths['/api/indexer/v1/cover/{manager}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/openapi.json']);
assert.equal('security' in spec.paths['/api/indexer/v1/runGetMethod'].post, false);
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
assert.ok(spec.components?.schemas?.MarketCandle);
assert.ok(spec.components?.schemas?.MarketCandlesResponse);
const assetBalanceSchema = spec.components.schemas.AssetBalanceResponse;
assert.equal(assetBalanceSchema.oneOf.length, 3);
assert.deepEqual(assetBalanceSchema.oneOf[0].properties.decimals, { const: 9 });
assert.deepEqual(assetBalanceSchema.oneOf[2].properties.balance_raw, { type: 'null' });
assert.deepEqual(spec.components.schemas.BalancesResponse.required,
  ['address', 'network', 'head_seqno', 'head_utime', 'complete', 'assets']);
assert(spec.components.schemas.FreshReadResponse.properties.readContext.properties.head.required.includes('utime'));
assert(spec.components.schemas.StateResponse.required.includes('shard_utime'));
assert(!spec.components.schemas.TonBlockId.required.includes('utime'));
assert.deepEqual(spec.components.schemas.HealthStatus.properties.disk.enum, ['ok','low','critical']);
assert.equal(spec.components.schemas.ErrorResponse.additionalProperties, false);
for (const route of Object.values(spec.paths) as any[]) for (const operation of Object.values(route) as any[]) {
  if (!operation.responses) continue;
  for (const status of [429,503,504]) assert(operation.responses[status].headers['Retry-After']);
}
for (const retired of ['/accounts/{addr}/balance','/accounts/{addr}/assets','/accounts/{addr}/swaps', '/stream',
  '/jettons/{jetton}/transfer/{owner}/payload','/perps/{engine}/snapshot','/options/{factory}/snapshot','/defi/snapshot','/runGetMethods']) {
  assert.equal(`/api/indexer/v1${retired}` in spec.paths, false, retired);
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
assert.equal(serviceInfoProps.serviceId?.enum?.[0], 'test.tonswap.org/api/indexer');
assert.equal(serviceInfoProps.ecosystem?.enum?.[0], 'ton');
const healthProps =
  spec.components?.schemas?.HealthStatus?.properties ??
  ({} as Record<string, { enum?: string[] }>);
assert.equal(healthProps.serviceId?.enum?.[0], 'test.tonswap.org/api/indexer');
assert.equal(healthProps.ecosystem?.enum?.[0], 'ton');

console.log('openapi ok');

// Every exposed current position carries the fourth counterparty coin. No
// optional field could certify a historical three-coin layout as current.
let counterpartySchemas = 0;
function checkCounterpartySchemas(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const node = value as { required?: string[]; properties?: Record<string, unknown> };
  if (Array.isArray(node.required) && node.required.includes('reservedRaw') && node.required.includes('collectedLossRaw')) {
    assert(node.required.includes('remainingEntitlementRaw'));
    assert(node.properties?.remainingEntitlementRaw);
    counterpartySchemas++;
  }
  for (const child of Object.values(value)) checkCounterpartySchemas(child);
}
checkCounterpartySchemas(spec);
assert(counterpartySchemas > 0);
