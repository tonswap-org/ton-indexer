import assert from 'node:assert/strict';
import { beginCell, Dictionary, type Cell } from '@ton/core';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseJettonMetadata } from '../utils/jettonMetadata';

const offchainCell = beginCell().storeUint(0x01, 8).storeStringTail('https://example.com/meta.json').endCell();
const offchain = parseJettonMetadata(offchainCell);
assert.equal(offchain.uri, 'https://example.com/meta.json');

const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
const keySymbol = createHash('sha256').update('symbol').digest();
const keyDecimals = createHash('sha256').update('decimals').digest();
const symbolCell = beginCell().storeUint(0, 8).storeStringTail('TST').endCell();
const decimalsCell = beginCell().storeUint(0, 8).storeStringTail('9').endCell();

dict.set(keySymbol, symbolCell);
dict.set(keyDecimals, decimalsCell);

const onchainCell = beginCell().storeUint(0x00, 8).storeDict(dict).endCell();
const onchain = parseJettonMetadata(onchainCell);
assert.equal(onchain.symbol, 'TST');
assert.equal(onchain.decimals, 9);
const metadataValue = (cell: Cell) =>
  beginCell().storeUint(0, 8).storeDict(Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell()).set(keySymbol, cell)).endCell();
assert.deepEqual(parseJettonMetadata(metadataValue(beginCell().storeStringTail('TST').endCell())), {}, 'unprefixed legacy value is not TEP-64');
assert.deepEqual(parseJettonMetadata(metadataValue(beginCell().storeUint(1, 8).storeStringTail('TST').endCell())), {}, 'unknown/chunked format is not guessed');
assert.deepEqual(parseJettonMetadata(metadataValue(beginCell().storeUint(0, 8).storeStringTail('T\0ST').endCell())), {}, 'embedded NUL remains invalid optional text');
assert.equal(parseJettonMetadata(metadataValue(beginCell().storeUint(0, 8).storeStringTail('T').storeRef(beginCell().storeStringTail('3').endCell()).endCell())).symbol, 'T3');
const testPostgresMetadata = async () => {
  const db = new PGlite();
  try {
    await assert.rejects(() => db.query('SELECT $1::jsonb', [JSON.stringify({ symbol: '\0T3' })]), /Unicode escape|converted to text/);
    const parsed = parseJettonMetadata(metadataValue(beginCell().storeUint(0, 8).storeStringTail('T3').endCell()));
    assert.equal(parsed.symbol, 'T3');
    await db.query('SELECT $1::jsonb', [JSON.stringify(parsed)]);
  } finally { await db.close(); }
};

testPostgresMetadata()
  .then(() => console.log('metadata ok'))
  .catch((error) => {
    console.error('metadata test failed', error);
    process.exit(1);
  });
