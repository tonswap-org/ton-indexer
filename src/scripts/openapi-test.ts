import assert from 'node:assert/strict';
import { loadConfig } from '../config';
import { buildOpenApi } from '../api/openapi';

const spec = buildOpenApi(loadConfig());
assert.equal(spec.openapi, '3.0.3');
assert.ok(spec.paths['/api/indexer/v1/health']);
assert.ok(spec.paths['/api/indexer/v1/accounts/{addr}/txs']);
assert.ok(spec.paths['/api/indexer/v1/openapi.json']);

console.log('openapi ok');
