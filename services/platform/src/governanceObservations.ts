import { Cell } from '@ton/core';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Network } from './types.js';
import { DEX_PRICE_FUTURE_SKEW_MS, DEX_PRICE_MAX_AGE_MS } from './dexPrices.js';

/** Governance and its configured source belong to the same immutable release. */
export function governanceBinding(config: Config, network: Network) {
  const release = config.dexRelease;
  return release?.network === network && config.networks.includes(network) && release.governance &&
    config.indexerUrls[network] === release.indexerUrl ? { release, contract: release.governance } : null;
}

const uint32 = z.number().int().min(0).max(0xffffffff);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value => BigInt(value) <= 0xffffffffn);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const address = z.string().regex(/^0:[a-f0-9]{64}$/);
const walletAddress = z.string().regex(/^(?:-1|0):[a-f0-9]{64}$/);
const atomic = (bits: number) => z.string().regex(/^(0|[1-9][0-9]*)$/).max(40).refine(value => BigInt(value) < 1n << BigInt(bits));
const headSchema = z.object({ workchain: z.literal(-1), shard: z.literal('-9223372036854775808'),
  seqno: uint32.min(1), utime: uint32.min(1), rootHashHex: digest, fileHashHex: digest }).strict();
const proposalSchema = z.object({ id, proposer: walletAddress, class: z.number().int().min(0).max(2), queued: z.boolean(),
  slot: z.number().int().min(0).max(15), start: uint32, decidedAt: uint32,
  valueTotalRaw: atomic(120), descriptionHash: digest,
  tally: z.object({ quorumRaw: atomic(120), participationRaw: atomic(120), yesRaw: atomic(122), noRaw: atomic(122) }).strict(),
  closeAt: time, eta: time, expiresAt: time, status: z.enum(['voting', 'closed', 'queued', 'expired']),
  actionsHash: digest, actionsBoc: z.string().min(1).max(1024 * 1024),
}).strict();
const snapshotSchema = z.object({ schema: z.literal('tonswap-governance-snapshot-v1'),
  releaseId: z.string().min(1).max(128), manifestHash: digest, network: z.enum(['testnet', 'mainnet']), governance: address,
  codeHash: digest, dataHash: digest, asOf: headSchema, bucketSeconds: z.number().int(), owner: z.null(), lock: z.null(),
  phase: z.number().int().min(0).max(1), bootstrapDeadline: uint32, handoffBucket: uint32,
  totalLockedRaw: atomic(120), supplyBaseRaw: atomic(120).nullable(), genesisTotalRaw: atomic(120).nullable(), escrowRaw: atomic(120),
  nextProposalId: id, liveProposalCount: z.number().int().min(0).max(48),
  proposals: z.array(proposalSchema).max(48), prunedProposalIds: z.array(id).max(64),
  page: z.object({ startId: id, scanned: z.number().int().min(0).max(64), nextStartId: id.nullable(),
    complete: z.literal(true), historyComplete: z.literal(false) }).strict(),
}).strict();
export type GovernanceObservation = z.infer<typeof snapshotSchema>;
export type GovernanceHead = GovernanceObservation['asOf'];
export type GovernanceProposalObservation = GovernanceObservation['proposals'][number];

/** Consume only the current indexer's bounded, source-authenticated snapshot.
 * No current proposal state establishes execution of its target messages. */
export function assessGovernanceObservation(raw: unknown, config: Config, network: Network, startId: string, now: number,
  previous: { head: GovernanceHead; nextProposalId: string; dataHash: string } | null = null): GovernanceObservation {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) throw Error('governance_snapshot_invalid');
  const value = parsed.data, binding = governanceBinding(config, network);
  if (!binding || value.network !== network || value.releaseId !== binding.release.releaseId ||
    value.manifestHash !== binding.release.manifestHash || value.governance !== binding.contract.address ||
    value.codeHash !== binding.contract.codeHash) throw Error('governance_scope_mismatch');
  const head = value.asOf;
  if (head.utime * 1000 > now + DEX_PRICE_FUTURE_SKEW_MS || now - head.utime * 1000 > DEX_PRICE_MAX_AGE_MS)
    throw Error('governance_snapshot_stale');
  if (previous && (head.seqno < previous.head.seqno || head.utime < previous.head.utime ||
    head.seqno === previous.head.seqno && (head.rootHashHex !== previous.head.rootHashHex ||
      head.fileHashHex !== previous.head.fileHashHex || head.utime !== previous.head.utime ||
      value.dataHash !== previous.dataHash || value.nextProposalId !== previous.nextProposalId) ||
    BigInt(value.nextProposalId) < BigInt(previous.nextProposalId))) throw Error('governance_snapshot_regressed');
  const counter = Number(value.nextProposalId), first = Number(startId), end = Math.min(counter, first + 64);
  if (value.page.startId !== startId || first > counter || value.page.scanned !== end - first ||
    value.page.nextStartId !== (end < counter ? String(end) : null)) throw Error('governance_cursor_invalid');
  const seen = new Set<string>();
  for (const item of [...value.proposals.map(p => p.id), ...value.prunedProposalIds]) {
    if (Number(item) < first || Number(item) >= end || seen.has(item)) throw Error('governance_page_invalid');
    seen.add(item);
  }
  if (seen.size !== end - first || value.proposals.length > value.liveProposalCount) throw Error('governance_page_invalid');
  const bucket = network === 'testnet' ? 600 : 86400;
  if (value.bucketSeconds !== bucket || (value.supplyBaseRaw === null) !== (value.genesisTotalRaw === null) ||
    value.supplyBaseRaw !== null && BigInt(value.supplyBaseRaw) > BigInt(value.genesisTotalRaw!)) throw Error('governance_snapshot_invalid');
  let actionBytes = 0;
  for (const p of value.proposals) {
    const [minVote, maxVote, review, delay, grace] = p.class === 0 ? [3, 7, 1, 2, 7] : p.class === 1 ? [3, 14, 1, 7, 7] : [1, 1, 0, 0, 1];
    const close = p.decidedAt === 0 ? p.start + maxVote! * bucket : Math.max(p.decidedAt + review! * bucket, p.start + minVote! * bucket);
    const eta = close + delay! * bucket, expires = eta + grace! * bucket;
    const status = head.utime > expires ? 'expired' : p.queued ? 'queued' : head.utime >= close ? 'closed' : 'voting';
    if ((p.class === 2 ? p.slot < 8 : p.slot >= 8) || p.start > head.utime || p.decidedAt > head.utime ||
      p.closeAt !== close || p.eta !== eta || p.expiresAt !== expires || p.status !== status) throw Error('governance_proposal_invalid');
    try {
      actionBytes += Buffer.byteLength(p.actionsBoc);
      if (actionBytes > 1024 * 1024) throw Error();
      const bytes = Buffer.from(p.actionsBoc, 'base64');
      if (bytes.toString('base64') !== p.actionsBoc) throw Error();
      const cells = Cell.fromBoc(bytes);
      if (cells.length !== 1 || cells[0]!.hash().toString('hex') !== p.actionsHash) throw Error();
      const pending = [...cells], seenCells = new Set<Cell>();
      while (pending.length) {
        const cell = pending.pop()!;
        if (seenCells.has(cell)) continue;
        seenCells.add(cell);
        if (cell.isExotic || seenCells.size > 100_000) throw Error();
        pending.push(...cell.refs);
      }
    } catch { throw Error('governance_actions_invalid'); }
  }
  return value;
}
