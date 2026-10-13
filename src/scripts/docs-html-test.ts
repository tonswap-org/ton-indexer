import assert from 'node:assert/strict';
import { buildDocsHtml } from '../api/docsHtml';

const html = buildDocsHtml();
const nonceHtml = buildDocsHtml('test-nonce');
assert.ok(html.includes('TONSWAP Indexer API'));
assert.ok(html.includes('/api/indexer/v1/openapi.json'));
assert.ok(html.includes('/api/indexer/v1/contracts'));
assert.ok(html.includes('/api/indexer/v1/markets/spot:T3-X/candles'));
assert.ok(html.includes('/api/indexer/v1/vol-index/{addr}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/governance/{voting}/snapshot'));
assert.ok(html.includes('/api/indexer/v1/pools/{pool}/farms'));
assert.ok(html.includes('/api/indexer/v1/cover/{manager}/snapshot'));
assert.equal(html.includes('<option value="/api/indexer/v1/debug">'), false);
assert.ok(html.includes('fetch('));
assert.ok(nonceHtml.includes('<style nonce="test-nonce">'));
assert.ok(nonceHtml.includes('<script nonce="test-nonce">'));
assert.ok(html.includes('\n<html>'));
assert.equal(html.includes('\\n<html>'), false);

for (const retired of ['/balance"', '/assets', '/swaps', '/perps/', '/options/', '/defi/snapshot', '/runGetMethods', '/transfer/', '/stream"']) assert.equal(html.includes(retired), false, retired);
assert.ok(html.includes('/accounts/{addr}/balances'));
assert.ok(html.includes('/stream/balances'));
console.log('docs html ok');
