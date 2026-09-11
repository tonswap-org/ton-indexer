import { Cell } from '@ton/core';

/** Current contracts/governance/voting.tolk StoragePersisted. Unsupported layouts fail closed. */
export function governanceProposalRange(dataBoc: string | null | undefined): { nextProposalId: bigint; dataHash: string } | null {
  if (!dataBoc) return null;
  try {
    const data = Cell.fromBase64(dataBoc); const slice = data.beginParse();
    if (slice.remainingRefs !== 4) return null;
    slice.loadRef(); // registry
    slice.skip(4 * 64 + 4 * 16); // GovernanceConfig durations and basis points
    slice.loadRef(); // addresses
    slice.loadCoins(); slice.loadCoins(); // totalLocked, totalWeight
    const nextProposalId = slice.loadUintBig(64);
    slice.loadRef(); slice.loadRef(); // maps, bounces
    if (slice.remainingBits || slice.remainingRefs || nextProposalId < 1n) return null;
    return { nextProposalId, dataHash: data.hash().toString('hex') };
  } catch { return null; }
}
