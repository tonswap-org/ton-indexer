import { Address, TupleReader, beginCell, type TupleItem } from '@ton/core';

type GetterResult = { exitCode: number; stack: TupleItem[] } | null;
type Getter = (method: string, args: TupleItem[]) => Promise<GetterResult>;
export type DlmmFarmSnapshotOptions = { owner?: string; startId?: string; limit?: number };
export type DlmmFarmCampaign = {
  id: string; sponsor: string; binId: number; rewardSide: 0 | 1;
  totalReward: string; startTime: string; endTime: string; totalStaked: string;
  allocatedReward: string; claimedReward: string; refundedReward: string; cancelledAt: string;
  user: { shares: string; claimable: string; claimed: string; lastSettlementId: string } | null;
};
export type DlmmFarmSnapshot = {
  pool: string; owner: string | null;
  config: { version: 1; nextCampaignId: string; maxDuration: string; escrowT: string; escrowX: string };
  start_id: string; next_start_id: string | null; campaigns: DlmmFarmCampaign[];
};

function reader(result: GetterResult, size: number, name: string): TupleReader {
  if (!result || result.exitCode !== 0 || result.stack.length !== size) {
    throw new Error(`Native DLMM farming ${name} is unavailable or malformed.`);
  }
  return new TupleReader(result.stack);
}
function uint(value: bigint, bits: number, label: string): bigint {
  if (value < 0n || value >= (1n << BigInt(bits))) throw new Error(`Invalid farming ${label}.`);
  return value;
}
function readUint(stack: TupleReader, bits: number, label: string): bigint {
  return uint(stack.readBigNumber(), bits, label);
}
export function parseFarmStartId(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error('Invalid campaign start ID.');
  return uint(BigInt(value), 64, 'start ID');
}

/** Current on-chain observations; payout commitments are not delivery receipts. */
export async function readDlmmFarmSnapshot(poolAddress: string, options: DlmmFarmSnapshotOptions, get: Getter): Promise<DlmmFarmSnapshot> {
  const pool = Address.parse(poolAddress).toRawString();
  const owner = options.owner ? Address.parse(options.owner).toRawString() : null;
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Campaign page size must be between 1 and 64.');
  const requestedStart = parseFarmStartId(options.startId);
  const configStack = reader(await get('farm_config', []), 5, 'configuration');
  if (readUint(configStack, 32, 'version') !== 1n) throw new Error('Unsupported native DLMM farming version.');
  const next = readUint(configStack, 64, 'next campaign ID');
  const maxDuration = readUint(configStack, 32, 'maximum duration');
  const escrowT = readUint(configStack, 120, 'T3 escrow');
  const escrowX = readUint(configStack, 120, 'paired token escrow');
  if (next < 1n || maxDuration === 0n) throw new Error('Invalid native DLMM farming configuration.');
  const start = requestedStart ?? (next > BigInt(limit) ? next - BigInt(limit) : 1n);
  if (start > next) throw new Error('Campaign start ID exceeds the current range.');
  const end = start + BigInt(limit) < next ? start + BigInt(limit) : next;
  const campaigns: DlmmFarmCampaign[] = [];
  const ownerArg: TupleItem | null = owner ? { type: 'slice', cell: beginCell().storeAddress(Address.parse(owner)).endCell() } : null;
  // Bound source concurrency independently of the requested page size.
  for (let batchStart = start; batchStart < end; batchStart += 4n) {
    const ids: bigint[] = [];
    for (let id = batchStart; id < end && id < batchStart + 4n; id++) ids.push(id);
    campaigns.push(...await Promise.all(ids.map(async id => {
      const arg: TupleItem = { type: 'int', value: id };
      const [campaignResult, userResult] = await Promise.all([
        get('farm_campaign', [arg]), ownerArg ? get('farm_user', [arg, ownerArg]) : Promise.resolve(null)
      ]);
      const s = reader(campaignResult, 12, 'campaign');
      if (s.readBigNumber() !== 1n) throw new Error('Declared campaign is missing; page is incomplete.');
      const sponsor = s.readAddress().toRawString();
      const bin = s.readBigNumber();
      if (bin < -200000n || bin > 200000n) throw new Error('Invalid farming bin.');
      const side = readUint(s, 1, 'reward side');
      const total = readUint(s, 120, 'reward budget');
      const starts = readUint(s, 64, 'start time');
      const ends = readUint(s, 64, 'end time');
      const staked = readUint(s, 256, 'staked shares');
      const allocated = readUint(s, 120, 'allocated rewards');
      const claimed = readUint(s, 120, 'committed payouts');
      const refunded = readUint(s, 120, 'refunded rewards');
      const cancelled = readUint(s, 64, 'cancellation time');
      if (total === 0n || ends <= starts || ends - starts > maxDuration || allocated > total || claimed > allocated || claimed + refunded > total) {
        throw new Error('Invalid native DLMM campaign accounting.');
      }
      let user: DlmmFarmCampaign['user'] = null;
      if (ownerArg) {
        const u = reader(userResult, 4, 'owner position');
        const shares = readUint(u, 256, 'owner shares');
        const claimable = readUint(u, 120, 'claimable rewards');
        const userClaimed = readUint(u, 120, 'owner committed payouts');
        const settlement = readUint(u, 64, 'last settlement ID');
        user = { shares: shares.toString(), claimable: claimable.toString(), claimed: userClaimed.toString(), lastSettlementId: settlement.toString() };
      }
      return { id: id.toString(), sponsor, binId: Number(bin), rewardSide: Number(side) as 0 | 1,
        totalReward: total.toString(), startTime: starts.toString(), endTime: ends.toString(), totalStaked: staked.toString(),
        allocatedReward: allocated.toString(), claimedReward: claimed.toString(), refundedReward: refunded.toString(), cancelledAt: cancelled.toString(), user };
    })));
  }
  return { pool, owner, config: { version: 1, nextCampaignId: next.toString(), maxDuration: maxDuration.toString(), escrowT: escrowT.toString(), escrowX: escrowX.toString() },
    start_id: start.toString(), next_start_id: end < next ? end.toString() : null, campaigns };
}
