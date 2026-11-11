import { Cell, CellType, Dictionary, type DictionaryValue } from '@ton/core';

export type JettonConfigPrices = {
  gas: { flatGasPrice: string; flatLimit: string; other: { gasPrice: string } };
  forward: { lumpPrice: string; bitPrice: string; cellPrice: string };
  storage: { bit_price_ps: string; cell_price_ps: string };
};

function assertCompleteDictionary(root: Cell, width: number): void {
  if (root.type !== CellType.Ordinary) throw new Error('Incomplete config dictionary.');
  const slice = root.beginParse(), sizeBits = Math.ceil(Math.log2(width + 1));
  let length = 0;
  if (!slice.loadBit()) {
    while (slice.loadBit()) { if (++length > width) throw new Error('Invalid config dictionary label.'); }
    slice.skip(length);
  } else if (!slice.loadBit()) {
    length = sizeBits ? slice.loadUint(sizeBits) : 0;
    if (length > width) throw new Error('Invalid config dictionary label.');
    slice.skip(length);
  } else {
    slice.loadBit(); length = sizeBits ? slice.loadUint(sizeBits) : 0;
  }
  if (length > width) throw new Error('Invalid config dictionary label.');
  if (length === width) return; // Value parsers below require exact leaf exhaustion.
  const left = slice.loadRef(), right = slice.loadRef(); slice.endParse();
  assertCompleteDictionary(left, width - length - 1);
  assertCompleteDictionary(right, width - length - 1);
}

/** Parameters 18/21/25 from the authenticated, complete ConfigParams dictionary.
 * Layouts are the native block.tlb StoragePrices/GasLimitsPrices/MsgForwardPrices. */
export function currentJettonConfigPrices(configBoc: string, unixTime: number): JettonConfigPrices {
  if (!Number.isSafeInteger(unixTime) || unixTime < 0 || unixTime > 0xffffffff) throw new Error('Invalid config chain time.');
  const roots = Cell.fromBoc(Buffer.from(configBoc, 'base64'));
  if (roots.length !== 1) throw new Error('Config must have one dictionary root.');
  assertCompleteDictionary(roots[0], 32);
  const config = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), roots[0]);
  const required = (id: number) => {
    const value = config.get(id);
    if (!value) throw new Error(`Config parameter ${id} is unavailable.`);
    return value.beginParse();
  };
  const gas = required(21);
  if (gas.loadUint(8) !== 0xd1) throw new Error('Config gas flat prefix is unavailable.');
  const flatLimit = gas.loadUintBig(64).toString(), flatGasPrice = gas.loadUintBig(64).toString();
  const gasTag = gas.loadUint(8);
  if (gasTag !== 0xdd && gasTag !== 0xde) throw new Error('Unsupported config gas prices.');
  const gasPrice = gas.loadUintBig(64).toString();
  gas.skip((gasTag === 0xde ? 6 : 5) * 64);
  gas.endParse();
  const forward = required(25);
  if (forward.loadUint(8) !== 0xea) throw new Error('Unsupported config forward prices.');
  const lumpPrice = forward.loadUintBig(64).toString(), bitPrice = forward.loadUintBig(64).toString(), cellPrice = forward.loadUintBig(64).toString();
  forward.skip(64);
  forward.endParse();
  type Storage = { since: number; bit_price_ps: string; cell_price_ps: string };
  const storageValue: DictionaryValue<Storage> = {
    serialize: () => { throw new Error('Config prices are read-only.'); },
    parse: slice => {
      if (slice.loadUint(8) !== 0xcc) throw new Error('Unsupported config storage prices.');
      const since = slice.loadUint(32), bit_price_ps = slice.loadUintBig(64).toString(), cell_price_ps = slice.loadUintBig(64).toString();
      slice.skip(128); slice.endParse();
      return { since, bit_price_ps, cell_price_ps };
    },
  };
  const scheduleRoot = config.get(18);
  if (!scheduleRoot) throw new Error('Config parameter 18 is unavailable.');
  assertCompleteDictionary(scheduleRoot, 32);
  const schedule = Dictionary.loadDirect(Dictionary.Keys.Uint(32), storageValue, scheduleRoot);
  let active: Storage | undefined;
  const times = new Set<number>();
  for (const row of schedule.values()) {
    if (times.has(row.since)) throw new Error('Ambiguous config storage schedule.');
    times.add(row.since);
    if (row.since <= unixTime && (!active || row.since > active.since)) active = row;
  }
  if (!active) throw new Error('No config storage price is active at the selected chain time.');
  return { gas: { flatGasPrice, flatLimit, other: { gasPrice } }, forward: { lumpPrice, bitPrice, cellPrice },
    storage: { bit_price_ps: active.bit_price_ps, cell_price_ps: active.cell_price_ps } };
}
