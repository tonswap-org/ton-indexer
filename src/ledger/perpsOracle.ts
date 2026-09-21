import { Address, beginCell } from '@ton/core';
import type { Node } from './project';
import type { LedgerEvidenceRef } from './types';
import { bodyCell } from './wire';
import { readPerpsAdmission, samePerpsAdmission } from './perpsAdmission';
import {
  PERPS_EXPIRE_ORDER, PERPS_ORACLE_FAILED, PERPS_ORACLE_PULL, PERPS_ORACLE_RESULT,
  perpsOracleMessage, type PerpsRequest,
} from './perpsWire';
import {
  perpsAccount, perpsPending, perpsPosition, perpsOracleTradeTransition,
  type PerpsState, type PerpsOracleRefreshReceipt,
} from './perpsState';

export type PerpsBoundary = { before: PerpsState; after: PerpsState; evidence: {
  kind: 'perps_account_delta'; stateBeforeHash: string; stateAfterHash: string;
  beforeSeqno: number; afterSeqno: number; transactions: LedgerEvidenceRef[];
} };
const address = (value?: string) => { try { return value ? Address.parse(value).toRawString() : null; } catch { return null; } };
const success = (node: Node) => node.raw.success && (!node.raw.status || node.raw.status === 'success');
export type PerpsOracleExecution = {
  receipt: PerpsOracleRefreshReceipt;
  nodes: Node[];
  pool: Node | null;
  execution: Node | null;
  states: PerpsBoundary | null;
};

/** A receipt identifies a pending order; only its exact pool/timeout continuation
 * and independent qualified engine boundary can establish admission. */
export async function readPerpsOracleExecution(input: {
  owner: string; ownerWallet: string; engine: string; request: PerpsRequest; original: Node;
  intake: PerpsBoundary; engineNodes: Node[];
  boundary: (node: Node) => Promise<PerpsBoundary | null>;
  receiptFor: (node: Node, index: number) => Node | null;
}): Promise<PerpsOracleExecution | null> {
  const { owner, ownerWallet, engine, request, original, intake, receiptFor } = input;
  const queued = intake.after.oracleRefreshes.get(request.marketId)?.get(owner), body = bodyCell(original.raw.inMessage);
  if (!queued?.order || !body || queued.status !== 1 || queued.order.outcome !== 1 || queued.queryId !== request.queryId ||
      queued.requestHash !== body.hash().toString('hex') || queued.requestedAt !== String(original.raw.utime) ||
      JSON.stringify(queued.order.request) !== JSON.stringify(request) ||
      JSON.stringify(perpsAccount(intake.before, owner)) !== JSON.stringify(perpsAccount(intake.after, owner)) ||
      JSON.stringify(perpsPosition(intake.before, owner, request.marketId)) !== JSON.stringify(perpsPosition(intake.after, owner, request.marketId)) ||
      JSON.stringify(perpsPending(intake.before, ownerWallet)) !== JSON.stringify(perpsPending(intake.after, ownerWallet))) return null;
  const old = intake.before.oracleRefreshes.get(request.marketId)?.get(owner);
  if (old && (old.wireQueryId === queued.wireQueryId || old.queryId === queued.queryId || old.order?.outcome === 1)) return null;
  if (queued.order.funding ? queued.order.funding.senderWallet !== ownerWallet :
      address(original.raw.inMessage?.source) !== owner || BigInt(original.raw.inMessage?.value ?? '0') !==
        BigInt(queued.order.nativeBudgetRaw) + (request.operation === 'modify' ? 500000000n : 320000000n)) return null;
  const poolAddress = queued.order.pool;
  if (intake.after.markets.get(request.marketId)?.pool !== poolAddress || intake.before.markets.get(request.marketId)?.pool !== poolAddress) return null;
  const pulls = original.raw.outMessages.flatMap((message, index) => {
    const wire = perpsOracleMessage(message), pool = receiptFor(original, index);
    return wire?.opcode === PERPS_ORACLE_PULL && wire.wireQueryId === queued.wireQueryId && wire.marketId === request.marketId &&
      wire.owner === owner && wire.requestHash === queued.requestHash && address(message.source) === engine &&
      address(message.destination) === poolAddress && !message.bounced ? [{ wire, pool }] : [];
  });
  if (pulls.length !== 1) return null;
  const { wire: pull, pool } = pulls[0];
  const result: PerpsOracleExecution = { receipt: queued, nodes: pool ? [pool] : [], pool, execution: null, states: null };
  const candidates: Array<{ node: Node; states: PerpsBoundary; receipt: PerpsOracleRefreshReceipt }> = [];
  const admissions: Array<NonNullable<Awaited<ReturnType<typeof readPerpsAdmission>>>> = [];
  for (const node of input.engineNodes) {
    if (BigInt(node.raw.lt) <= BigInt(original.raw.lt) || !success(node)) continue;
    const message = node.raw.inMessage, wire = perpsOracleMessage(message);
    const isExpiry = wire?.opcode === PERPS_EXPIRE_ORDER;
    let exactMessage = Boolean(wire && wire.wireQueryId === queued.wireQueryId && wire.marketId === request.marketId && !message?.bounced && (
      isExpiry ? node.raw.utime >= Number(queued.requestedAt) + 300 && BigInt(message?.value ?? '0') >= 300000000n :
        pool && success(pool) && address(message?.source) === poolAddress &&
        pool.raw.outMessages.some((_, index) => receiptFor(pool, index)?.id === node.id) &&
        (wire.opcode === PERPS_ORACLE_FAILED || wire.opcode === PERPS_ORACLE_RESULT && wire.owner === owner && wire.requestHash === queued.requestHash)
    ));
    let bounced = false;
    if (message?.bounced && pool && !pool.raw.success && pool.raw.status === 'failed' && address(message.source) === poolAddress &&
        pool.raw.outMessages.some((_, index) => receiptFor(pool, index)?.id === node.id)) {
      const expected = beginCell().storeUint(0xffffffff, 32).storeBits(pull.body.beginParse().loadBits(256)).endCell();
      bounced = bodyCell(message)?.hash().equals(expected.hash()) === true;
      exactMessage = bounced;
    }
    if (!exactMessage) continue;
    const states = await input.boundary(node);
    if (!states) continue;
    const after = states.after.oracleRefreshes.get(request.marketId)?.get(owner);
    const before = states.before.oracleRefreshes.get(request.marketId)?.get(owner);
    if (wire?.opcode === PERPS_ORACLE_RESULT && after?.order?.outcome === 1 && after.order.admissionPhase === 1 &&
        before?.order?.outcome === 1 && before.order.admissionPhase === 0 &&
        samePerpsAdmission(queued, before) && samePerpsAdmission(queued, after) &&
        states.before.markets.get(request.marketId)?.pool === poolAddress &&
        states.after.markets.get(request.marketId)?.pool === poolAddress &&
        JSON.stringify(perpsAccount(states.before, owner)) === JSON.stringify(perpsAccount(states.after, owner)) &&
        JSON.stringify(perpsPosition(states.before, owner, request.marketId)) === JSON.stringify(perpsPosition(states.after, owner, request.marketId)) &&
        JSON.stringify(perpsPending(states.before, ownerWallet)) === JSON.stringify(perpsPending(states.after, ownerWallet))) {
      const admission = await readPerpsAdmission({ engine, owner, ownerWallet, request, queued,
        initial: node, initialStates: states, boundary: input.boundary, receiptFor });
      if (admission) admissions.push(admission);
      continue;
    }
    const transition = perpsOracleTradeTransition(states.before, states.after, owner, request);
    if (!transition || transition.before.wireQueryId !== queued.wireQueryId || transition.before.requestHash !== queued.requestHash ||
        transition.before.requestedAt !== queued.requestedAt || !transition.before.order!.notification.hash().equals(queued.order.notification.hash()) ||
        !transition.before.order!.requestCell.hash().equals(queued.order.requestCell.hash()) ||
        transition.before.order!.pool !== poolAddress ||
        transition.before.order!.nativeBudgetRaw !== queued.order.nativeBudgetRaw || transition.after.completedAt !== String(node.raw.utime) ||
        states.before.markets.get(request.marketId)?.pool !== states.after.markets.get(request.marketId)?.pool) continue;
    const receipt = transition.after;
    if (receipt.order!.outcome === 2 && states.after.markets.get(request.marketId)?.oraclePriceHealthy !== true) continue;
    const rebound = states.before.markets.get(request.marketId)?.pool !== poolAddress;
    if (rebound ? receipt.order!.outcome !== 3 || receipt.order!.reason !== 7 : receipt.order!.reason === 7) continue;
    if ((isExpiry && receipt.status !== 4) || ((bounced || wire?.opcode === PERPS_ORACLE_FAILED) && receipt.status !== 3) ||
        (wire?.opcode === PERPS_ORACLE_RESULT && (receipt.status === 2 && wire.status !== 2 ||
          receipt.status === 4 && node.raw.utime < Number(receipt.requestedAt) + 300 ||
          receipt.status !== 4 && node.raw.utime >= Number(receipt.requestedAt) + 300))) continue;
    candidates.push({ node, states, receipt });
  }
  if (candidates.length + admissions.length > 1) return null;
  if (admissions.length === 1) {
    const admission = admissions[0];
    result.receipt = admission.receipt; result.execution = admission.execution; result.states = admission.states;
    result.nodes.push(...admission.nodes);
  }
  if (candidates.length === 1) {
    const candidate = candidates[0];
    result.execution = candidate.node; result.states = candidate.states; result.receipt = candidate.receipt;
    result.nodes.push(candidate.node);
  }
  return result;
}
