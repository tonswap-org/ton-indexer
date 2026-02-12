import assert from 'node:assert/strict';
import { buildDocsHtml } from '../api/docsHtml';

const html = buildDocsHtml();
assert.ok(html.includes('TONSWAP Indexer API'));
assert.ok(html.includes('/api/indexer/v1/openapi.json'));
assert.ok(html.includes('/api/indexer/v1/contracts'));
assert.ok(html.includes('/api/indexer/v1/perps/{addr}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/governance/{voting}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/farms/{factory}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/cover/{manager}/snapshot'));
assert.ok(html.includes('fetch('));

console.log('docs html ok');
