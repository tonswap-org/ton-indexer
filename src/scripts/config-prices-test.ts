import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cell, Dictionary, beginCell, type DictionaryValue } from '@ton/core';
import { currentJettonConfigPrices } from '../data/configPrices';

const row = (since: number, bit = 1n, cell = 500n) => beginCell().storeUint(0xcc, 8).storeUint(since, 32)
  .storeUint(bit, 64).storeUint(cell, 64).storeUint(999, 64).storeUint(9999, 64).endCell();
const inline: DictionaryValue<Cell> = { serialize: (value, builder) => builder.storeSlice(value.beginParse()), parse: slice => slice.asCell() };
function config(rows = [row(0), row(100, 2n, 600n), row(200, 3n, 700n)], tag = 0xde) {
  const storage = Dictionary.empty(Dictionary.Keys.Uint(32), inline);
  rows.forEach((value, key) => storage.set(key, value));
  const params = Dictionary.empty(Dictionary.Keys.Int(32), Dictionary.Values.Cell());
  params.set(18, beginCell().storeDictDirect(storage).endCell());
  const gas = beginCell().storeUint(0xd1, 8).storeUint(100, 64).storeUint(1000, 64).storeUint(tag, 8)
    .storeUint(18446744073709551615n, 64);
  for (let i = 0; i < (tag === 0xde ? 6 : 5); i++) gas.storeUint(i + 1, 64);
  params.set(21, gas.endCell());
  params.set(25, beginCell().storeUint(0xea, 8).storeUint(400000, 64).storeUint(26214400, 64)
    .storeUint(2621440000, 64).storeUint(0, 32).storeUint(21845, 16).storeUint(21845, 16).endCell());
  return params;
}
const encode = (params: ReturnType<typeof config>) => beginCell().storeDictDirect(params).endCell().toBoc().toString('base64');
let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }
check('exact basechain shape and uint64 decimal preservation', () => {
  assert.deepEqual(currentJettonConfigPrices(encode(config()), 100), {
    gas: { flatGasPrice: '1000', flatLimit: '100', other: { gasPrice: '18446744073709551615' } },
    forward: { lumpPrice: '400000', bitPrice: '26214400', cellPrice: '2621440000' },
    storage: { bit_price_ps: '2', cell_price_ps: '600' },
  });
});
check('chain time selects only active schedule; both native gas tags are supported', () => {
  assert.equal(currentJettonConfigPrices(encode(config()), 99).storage.bit_price_ps, '1');
  assert.equal(currentJettonConfigPrices(encode(config()), 200).storage.bit_price_ps, '3');
  assert.equal(currentJettonConfigPrices(encode(config(undefined, 0xdd)), 0).gas.other.gasPrice, '18446744073709551615');
  assert.throws(() => currentJettonConfigPrices(encode(config([row(100)])), 99), /No config storage/);
});
check('missing/truncated/unknown/trailing parameters and ambiguous schedule fail closed', () => {
  for (const id of [18, 21, 25]) {
    const missing = config(); missing.delete(id); assert.throws(() => currentJettonConfigPrices(encode(missing), 100));
    const malformed = config(); malformed.set(id, Cell.EMPTY); assert.throws(() => currentJettonConfigPrices(encode(malformed), 100));
    const trailing = config(); trailing.set(id, beginCell().storeSlice(trailing.get(id)!.beginParse()).storeBit(true).endCell());
    assert.throws(() => currentJettonConfigPrices(encode(trailing), 100));
  }
  assert.throws(() => currentJettonConfigPrices(encode(config([row(0), row(0, 2n)])), 100));
  for (const time of [-1, 0.5, NaN, 2 ** 32]) assert.throws(() => currentJettonConfigPrices(encode(config()), time));
});
check('retained native config decodes without substituting defaults', () => {
  const bytes = readFileSync(join(__dirname, 'fixtures/perps-intermediate-state/config.boc'));
  const prices = currentJettonConfigPrices(bytes.toString('base64'), 2_000_000_000);
  assert.ok(BigInt(prices.gas.other.gasPrice) > 0n);
  assert.ok(BigInt(prices.forward.cellPrice) > 0n);
  assert.ok(BigInt(prices.storage.cell_price_ps) > 0n);
});
console.log(`Config prices checks passed: ${checks}`);
