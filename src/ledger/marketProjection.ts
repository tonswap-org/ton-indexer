import { resolveHistoricalJettonPrecision } from './jettonPrecision';
import { createHash } from 'node:crypto';
import { verifyDlmmSwapExecution } from './dlmmSwapProof';
import { bodyCell, NOTIFY, opcode, SWAP, tokenWire } from './wire';
import type { LedgerEvidenceRef } from './types';
import type { DlmmMarketBinding, MarketDependency, MarketNode, MarketObservation, MarketProjection, MarketSettlementEvidence } from './marketTypes';
import { createDlmmProofGraph, requireProof, address, successful, marketHash, ref, key, positiveLt } from './dlmmProof';

const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;

/** Exact executions from physical messages and transaction-bound historical state.
 * No current getter, chart candle, selected owner, decimal default or currency peg participates. */
export function projectDlmmMarket(binding: DlmmMarketBinding, supplied: readonly MarketNode[], dependencies: MarketDependency[]): MarketProjection {
  requireProof(['mainnet', 'testnet', 'localnet'].includes(binding.network) &&
    [binding.pool, binding.tokenT, binding.tokenX].every(value => address(value) === value) && binding.tokenT !== binding.tokenX &&
    [binding.poolCodeHash, binding.walletCodeHash, binding.tokenTCodeHash, binding.tokenXCodeHash].every(value => /^[a-f0-9]{64}$/.test(value)), 'market_binding_invalid');
  const result: MarketProjection = { schema: 'dlmm-market-ledger-v1', binding, dependencies: [...dependencies].sort((a, b) => a.account.localeCompare(b.account)),
    observations: [], candidates: [], issues: [], historyComplete: false };
  let proof: ReturnType<typeof createDlmmProofGraph>;
  try { proof = createDlmmProofGraph(binding, supplied); }
  catch (error) { result.issues.push(error instanceof Error ? error.message : 'market_evidence_unavailable'); return result; }
  const { nodes, pools } = proof;
  for (const acceptance of pools) {
    if (successful(acceptance) && !bodyCell(acceptance.raw.inMessage)) {
      result.issues.push('market_pool_input_undecodable');
    }
    const notice = tokenWire(acceptance.raw.inMessage);
    if ((acceptance.raw.inMessage?.op === NOTIFY || opcode(acceptance.raw.inMessage) === NOTIFY) &&
      (!notice || notice.forward.bits.length < 32)) {
      result.issues.push('market_pool_notification_undecodable');
      continue;
    }
    if (notice?.op !== NOTIFY || notice.forward.bits.length < 32 || notice.forward.beginParse().preloadUint(32) !== SWAP) continue;
    const candidateId = createHash('sha256').update(`dlmm-market-v1:${binding.network}:${key(acceptance)}`).digest('hex');
    const candidate: MarketProjection['candidates'][number] = { id: candidateId, acceptance: ref(acceptance), status: 'unresolved', issues: [], observationId: null };
    result.candidates.push(candidate);
    try {
      const { forward, notice, inputRoot, outputRoot, inputSide, paid, returned, consumed, output, state,
        original, paymentSource, paymentCredit, payment, settlements } = verifyDlmmSwapExecution(binding, proof, acceptance);
      if (output === 0n) { candidate.status = 'refunded'; continue; }
      const divisor = gcd(output, consumed);
      const evidenceRefs = new Map<string, LedgerEvidenceRef>();
      for (const transaction of [ref(original.node), ref(paymentSource.node), ref(paymentCredit), ref(acceptance), ...settlements.flatMap(value =>
        [value.request, value.debit, value.credit, value.acknowledged, value.walletFinalized, value.poolFinalized, ...value.boundaries.map(boundary => boundary.transaction)])])
        evidenceRefs.set(`${transaction.account}:${transaction.lt}:${transaction.hash}`, transaction);
      const observation: MarketObservation = { id: candidateId, network: binding.network, pool: binding.pool, kind: 'settled_dlmm_execution', acceptance: ref(acceptance),
        executionUtime: acceptance.raw.utime, deliveredUtime: Math.max(...settlements.map(value => value.credit.utime)), finalizedUtime: Math.max(...settlements.map(value => value.poolFinalized.utime)),
        payer: notice.owner, recipient: forward.recipient, businessQueryId: forward.queryId.toString(), inputAsset: `${binding.network}:jetton:${inputRoot}`, outputAsset: `${binding.network}:jetton:${outputRoot}`,
        assetPrecision: acceptance.assetPrecision ?? {input: resolveHistoricalJettonPrecision({network:binding.network,root:inputRoot,rootCodeHash:inputSide===0?binding.tokenTCodeHash:binding.tokenXCodeHash,walletCodeHash:binding.walletCodeHash},ref(acceptance),null),output: resolveHistoricalJettonPrecision({network:binding.network,root:outputRoot,rootCodeHash:inputSide===0?binding.tokenXCodeHash:binding.tokenTCodeHash,walletCodeHash:binding.walletCodeHash},ref(acceptance),null)},
        paidInputRaw: paid.toString(), returnedInputRaw: returned.toString(), consumedInputRaw: consumed.toString(), outputRaw: output.toString(),
        ratio: { numerator: (output / divisor).toString(), denominator: (consumed / divisor).toString(), unit: 'output_atomic_per_input_atomic', includesTradingFees: true },
        input: { request: ref(original.node), debit: ref(paymentSource.node), credit: ref(paymentCredit), boundaries: [payment.debitState.evidence, payment.creditState.evidence] },
        allocation: state.evidence, settlements,
        fees: [...evidenceRefs.values()].map(transaction => ({ transaction, nativeAmountRaw: nodes.find(node => key(node) === `${transaction.account}:${transaction.lt}:${transaction.hash}`)?.raw.totalFeesRaw ?? null })) };
      result.observations.push(observation); candidate.status = 'settled'; candidate.observationId = observation.id;
    } catch (error) { candidate.issues.push(error instanceof Error ? error.message : 'market_evidence_unavailable'); }
  }
  const covered = new Set(dependencies.filter(dependency => dependency.historyComplete && positiveLt(dependency.headLt) &&
    /^[a-f0-9]{64}$/.test(dependency.headHash) && Number.isFinite(Date.parse(dependency.checkedThrough)) && nodes.filter(node => node.account === dependency.account).every(node =>
      BigInt(node.raw.lt) <= BigInt(dependency.headLt) && (node.raw.lt !== dependency.headLt || marketHash(node.raw.hash) === dependency.headHash) &&
      node.raw.utime * 1000 <= Date.parse(dependency.checkedThrough))).map(dependency => dependency.account));
  result.historyComplete = !result.issues.length && nodes.length > 0 && covered.has(binding.pool) && nodes.every(node => covered.has(node.account)) && result.candidates.every(candidate => candidate.status !== 'unresolved');
  if (!result.historyComplete) result.issues.push('market_history_or_settlement_incomplete');
  result.issues = [...new Set(result.issues)].sort();
  return result;
}
