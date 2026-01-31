import assert from 'node:assert/strict';
import { isValidAddress, isValidHashBase64, isValidLt, parsePositiveInt } from '../api/validation';

assert.equal(parsePositiveInt('10'), 10);
assert.equal(parsePositiveInt('0'), null);
assert.equal(parsePositiveInt('-1'), null);
assert.equal(parsePositiveInt('foo'), null);

assert.equal(isValidLt('123'), true);
assert.equal(isValidLt('12a'), false);

// 32-byte hash base64 (all zero)
const hash = Buffer.alloc(32, 0).toString('base64');
assert.equal(isValidHashBase64(hash), true);
assert.equal(isValidHashBase64('not-base64'), false);

// Valid TON address (raw format)
assert.equal(isValidAddress(`0:${'1'.repeat(64)}`), true);
assert.equal(isValidAddress('bad-address'), false);

console.log('validation ok');
