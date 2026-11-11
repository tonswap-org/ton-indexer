import assert from "node:assert/strict";
import { Address, beginCell, Cell, Dictionary } from "@ton/core";
import { readOptionPositionState } from "../ledger/optionState";

// The current factory.tolk PositionData/OptionBuyMeta wire. These are codec
// regression cells, not native-execution or physical-cash qualification.
const owner = Address.parse(`0:${"a".repeat(64)}`),
  wallet = Address.parse(`0:${"b".repeat(64)}`),
  seriesId = (1n << 64n) - 2n,
  positionId = (1n << 64n) - 1n,
  key = (seriesId << 64n) | positionId;
const inline = {
  serialize: (cell: Cell, builder: any) => builder.storeSlice(cell.beginParse()),
  parse: (slice: any) => slice.asCell(),
};
const prefix = () => beginCell()
  .storeAddress(owner)
  .storeUint(11, 64)
  .storeUint(12, 64)
  .storeUint(13, 64)
  .storeCoins(14)
  .storeCoins(15)
  .storeCoins(16);
const meta = (buyFunding = 0n, referral = 0n) => prefix()
  .storeCoins(buyFunding).storeUint(referral, 64).endCell();
const position = (metadata: Cell) => beginCell()
  .storeAddress(owner)
  .storeAddress(wallet)
  .storeCoins(100)
  .storeCoins(20)
  .storeCoins(30)
  .storeCoins(40)
  .storeBit(true)
  .storeBit(false)
  .storeUint(525, 16)
  .storeRef(metadata)
  .endCell();
const storage = (cell: Cell | null, positionsTail?: Cell) => {
  const positions = Dictionary.empty(Dictionary.Keys.BigUint(128), inline);
  if (cell) positions.set(key, cell);
  const map = beginCell().storeDict(positions);
  if (positionsTail) map.storeSlice(positionsTail.beginParse());
  return beginCell().storeRef(Cell.EMPTY).storeRef(Cell.EMPTY)
    .storeRef(map.endCell()).endCell();
};
const read = (cell: Cell) => readOptionPositionState(
  cell.toBoc().toString("base64"), seriesId.toString(), positionId.toString(),
);
let passed = 0;
const check = (name: string, body: () => void) => {
  body();
  passed += 1;
  console.log(`PASS ${name}`);
};

check("mandatory zero funding and referral fields retain complete current state", () => {
  const data = storage(position(meta()));
  assert.deepEqual(read(data), {
    owner: owner.toRawString(),
    sourceWallet: wallet.toRawString(),
    notionalRaw: "100",
    premiumRaw: "20",
    collateralRaw: "30",
    settlementPayoutRaw: "40",
    settlementReady: true,
    settled: false,
    buyStateRaw: "525",
    refundOwner: owner.toRawString(),
    seriesWireId: "11",
    custodyWireId: "12",
    refundWireId: "13",
    protocolFeeRaw: "14",
    excessRaw: "15",
    walletFundingRaw: "16",
    buyFundingRaw: "0",
    referralOperationId: "0",
    dataHash: data.hash().toString("hex"),
  });
});
check("large funding and the entire uint64 referral range remain exact strings", () => {
  const funding = (1n << 116n) + 31n;
  for (const referral of [1n, (1n << 53n) + 1n, (1n << 64n) - 1n]) {
    const result = read(storage(position(meta(funding, referral))));
    assert.equal(result?.buyFundingRaw, funding.toString());
    assert.equal(result?.referralOperationId, referral.toString());
  }
});
check("absent position remains absent", () => {
  assert.equal(read(storage(null)), null);
});
check("a different full uint128 key does not alias the requested position", () => {
  const data = storage(position(meta()));
  assert.equal(readOptionPositionState(data.toBoc().toString("base64"),
    (seriesId - 1n).toString(), positionId.toString()), null);
});
for (const [name, metadata] of [
  ["obsolete metadata omitting both mandatory fields", prefix().endCell()],
  ["metadata omitting the mandatory referral", prefix().storeCoins(0).endCell()],
  ["truncated funding varuint", prefix().storeUint(1, 4).endCell()],
  ["truncated 63-bit referral", prefix().storeCoins(0).storeUint(0, 63).endCell()],
  ["trailing metadata bit", beginCell().storeSlice(meta().beginParse()).storeBit(false).endCell()],
  ["trailing metadata reference", beginCell().storeSlice(meta().beginParse()).storeRef(Cell.EMPTY).endCell()],
] as const) {
  check(`reject ${name}`, () => assert.throws(() => read(storage(position(metadata)))));
}
check("reject a missing position metadata reference", () => {
  const cell = position(meta());
  assert.throws(() => read(storage(beginCell().storeBits(cell.bits).endCell())));
});
check("reject a trailing position bit", () => {
  assert.throws(() => read(storage(beginCell().storeSlice(position(meta()).beginParse())
    .storeBit(false).endCell())));
});
check("reject a trailing position reference", () => {
  assert.throws(() => read(storage(beginCell().storeSlice(position(meta()).beginParse())
    .storeRef(Cell.EMPTY).endCell())));
});
check("reject trailing position-map data", () => {
  assert.throws(() => read(storage(position(meta()), beginCell().storeBit(false).endCell())));
});
check("reject a trailing root bit", () => {
  assert.throws(() => read(beginCell().storeSlice(storage(position(meta())).beginParse())
    .storeBit(false).endCell()));
});
console.log(`${passed} current Option position codec regression checks passed`);
