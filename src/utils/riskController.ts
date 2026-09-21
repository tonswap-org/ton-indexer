import { TupleItem } from '@ton/core';

export type RiskControllerSnapshot = {
  governance: string; enabled: boolean; posture: number; postureEnteredAt: string;
  paramsVersion: number; paramsHash: string; sourceVersion: number; sourceCount: number;
  policyCount: number; totalGrossBudget: string; controlMesh: string | null; controlReportSeq: number;
  gri: number; presentMask: number; staleMask: number; acuteMask: number; admissionFlags: number;
  validUntil: string; automationWeightEffective: number; moduleScores: number[];
};

/** Decode only the current scalar-source RC ABI. A historical or malformed
 * tuple is unavailable; it must not appear as zero risk in system health. */
export function decodeRiskControllerSnapshot(stack: TupleItem[]): RiskControllerSnapshot | null {
  if (stack.length !== 20) return null;
  try {
    const uint = (index: number, max = 0xffffffffn) => {
      const item = stack[index];
      if (item?.type !== 'int' || item.value < 0n || item.value > max) throw new Error('Invalid risk controller integer');
      return item.value;
    };
    const address = (index: number, optional = false) => {
      const item = stack[index];
      if (item?.type !== 'slice' && item?.type !== 'cell') throw new Error('Invalid risk controller address');
      const s = item.cell.beginParse(), value = optional ? s.loadMaybeAddress() : s.loadAddress();
      s.endParse(); return value?.toRawString() ?? null;
    };
    const scoresItem = stack[19];
    if (scoresItem?.type !== 'cell' || scoresItem.cell.bits.length !== 384 || scoresItem.cell.refs.length !== 0) return null;
    const scores = scoresItem.cell.beginParse();
    const moduleScores = Array.from({ length: 12 }, () => scores.loadUint(32));
    if (moduleScores.some(score => score > 1_000_000)) return null;
    return {
      governance: address(0)!, enabled: uint(1, 1n) === 1n, posture: Number(uint(2, 4n)),
      postureEnteredAt: uint(3, 0x7fffffffffffffffn).toString(), paramsVersion: Number(uint(4)),
      paramsHash: uint(5, (1n << 256n) - 1n).toString(), sourceVersion: Number(uint(6)),
      sourceCount: Number(uint(7, 32n)), policyCount: Number(uint(8, 32n)),
      totalGrossBudget: uint(9, 52_500_000_000n).toString(), controlMesh: address(10, true),
      controlReportSeq: Number(uint(11)), gri: Number(uint(12, 1_000_000n)),
      presentMask: Number(uint(13, 0xfffn)), staleMask: Number(uint(14, 0xfffn)), acuteMask: Number(uint(15, 0xfffn)),
      admissionFlags: Number(uint(16, 7n)), validUntil: uint(17, 0x7fffffffffffffffn).toString(),
      automationWeightEffective: Number(uint(18, 1_000_000n)), moduleScores
    };
  } catch { return null; }
}
