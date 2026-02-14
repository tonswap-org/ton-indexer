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

const SWAP_EXECUTION_QUERY_MAGIC = 0xd2n;
const SWAP_EXECUTION_QUERY_MAGIC_V1 = 0xd1n;
const SWAP_EXECUTION_MODE_TWAP = 2n;
const SWAP_TOKEN_CODE_TON = 1n;
const SWAP_TOKEN_CODE_T3 = 2n;

const encodeSwapExecutionQueryId = (params: {
  mode: bigint;
  twapSlice?: number;
  twapTotal?: number;
  payTokenCode?: bigint;
  receiveTokenCode?: bigint;
}) => {
  const sequence = 7777n;
  const nonce = 9n;
  const slice = BigInt(Math.max(0, Math.min(31, Math.trunc(params.twapSlice ?? 0))));
  const total = BigInt(Math.max(0, Math.min(31, Math.trunc(params.twapTotal ?? 0))));
  const payTokenCode = params.payTokenCode ?? 0n;
  const receiveTokenCode = params.receiveTokenCode ?? 0n;
  return (
    (SWAP_EXECUTION_QUERY_MAGIC << 56n) |
    ((params.mode & 0x03n) << 54n) |
    ((slice & 0x1fn) << 49n) |
    ((total & 0x1fn) << 44n) |
    ((payTokenCode & 0x3fn) << 38n) |
    ((receiveTokenCode & 0x3fn) << 32n) |
    ((sequence & 0xffffffn) << 8n) |
    (nonce & 0xffn)
  );
};

const encodeSwapExecutionQueryIdV1 = (params: { mode: bigint; twapSlice?: number; twapTotal?: number }) => {
  const secondsSinceEpoch = 7777n;
  const nonce = 9n;
  const slice = BigInt(Math.max(0, Math.min(255, Math.trunc(params.twapSlice ?? 0))));
  const total = BigInt(Math.max(0, Math.min(255, Math.trunc(params.twapTotal ?? 0))));
  return (
    (SWAP_EXECUTION_QUERY_MAGIC_V1 << 56n) |
    ((params.mode & 0x03n) << 54n) |
    ((slice & 0xffn) << 46n) |
    ((total & 0xffn) << 38n) |
    ((secondsSinceEpoch & 0x7fffffffn) << 7n) |
    (nonce & 0x7fn)
  );
};

const makeJettonTransferWithSwapForwardBodyBase64 = (queryId: bigint) => {
  const dest = Address.parseRaw(`0:${'a'.repeat(64)}`);
  const response = Address.parseRaw(`0:${'b'.repeat(64)}`);
  const swapRecipient = Address.parseRaw(`0:${'c'.repeat(64)}`);
  const swapForward = beginCell()
    .storeUint(0x53574150, 32)
    .storeUint(queryId, 64)
    .storeAddress(swapRecipient)
    .storeCoins(456n)
    .storeUint(1, 8)
    .storeAddress(null)
    .storeRef(beginCell().endCell())
    .storeCoins(0n)
    .storeCoins(0n)
    .storeRef(beginCell().endCell())
    .endCell();
  const cell = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(queryId, 64)
    .storeCoins(789n)
    .storeAddress(dest)
    .storeAddress(response)
    .storeRef(beginCell().endCell())
    .storeCoins(0n)
    .storeRef(swapForward)
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

const twapQueryId = encodeSwapExecutionQueryId({
  mode: SWAP_EXECUTION_MODE_TWAP,
  twapSlice: 2,
  twapTotal: 5,
  payTokenCode: SWAP_TOKEN_CODE_T3,
  receiveTokenCode: SWAP_TOKEN_CODE_TON,
});
const swapViaJettonTx: RawTransaction = {
  lt: '3',
  hash: 'ghi',
  utime: 0,
  success: true,
  inMessage: {
    source: Address.parseRaw(`0:${'7'.repeat(64)}`).toString(),
    destination: Address.parseRaw(`0:${'8'.repeat(64)}`).toString(),
    value: '0',
    op: 0x0f8a7ea5,
    body: makeJettonTransferWithSwapForwardBodyBase64(twapQueryId),
  },
  outMessages: [],
};
const swapViaJettonIndexed = classifyTransaction('0:' + '8'.repeat(64), swapViaJettonTx, opcodes);
assert.equal(swapViaJettonIndexed.kind, 'swap');
const swapViaJettonAction = swapViaJettonIndexed.actions[0];
assert.equal(swapViaJettonAction?.kind, 'swap');
if (swapViaJettonAction?.kind === 'swap') {
  assert.equal(swapViaJettonAction.executionType, 'twap');
  assert.equal(swapViaJettonAction.twapSlice, 2);
  assert.equal(swapViaJettonAction.twapTotal, 5);
  assert.equal(swapViaJettonAction.querySequence, 7777);
  assert.equal(swapViaJettonAction.queryNonce, 9);
}
assert.equal(swapViaJettonIndexed.ui.detail.kind, 'swap');
if (swapViaJettonIndexed.ui.detail.kind === 'swap') {
  assert.equal(swapViaJettonIndexed.ui.detail.executionType, 'twap');
  assert.equal(swapViaJettonIndexed.ui.detail.twapSlice, 2);
  assert.equal(swapViaJettonIndexed.ui.detail.twapTotal, 5);
  assert.equal(swapViaJettonIndexed.ui.detail.querySequence, 7777);
  assert.equal(swapViaJettonIndexed.ui.detail.queryNonce, 9);
  assert.equal(swapViaJettonIndexed.ui.detail.payToken, 'T3');
  assert.equal(swapViaJettonIndexed.ui.detail.receiveToken, 'TON');
}

const v1QueryId = encodeSwapExecutionQueryIdV1({ mode: SWAP_EXECUTION_MODE_TWAP, twapSlice: 7, twapTotal: 9 });
const swapViaJettonV1Tx: RawTransaction = {
  lt: '4',
  hash: 'jkl',
  utime: 0,
  success: true,
  inMessage: {
    source: Address.parseRaw(`0:${'9'.repeat(64)}`).toString(),
    destination: Address.parseRaw(`0:${'a'.repeat(64)}`).toString(),
    value: '0',
    op: 0x0f8a7ea5,
    body: makeJettonTransferWithSwapForwardBodyBase64(v1QueryId),
  },
  outMessages: [],
};
const swapViaJettonV1Indexed = classifyTransaction('0:' + 'a'.repeat(64), swapViaJettonV1Tx, opcodes);
assert.equal(swapViaJettonV1Indexed.kind, 'swap');
const swapViaJettonV1Action = swapViaJettonV1Indexed.actions[0];
assert.equal(swapViaJettonV1Action?.kind, 'swap');
if (swapViaJettonV1Action?.kind === 'swap') {
  assert.equal(swapViaJettonV1Action.executionType, 'twap');
  assert.equal(swapViaJettonV1Action.twapSlice, 7);
  assert.equal(swapViaJettonV1Action.twapTotal, 9);
  assert.equal(swapViaJettonV1Action.querySequence, 7777);
  assert.equal(swapViaJettonV1Action.queryNonce, 9);
}
assert.equal(swapViaJettonV1Indexed.ui.detail.kind, 'swap');
if (swapViaJettonV1Indexed.ui.detail.kind === 'swap') {
  assert.equal(swapViaJettonV1Indexed.ui.detail.executionType, 'twap');
  assert.equal(swapViaJettonV1Indexed.ui.detail.twapSlice, 7);
  assert.equal(swapViaJettonV1Indexed.ui.detail.twapTotal, 9);
  assert.equal(swapViaJettonV1Indexed.ui.detail.querySequence, 7777);
  assert.equal(swapViaJettonV1Indexed.ui.detail.queryNonce, 9);
}

console.log('classifier ok');
