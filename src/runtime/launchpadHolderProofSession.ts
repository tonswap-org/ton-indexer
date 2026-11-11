import { Address, beginCell, Cell, contractAddress } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainHead, ChainSource, RecoveryProofAnchor, RecoveryProofHistory } from '../data/dataSource';
import { validateRecoveryProofAnchor, recoveryAccountPath, recoveryTransactionChunk } from '../data/t3ProofBundle';
import { assertFreshHeadTime } from '../data/freshHead';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { collectLaunchpadHolderRecoveryEvidence, type CurrentLaunchpadHolderRecoveryEvidence, type HolderRecoveryCandidate } from './launchpadHolderRecoveryEvidence';
import { readLaunchpadOperationRequest } from './launchpadOperationEvidence';
import { ProductEvidenceError, requireProduct } from './productEvidence';
import { activeOrderAccount, orderShard } from '../orders/evidence';

const exact = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === [...keys].sort().join();
const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');
function check(ok: unknown): asserts ok { if (!ok) throw unavailable(); }
export const T3_PROOF_SESSION_LIMITS = { bytes: 8 * 1024 * 1024, transactions: 4 } as const;
export function readLaunchpadHolderProofSessionRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  try {
    requireProduct(exact(value, ['original', 'key', 'nonce', 'anchor', 'proofCodeBoc']));
    const original = readLaunchpadOperationRequest(value.original, manifest); requireProduct(typeof value.key === 'string' && /^0:[0-9a-f]{64}:[1-9][0-9]{0,19}:[0-9a-f]{64}$/.test(value.key));
    requireProduct(typeof value.nonce === 'string' && /^[0-9a-f]{64}$/.test(value.nonce));
    const anchor = value.anchor as ChainHead | null;
    if (anchor !== null) {
      requireProduct(exact(anchor, ['seqno', 'workchain', 'shard', 'rootHashHex', 'fileHashHex', 'utime'])
        && anchor.workchain === -1 && anchor.shard === '-9223372036854775808'
        && Number.isSafeInteger(anchor.seqno) && anchor.seqno > 0 && anchor.seqno <= 0xffffffff
        && Number.isSafeInteger(anchor.utime) && anchor.utime > 0 && anchor.utime <= 0xffffffff
        && /^[0-9a-f]{64}$/.test(anchor.rootHashHex) && /^[0-9a-f]{64}$/.test(anchor.fileHashHex));
    }
    requireProduct(typeof value.proofCodeBoc === 'string' && value.proofCodeBoc.length <= 128 * 1024);
    const code = Cell.fromBase64(value.proofCodeBoc); requireProduct(!code.isExotic && code.hash().toString('hex') === manifest.templates.T3RecoveryProof);
    return { original, key: value.key, nonce: value.nonce, anchor: anchor && { ...anchor }, code };
  } catch (e) { if (e instanceof ProductEvidenceError) throw e; throw new ProductEvidenceError(400, 'bad_request'); }
}
export function holderProofConfig(nonce: string, f: HolderRecoveryCandidate, master: string, walletCodeHash: string, anchor: ChainHead) {
  const holder = Address.parse(f.holder);
  const ids = beginCell().storeAddress(holder).storeAddress(holder).storeAddress(Address.parse(master)).endCell();
  const wallets = beginCell().storeAddress(Address.parse(f.wallet)).storeAddress(Address.parse(f.target)).storeUint(BigInt(f.wire),64).storeCoins(BigInt(f.amountRaw)).endCell();
  const credit = beginCell().storeRef(ids).storeBuffer(Cell.fromBase64(f.requestBoc).hash()).storeRef(Cell.EMPTY).storeRef(wallets).storeBuffer(Buffer.from(walletCodeHash,'hex')).endCell();
  const target = (hash: string,lt: string) => beginCell().storeBuffer(Buffer.from(hash,'hex')).storeUint(BigInt(lt),64).storeBuffer(Buffer.from(anchor.rootHashHex,'hex')).endCell();
  return beginCell().storeBuffer(Buffer.from(nonce,'hex')).storeRef(credit).storeRef(beginCell().storeRef(target(f.sourceHash,f.sourceLt)).storeRef(target(f.targetHash,f.targetLt))).endCell();
}
export function recoveryInitialData(config: Cell) {
  return beginCell().storeRef(config).storeUint(0, 3).storeUint(0, 256)
    .storeRef(beginCell().storeUint(0, 256).storeUint(0, 256).storeUint(0, 9).storeUint(0, 64)).storeUint(0, 2).endCell();
}
export function readRecoverySessionData(data: Cell, config: Cell) {
  const s = data.beginParse(); check(s.loadRef().equals(config)); const phase = s.loadUint(3), messageHash = s.loadUintBig(256), c = s.loadRef().beginParse();
  const cursor = { hash: c.loadUintBig(256), key: c.loadUintBig(256), bits: c.loadUint(9), lt: c.loadUintBig(64) }; c.endParse();
  const evidence = s.loadUint(2); s.endParse(); check(cursor.bits <= 256 && evidence <= 2);
  return { phase, messageHash, cursor, evidence };
}
export type LaunchpadHolderProofSessionEvidence = {
  schema: 'tonswap-launchpad-holder-proof-session-v1'; releaseId: string; manifestHash: string;
  asOf: ChainHead;
  recovery: CurrentLaunchpadHolderRecoveryEvidence; anchor: ChainHead; address: string; configBoc: string;
  source: RecoveryProofAnchor; target: RecoveryProofAnchor | null; history: RecoveryProofHistory | null;
  sessionShardAccountBoc: string | null; transactionBocs: string[];
};
/** One bounded native verifier step. Long account histories continue from the
 * on-chain cursor; they are never truncated into a claim of complete history. */
export async function collectLaunchpadHolderProofSession(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  p: ReturnType<typeof readLaunchpadHolderProofSessionRequest>, signal?: AbortSignal): Promise<LaunchpadHolderProofSessionEvidence> {
  check(source.getRecoveryProofAnchor);
  const recovery = await collectLaunchpadHolderRecoveryEvidence(manifest, source, store, p.original, signal);
  check(recovery.coverage.complete && recovery.coverage.gaps.length === 0);
  const found = recovery.candidates.filter(c=>c.key===p.key); check(found.length===1); const candidate=found[0];
  const current = await source.head({ signal }); assertFreshHeadTime(current.utime);
  check(current.seqno >= recovery.asOf.masterchainSeqno && (current.seqno !== recovery.asOf.masterchainSeqno || current.rootHashHex === recovery.asOf.blockRootHash));
  const anchor = p.anchor ?? current; check(anchor.seqno <= current.seqno && anchor.utime <= current.utime && (anchor.seqno !== current.seqno || anchor.rootHashHex === current.rootHashHex));
  const sameHead = (a: ChainHead, b: ChainHead) => a.seqno === b.seqno && a.workchain === b.workchain && a.shard === b.shard && a.rootHashHex === b.rootHashHex && a.fileHashHex === b.fileHashHex && a.utime === b.utime;
  const original = await source.getRecoveryProofAnchor(candidate.wallet, { at: anchor, signal }); validateRecoveryProofAnchor(original);
  check(original.account === candidate.wallet && sameHead(original.head, anchor));
  const config = holderProofConfig(p.nonce, candidate, manifest.contracts.T3Hub!.address, manifest.templates.T3Wallet, anchor);
  const address = contractAddress(0, { code: p.code, data: recoveryInitialData(config) }).toRawString();
  const account = await source.getAccountState(address, { at: current, signal });
  let stage = readRecoverySessionData(recoveryInitialData(config), config);
  if (account.accountState === 'active') stage = readRecoverySessionData(activeOrderAccount(orderShard(account.shardAccountBoc!, address).shard, manifest.templates.T3RecoveryProof).data, config);
  else check(account.provenAbsent || account.shardAccountBoc && orderShard(account.shardAccountBoc, address).shard.account?.storage.state.type === 'uninit');
  check([0, 1, 2, 3, 4, 5, 7].includes(stage.phase));
  check(stage.phase <= 2 ? stage.evidence === 0 : stage.evidence === (candidate.kind === 'notification' ? 1 : candidate.target === candidate.wallet ? 0 : 2));
  let target: RecoveryProofAnchor | null = null, history: RecoveryProofHistory | null = null;
  const isTarget = stage.phase >= 3 && stage.phase <= 5, failure = candidate;
  if (isTarget) { check(failure.target !== candidate.wallet); target = await source.getRecoveryProofAnchor(failure.target, { at: anchor, signal }); validateRecoveryProofAnchor(target); check(target.account === failure.target && sameHead(target.head, anchor)); }
  if ((stage.phase === 0 || stage.phase === 3) && current.seqno - anchor.seqno > 8) {
    check(source.getRecoveryProofHistory); history = await source.getRecoveryProofHistory(anchor, { at: current, signal });
  }
  const branch = target ?? original;
  if (stage.phase === 1 || stage.phase === 4) recoveryAccountPath(branch, stage.cursor);
  const transactionBocs: string[] = [];
  if (stage.phase === 2 || stage.phase === 5) {
    const end = { lt: BigInt(isTarget ? failure.targetLt : failure.sourceLt), hash: BigInt('0x' + (isTarget ? failure.targetHash : failure.sourceHash)) };
    const page = await source.getTransactions(branch.account, 4, stage.cursor.lt.toString(), Buffer.from(stage.cursor.hash.toString(16).padStart(64, '0'), 'hex').toString('base64'), { signal });
    for (const row of page) { check(row.rawBoc); transactionBocs.push(row.rawBoc); if (row.lt === end.lt.toString()) break; }
    recoveryTransactionChunk(branch.account, transactionBocs, stage.cursor, end);
  }
  signal?.throwIfAborted(); assertFreshHeadTime(current.utime);
  const result: LaunchpadHolderProofSessionEvidence = { schema: 'tonswap-launchpad-holder-proof-session-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: current,
    recovery, anchor, address, configBoc: config.toBoc().toString('base64'), source: original, target, history,
    sessionShardAccountBoc: account.shardAccountBoc ?? null, transactionBocs };
  check(Buffer.byteLength(JSON.stringify(result)) <= T3_PROOF_SESSION_LIMITS.bytes);
  return result;
}
