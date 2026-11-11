import assert from 'node:assert/strict';
import { Address, beginCell, Cell } from '@ton/core';
import { decodeCurrentProtocolBody, type CurrentProtocolRole } from '../ledger/currentProtocolEvents';
import { encodeSwapEvent } from '../ledger/currentDlmmState';

const owner = Address.parse(`0:${'1'.repeat(64)}`), amount = (1n << 100n) + 19n;
type Vector = [CurrentProtocolRole, 'external-log' | 'successful-call', string, Cell, Record<string, unknown>];
const vectors: Vector[] = [
  ['DlmmPool', 'external-log', 'pool-swap', encodeSwapEvent({ queryId: 9n, origin: owner, inSide: 1, status: 0, reason: 0,
    amountIn: amount, amountOut: amount-1n, grossFeeT3: 20n, protocolFeeT3: 10n, activeBin: -3, binsLoaded: 1 }),
    { queryId: '9', origin: owner.toRawString(), amountInRaw: String(amount), activeBin: -3 }],
  ['Governance', 'external-log', 'governance-handoff', beginCell().storeUint(0x47484556,32).storeUint(1,256)
    .storeUint(2,16).storeAddress(owner).storeUint(amount,120).storeUint(amount-1n,120).storeBit(true).endCell(), { supplyBaseRaw: String(amount-1n), gated: true }],
  ['Governance', 'external-log', 'governance-proposal', beginCell().storeUint(0x47504556,32).storeUint(1,8)
    .storeUint(0xfffffffe,32).storeUint(2,2).storeAddress(owner).storeUint(123,32).storeUint(1,256).endCell(), { id: 0xfffffffe, class: 2 }],
  ['Governance', 'external-log', 'governance-vote', beginCell().storeUint(0x47564556,32).storeUint(9,32)
    .storeAddress(owner).storeUint(1,2).storeCoins(amount).storeUint(amount*3n,122).endCell(), { quorumPrincipalRaw: String(amount), voteWeightRaw: String(amount*3n) }],
  ['Governance', 'external-log', 'governance-lock', beginCell().storeUint(0x474c4556,32).storeUint(1,8)
    .storeAddress(owner).storeCoins(amount).storeUint(123,32).storeUint(456,32).endCell(), { amountRaw: String(amount), commitUntil: 123 }],
  ['GenesisDistributor', 'external-log', 'genesis-dispatch', beginCell().storeUint(0x474e4556,32)
    .storeAddress(owner).storeAddress(owner).storeAddress(owner).storeUint(amount,120).endCell(), { totalRaw: String(amount) }],
  ['MerkleClaim', 'external-log', 'merkle-claim', beginCell().storeUint(0x4d434556,32).storeUint(1,8)
    .storeUint(9,32).storeAddress(owner).storeUint(amount,120).endCell(), { index: 9, amountRaw: String(amount) }],
  ['Remint', 'external-log', 'remint-accounting', beginCell().storeUint(0x524d4556,32).storeUint(1,8)
    .storeUint(9,32).storeCoins(amount).storeUint(200,16).endCell(), { day: 9, rateBps: 200 }],
  ['Treasury', 'external-log', 'treasury-dispatch', beginCell().storeUint(0x54504556,32).storeUint(1,8)
    .storeUint(2,8).storeCoins(amount).storeAddress(owner).endCell(), { slot: 2, amountRaw: String(amount) }],
  ['SwapCoordinator', 'external-log', 'route-continuation', beginCell().storeUint(0x52544533,32).storeUint(9,64)
    .storeUint(1,8).storeUint(2,8).storeCoins(amount).storeAddress(null).storeAddress(owner).endCell(), { queryId: '9', pool: null, amountRaw: String(amount) }],
  ['BuybackExecutor', 'external-log', 'buyback-dispatch', beginCell().storeUint(0x42424556,32).storeUint(9,64)
    .storeCoins(amount).storeCoins(amount-1n).storeUint(amount,128).endCell(), { minOutRaw: String(amount-1n), referencePriceE9: String(amount) }],
  ['Treasury', 'external-log', 'owed-accounting', beginCell().storeUint(0x4a4f5743,32).storeUint(1,8)
    .storeAddress(owner).storeCoins(amount).storeUint(9,8).endCell(), { slot: 1, reason: 9 }],
  ['Treasury', 'external-log', 'owed-archived', beginCell().storeUint(0x4a415243,32).storeUint(1,8)
    .storeUint(9,64).storeAddress(owner).storeCoins(amount).endCell(), { id: '9' }],
  ['GasVault', 'successful-call', 'gas-tick-call', beginCell().storeUint(0x4756544b,32).storeUint(9,64).storeUint(7,32).endCell(), { queryId: '9', jobId: 7 }],
  ['FeeRouter', 'successful-call', 'fee-flush-call', beginCell().storeUint(0x4652464c,32).storeUint(9,64).endCell(), { queryId: '9' }],
  ['ReferralRegistry', 'successful-call', 'referral-link', beginCell().storeUint(0x52524c4b,32).storeUint(9,64).storeAddress(owner).endCell(), { sponsor: owner.toRawString() }],
  ['Treasury', 'successful-call', 'owed-claim-call', beginCell().storeUint(0x434c4d4a,32).storeUint(9,64).storeUint(1,8).storeAddress(owner).endCell(), { owner: owner.toRawString(), slot: 1 }],
];
for (const [role, source, name, body, expected] of vectors) {
  const decoded = decodeCurrentProtocolBody(role, body, source);
  assert.equal(decoded?.name, name);
  for (const [field,value] of Object.entries(expected)) assert.equal(decoded?.fields[field], value, `${name}.${field}`);
  assert.equal(decodeCurrentProtocolBody(role, body, source === 'external-log' ? 'successful-call' : 'external-log'), null);
  assert.equal(decodeCurrentProtocolBody('USDT', body, source), null);
  assert.equal(decodeCurrentProtocolBody(role, beginCell().storeSlice(body.beginParse()).storeBit(false).endCell(), source), null);
  assert.equal(decodeCurrentProtocolBody(role, beginCell().storeSlice(body.beginParse()).storeRef(Cell.EMPTY).endCell(), source), null);
  const truncated = beginCell().storeBits(body.bits.substring(0, body.bits.length-1)).endCell();
  assert.equal(decodeCurrentProtocolBody(role, truncated, source), null);
}
assert.equal(decodeCurrentProtocolBody('Governance', Cell.EMPTY, 'external-log'), null);
console.log(`Current protocol wire: ${vectors.length} exact layouts, atomic amounts, wrong-role/source/trailing/truncation refusals passed.`);
