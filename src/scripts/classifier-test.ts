import assert from 'node:assert/strict';
import { Address, beginCell } from '@ton/core';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { RawTransaction } from '../data/dataSource';

const makeBodyBase64 = () => {
  const dest = Address.parseRaw(`0:${'1'.repeat(64)}`);
  const resp = Address.parseRaw(`0:${'2'.repeat(64)}`);
  const cell = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(0n, 64)
    .storeCoins(123n)
    .storeAddress(dest)
    .storeAddress(resp)
    .endCell();
  return cell.toBoc({ idx: false }).toString('base64');
};

const opcodes = loadOpcodes(undefined);
const body = makeBodyBase64();
const swapBody = beginCell()
  .storeUint(0x53574150, 32)
  .storeUint(0n, 64)
  .storeUint(1, 8)
  .storeCoins(100n)
  .storeCoins(90n)
  .endCell()
  .toBoc({ idx: false })
  .toString('base64');

const tx: RawTransaction = {
  lt: '1',
  hash: 'abc',
  utime: 0,
  success: true,
  inMessage: {
    source: Address.parseRaw(`0:${'3'.repeat(64)}`).toString(),
    destination: Address.parseRaw(`0:${'4'.repeat(64)}`).toString(),
    value: '0',
    op: 0x0f8a7ea5,
    body,
  },
  outMessages: [],
};

const indexed = classifyTransaction('0:' + '4'.repeat(64), tx, opcodes);
assert.equal(indexed.kind, 'transfer');
assert.equal(indexed.actions[0]?.kind, 'transfer');
assert.equal(indexed.actions[0]?.amount, '123');

const swapTx: RawTransaction = {
  lt: '2',
  hash: 'def',
  utime: 0,
  success: true,
  inMessage: {
    source: Address.parseRaw(`0:${'5'.repeat(64)}`).toString(),
    destination: Address.parseRaw(`0:${'6'.repeat(64)}`).toString(),
    value: '0',
    op: 0x53574150,
    body: swapBody,
  },
  outMessages: [],
};

const swapIndexed = classifyTransaction('0:' + '6'.repeat(64), swapTx, opcodes);
assert.equal(swapIndexed.kind, 'swap');
assert.equal(swapIndexed.actions[0]?.kind, 'swap');
assert.equal(swapIndexed.actions[0]?.amountIn, '100');
assert.equal(swapIndexed.actions[0]?.minOut, '90');

console.log('classifier ok');
