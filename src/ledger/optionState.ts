import { Cell, Dictionary, type Slice } from "@ton/core";
const end = (s: Slice) => {
  if (s.remainingBits || s.remainingRefs)
    throw Error("Unsupported option factory state");
};
const value = {
  serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
  parse: (s: Slice) => {
    const c = s.asCell();
    s.skip(s.remainingBits);
    while (s.remainingRefs) s.loadRef();
    return c;
  },
};
/** Current factory.tolk StorageData -> PositionMapPersisted -> PositionData.
 * This reads immutable transaction boundaries, never the mutable latest getter. */
export function readOptionPositionState(
  boc: string,
  seriesId: string,
  positionId: string,
) {
  const data = Cell.fromBase64(boc),
    s = data.beginParse();
  if (s.remainingBits || s.remainingRefs !== 3)
    throw Error("Option factory storage layout");
  s.loadRef();
  s.loadRef();
  const positions = s.loadRef().beginParse();
  end(s);
  const dict = positions.loadDict(Dictionary.Keys.BigUint(128), value);
  end(positions);
  const key = (BigInt(seriesId) << 64n) | BigInt(positionId),
    cell = dict.get(key);
  if (!cell) return null;
  const p = cell.beginParse(),
    owner = p.loadAddress().toRawString(),
    sourceWallet = p.loadAddress().toRawString(),
    notionalRaw = p.loadCoins().toString(),
    premiumRaw = p.loadCoins().toString(),
    collateralRaw = p.loadCoins().toString(),
    settlementPayoutRaw = p.loadCoins().toString(),
    settlementReady = p.loadBoolean(),
    settled = p.loadBoolean(),
    buyStateRaw = p.loadUint(16).toString(),
    m = p.loadRef().beginParse();
  end(p);
  const refundOwner = m.loadAddress().toRawString(),
    seriesWireId = m.loadUintBig(64).toString(),
    custodyWireId = m.loadUintBig(64).toString(),
    refundWireId = m.loadUintBig(64).toString(),
    protocolFeeRaw = m.loadCoins().toString(),
    excessRaw = m.loadCoins().toString(),
    walletFundingRaw = m.loadCoins().toString();
  end(m);
  return {
    owner,
    sourceWallet,
    notionalRaw,
    premiumRaw,
    collateralRaw,
    settlementPayoutRaw,
    settlementReady,
    settled,
    buyStateRaw,
    refundOwner,
    seriesWireId,
    custodyWireId,
    refundWireId,
    protocolFeeRaw,
    excessRaw,
    walletFundingRaw,
    dataHash: data.hash().toString("hex"),
  };
}
