import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { buildOpenApi } from '../api/openapi';

const spec = buildOpenApi(loadConfig());
assert.equal(spec.openapi, '3.0.3');
assert.ok(spec.paths['/api/indexer/v1/health']);
assert.ok(spec.paths['/api/indexer/v1/contracts']);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/txs']);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/swaps']);
assert.ok(spec.paths['/api/indexer/v1/perps/{engine}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/governance/{voting}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/farms/{factory}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/cover/{manager}/snapshot']);
assert.ok(spec.paths['/api/indexer/v1/openapi.json']);
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
assert.ok(spec.components?.schemas?.SwapExecutionEntry);
assert.ok(spec.components?.schemas?.SwapsSummary);
assert.ok(spec.components?.schemas?.TwapRunSummaryEntry);
assert.ok(spec.components?.schemas?.PendingLimitOrderEntry);

console.log('openapi ok');
