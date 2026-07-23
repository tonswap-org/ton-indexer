import assert from 'node:assert/strict';
import { buildDocsHtml } from '../api/docsHtml';

const html = buildDocsHtml();
const nonceHtml = buildDocsHtml('test-nonce');
assert.ok(html.includes('TONSWAP Indexer API'));
assert.ok(html.includes('/api/indexer/v1/openapi.json'));
assert.ok(html.includes('/api/indexer/v1/contracts'));
assert.ok(html.includes('/api/indexer/v1/jettons/{jetton}/transfer/{owner}/payload'));
assert.ok(html.includes('/api/indexer/v1/accounts/{addr}/swaps'));
assert.ok(html.includes('/api/indexer/v1/perps/{addr}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/vol-index/{addr}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/governance/{voting}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/farms/{factory}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/options/{factory}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/cover/{manager}/snapshot'));
assert.equal(html.includes('<option value="/api/indexer/v1/debug">'), false);
assert.ok(html.includes('fetch('));
assert.ok(nonceHtml.includes('<style nonce="test-nonce">'));
assert.ok(nonceHtml.includes('<script nonce="test-nonce">'));

console.log('docs html ok');
