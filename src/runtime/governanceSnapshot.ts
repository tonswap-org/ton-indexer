import { Address, Cell, type TupleItem } from '@ton/core';
import { validateReleaseManifest, type RuntimeReleaseManifest } from '../config/runtimeManifest';
import { ChainReadError, type ChainHead, type ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { freshMasterchainBlock, type FreshReadCall } from '../data/freshRead';
import { createSnapshotReader } from '../api/snapshotReader';
import { activeOrderAccount, orderCell, orderShard } from '../orders/evidence';
import { governanceProposalTiming, readGovernanceStorage, type GovernanceParams } from '../utils/governanceStorage';

export const GOVERNANCE_ACTION_BYTES_LIMIT = 1024 * 1024;
export const GOVERNANCE_RESPONSE_BYTES_LIMIT = 2 * 1024 * 1024;

export type GovernanceSnapshotQuery = { owner?: string; startId?: string; maxScan?: number };
const unavailable = (): never => { throw new ChainReadError('upstream_unavailable'); };
const sameHead = (left: ChainHead, right: ChainHead) => (['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex', 'utime'] as const)
  .every(key => left[key] === right[key]);
const cell = (boc?: string | null): Cell => {
  if (!boc || boc.length > 8 * 1024 * 1024) return unavailable();
  return orderCell(boc);
};
function params(stack: TupleItem[], kind: number, globalId: number): GovernanceParams {
  if (stack.length !== 9 || stack.some(item => item.type !== 'int' || item.value < 0n || item.value > BigInt(Number.MAX_SAFE_INTEGER))) return unavailable();
  const values = stack.map(item => Number((item as { value: bigint }).value)), bucket = globalId === -3 ? 600 : 86400;
  const [minVote, maxVote, review, delay, grace, share, floor, approval] = kind === 0 ? [3, 7, 1, 2, 7, 1500, 200, 6000]
    : kind === 1 ? [3, 14, 1, 7, 7, 3000, 500, 6667] : [1, 1, 0, 0, 1, 1500, 200, 6667];
  const expected = [bucket, ...[minVote, maxVote, review, delay, grace].map(value => value * bucket), share, floor, approval];
  if (values.some((value, index) => value !== expected[index])) return unavailable();
  return { bucket, minVote: values[1], maxVote: values[2], review: values[3], delay: values[4], grace: values[5] };
}

/** One immutable release binding and one current head per page. In-flight work
 * may be shared, but time-derived results never use a completed-response cache. */
export function createGovernanceSnapshotReader(manifest: RuntimeReleaseManifest, source: ChainSource) {
  if (!validateReleaseManifest(manifest).ok || manifest.network !== `ton:${source.network}` || !manifest.contracts.Governance) return unavailable();
  const pin = { ...manifest.contracts.Governance }, releaseId = manifest.releaseId, manifestHash = manifest.manifestHash,
    network = source.network, globalId = manifest.globalId, reader = createSnapshotReader(source);
  return async (address: string, query: GovernanceSnapshotQuery = {}, signal?: AbortSignal) => {
    if (Address.parse(address).toRawString() !== pin.address) return unavailable();
    const owner = query.owner ? Address.parse(query.owner).toRawString() : null, firstId = query.startId ?? '1', maxScan = query.maxScan ?? 20;
    if (!/^[1-9][0-9]{0,9}$/.test(firstId) || BigInt(firstId) > 0xffffffffn || !Number.isInteger(maxScan) || maxScan < 1 || maxScan > 64)
      throw new Error('Invalid Governance page bounds.');
    const startId = Number(firstId);
    const { asOfSeqno: _asOfSeqno, ...snapshot } = await reader.read({ key: `${owner ?? ''}|${firstId}|${maxScan}`, deadlineMs: 10_000, signal,
      load: async ({ head, signal }) => {
        try {
          freshMasterchainBlock({ ...head, rootHash: head.rootHashHex, fileHash: head.fileHashHex }); assertFreshHeadTime(head.utime);
          const calls: FreshReadCall[] = [{ kind: 'account', address: pin.address }, ...[0, 1, 2].map(kind =>
            ({ kind: 'getter' as const, address: pin.address, method: 'get_params', args: [{ type: 'int' as const, value: BigInt(kind) }] }))];
          const observed = await source.read(calls, { at: head, signal }); signal.throwIfAborted();
          if (!sameHead(observed.head, head) || observed.results.length !== calls.length) return unavailable();
          const account = observed.results[0];
          if (account.kind !== 'account' || account.address !== pin.address || account.state.accountState !== 'active') return unavailable();
          const envelope = account.state;
          if (!envelope.shardAccountBoc || !envelope.anchor || !Number.isSafeInteger(envelope.anchor.genUtime)
            || envelope.anchor.genUtime <= 0 || envelope.anchor.genUtime > head.utime
            || (envelope.sourceMasterchain && !sameHead(envelope.sourceMasterchain, head))) return unavailable();
          cell(envelope.shardAccountBoc);
          const { shard } = orderShard(envelope.shardAccountBoc, pin.address), actual = activeOrderAccount(shard, pin.codeHash);
          if (!cell(envelope.codeBoc).equals(actual.code) || !cell(envelope.dataBoc).equals(actual.data)
            || envelope.balance !== shard.account!.storage.balance.coins.toString()
            || envelope.lastTxLt !== shard.lastTransactionLt.toString() || !envelope.lastTxHash
            || Buffer.from(envelope.lastTxHash, /^[0-9a-f]{64}$/i.test(envelope.lastTxHash) ? 'hex' : 'base64').toString('hex')
              !== shard.lastTransactionHash.toString(16).padStart(64, '0')) return unavailable();
          const state = readGovernanceStorage(actual.data);
          const classes = [0, 1, 2].map(kind => {
            const result = observed.results[kind + 1];
            if (result.kind !== 'getter' || result.address !== pin.address || result.exitCode !== 0) return unavailable();
            return params(result.stack, kind, globalId);
          });
          const lastId = Math.min(state.props.nextId - 1, startId + maxScan - 1), proposals = [], prunedProposalIds: string[] = [];
          let actionBytes = 0;
          const actionBocs = new Map<string, string>();
          for (let id = startId; id <= lastId; id++) {
            const value = state.props.proposals.get(id);
            if (!value) { prunedProposalIds.push(String(id)); continue; }
            const { actions, ...proposal } = value;
            const actionsHash = actions.hash().toString('hex');
            let actionsBoc = actionBocs.get(actionsHash);
            if (actionsBoc === undefined) { actionsBoc = actions.toBoc().toString('base64'); actionBocs.set(actionsHash, actionsBoc); }
            actionBytes += Buffer.byteLength(actionsBoc);
            if (actionBytes > GOVERNANCE_ACTION_BYTES_LIMIT) return unavailable();
            proposals.push({ id: String(id), ...proposal, ...governanceProposalTiming(value, classes[value.class], head.utime),
              actionsHash, actionsBoc });
          }
          assertFreshHeadTime(head.utime); signal.throwIfAborted();
          const result = { schema: 'tonswap-governance-snapshot-v1' as const, releaseId, manifestHash, network, governance: pin.address,
            asOf: { ...head }, codeHash: pin.codeHash, dataHash: actual.data.hash().toString('hex'), bucketSeconds: classes[0].bucket,
            owner, lock: owner ? state.stake.locks.get(Address.parse(owner)) ?? null : null,
            phase: state.phase, bootstrapDeadline: state.bootstrapDeadline, handoffBucket: state.handoffBucket,
            totalLockedRaw: state.stake.totalLockedRaw, supplyBaseRaw: state.ts?.supplyBase.toString() ?? null,
            genesisTotalRaw: state.ts?.genesisTotal.toString() ?? null, escrowRaw: state.props.escrowRaw,
            nextProposalId: String(state.props.nextId), liveProposalCount: state.props.live, proposals, prunedProposalIds,
            page: { startId: firstId, scanned: Math.max(0, lastId - startId + 1),
              nextStartId: lastId + 1 < state.props.nextId ? String(lastId + 1) : null, complete: true as const, historyComplete: false as const } };
          if (Buffer.byteLength(JSON.stringify(result)) > GOVERNANCE_RESPONSE_BYTES_LIMIT) return unavailable();
          return result;
        } catch (error) {
          if (error instanceof ChainReadError) throw error;
          throw new ChainReadError('upstream_unavailable', { cause: error });
        }
      } });
    return snapshot;
  };
}
export type GovernanceSnapshot = Awaited<ReturnType<ReturnType<typeof createGovernanceSnapshotReader>>>;
