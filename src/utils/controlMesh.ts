import type { TupleItem } from '@ton/core';

/** Exact current 37-field getter; a missing four-market decision tail is not healthy zero. */
export function decodeControlMeshSnapshot(stack: TupleItem[]) {
  if (stack.length !== 37) return null;
  try {
    const address = stack[0];
    if (address.type !== 'slice' && address.type !== 'cell') return null;
    const cursor = address.cell.beginParse(), governance = cursor.loadAddress().toRawString();
    cursor.endParse();
    const values = stack.slice(1).map((item, offset) => {
      if (item.type !== 'int') throw new Error('Invalid Mesh scalar.');
      const index = offset + 1, value = item.value;
      const min = index <= 4 ? 0n : -0x80000000n;
      const max = index <= 2 ? 1n : index === 3 ? 0xffffffffn : index === 4 ? 0x7fffffffffffffffn : 0x7fffffffn;
      if (value < min || value > max) throw new Error('Invalid Mesh scalar range.');
      return value;
    });
    return { governance, enabled: values[0] === 1n, withdrawalsOnly: values[1] === 1n,
      sequence: values[2].toString(), lastHeartbeatTs: values[3].toString(),
      pegMintFeeBps: values[4].toString(), pegRedeemFeeBps: values[5].toString(),
      pegQuotaBps: values[6].toString(), pegThrottleBps: values[7].toString(),
      pegHaircutBps: values[8].toString(), pegLevel: values[9].toString(),
      pegEscalationScore: values[10].toString(), pegRecoveryScore: values[11].toString(),
      gasPegSkimBps: values[12].toString(), gasPegIntegral: values[13].toString(),
      gasPerpsSkimBps: values[14].toString(), gasPerpsIntegral: values[15].toString(),
      gasOptionsSkimBps: values[16].toString(), gasOptionsIntegral: values[17].toString(),
      perpsMarket1WeightMillibps: values[18].toString(), perpsMarket1FeeDeltaBps: values[19].toString(),
      perpsMarket1FundingCapBps: values[20].toString(), perpsMarket2WeightMillibps: values[21].toString(),
      perpsMarket2FeeDeltaBps: values[22].toString(), perpsMarket2FundingCapBps: values[23].toString(),
      perpsMarket3WeightMillibps: values[24].toString(), perpsMarket3FeeDeltaBps: values[25].toString(),
      perpsMarket3FundingCapBps: values[26].toString(), perpsMarket4WeightMillibps: values[27].toString(),
      perpsMarket4FeeDeltaBps: values[28].toString(), perpsMarket4FundingCapBps: values[29].toString(),
      insuranceTonPremiumBps: values[30].toString(), insuranceTonTarget: values[31].toString(),
      insuranceTonCover: values[32].toString(), insuranceBtcPremiumBps: values[33].toString(),
      insuranceBtcTarget: values[34].toString(), insuranceBtcCover: values[35].toString() };
  } catch { return null; }
}
