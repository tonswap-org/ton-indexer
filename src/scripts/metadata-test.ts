import assert from 'node:assert/strict';
import { beginCell, Dictionary } from '@ton/core';
import { createHash } from 'node:crypto';
import { parseJettonMetadata } from '../utils/jettonMetadata';

const offchainCell = beginCell().storeUint(0x01, 8).storeStringTail('https://example.com/meta.json').endCell();
const offchain = parseJettonMetadata(offchainCell);
assert.equal(offchain.uri, 'https://example.com/meta.json');

const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
const keySymbol = createHash('sha256').update('symbol').digest();
const keyDecimals = createHash('sha256').update('decimals').digest();
const symbolCell = beginCell().storeStringTail('TST').endCell();
const decimalsCell = beginCell().storeStringTail('9').endCell();

dict.set(keySymbol, symbolCell);
dict.set(keyDecimals, decimalsCell);

const onchainCell = beginCell().storeUint(0x00, 8).storeDict(dict).endCell();
const onchain = parseJettonMetadata(onchainCell);
assert.equal(onchain.symbol, 'TST');
assert.equal(onchain.decimals, 9);

console.log('metadata ok');
