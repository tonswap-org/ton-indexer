import { Address, type Cell, type Slice } from '@ton/core';
import type { Node } from './project';
import type { PerpsBoundary, PerpsOracleExecution } from './perpsOracle';
import { bodyCell, messageKey } from './wire';
import { perpsPositionKey, type PerpsRequest } from './perpsWire';
import { perpsAccount, perpsPending, perpsPosition, perpsOracleTradeTransition,
  type PerpsOracleRefreshReceipt } from './perpsState';

const RVLT = 0x52564c54, RVAK = 0x5256414b, RVNK = 0x52564e4b;
const RPRQ = 0x52505251, RPRS = 0x52505253, RPOL = 0x52504f4c;
const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw Error('Trailing risk admission data'); };
const address = (value?: string) => { try { return value ? Address.parse(value).toRawString() : null; } catch { return null; } };
const success = (node: Node) => node.raw.success && (!node.raw.status || node.raw.status === 'success');

export function samePerpsAdmission(a: PerpsOracleRefreshReceipt, b: PerpsOracleRefreshReceipt) {
  return Boolean(a.order && b.order && a.queryId === b.queryId && a.wireQueryId === b.wireQueryId &&
    a.requestHash === b.requestHash && a.requestedAt === b.requestedAt &&
    a.order.requestCell.hash().equals(b.order.requestCell.hash()) &&
    a.order.notification.hash().equals(b.order.notification.hash()) &&
    a.order.previousPosition.hash().equals(b.order.previousPosition.hash()) &&
    a.order.nativeBudgetRaw === b.order.nativeBudgetRaw && a.order.pool === b.order.pool);
}

/** Follow the actual vault and policy replies. An engine journal or matching
 * wire nonce alone cannot substitute for a causally delivered response. */
export async function readPerpsAdmission(input: {
  engine: string; owner: string; ownerWallet: string; request: PerpsRequest;
  queued: PerpsOracleRefreshReceipt; initial: Node; initialStates: PerpsBoundary;
  boundary: (node: Node) => Promise<PerpsBoundary | null>;
  receiptFor: (node: Node, index: number) => Node | null;
}): Promise<Pick<PerpsOracleExecution, 'receipt' | 'nodes' | 'execution' | 'states'> | null> {
  const { engine, owner, ownerWallet, request, queued, receiptFor } = input;
  let node = input.initial, states = input.initialStates;
  let receipt = states.after.oracleRefreshes.get(request.marketId)?.get(owner);
  if (!receipt?.order || !samePerpsAdmission(queued, receipt) || receipt.order.outcome !== 1 ||
      receipt.order.admissionPhase !== 1 || receipt.status !== 2) return null;
  const nodes: Node[] = [node];
  const pending = () => ({ receipt: receipt!, nodes, execution: null, states: null });
  for (let hop = 0; hop < 2; hop += 1) {
    const phase: number = Number(receipt.order!.admissionPhase);
    const policy = states.after.markets.get(request.marketId)?.riskPolicy;
    const target = phase === 1 ? states.after.riskVault : policy?.controller;
    if (!target || (phase !== 1 && phase !== 2)) return null;
    const requests: Array<{ destination: Node | null; body: Cell; messageKey: string; action?: bigint; bucket?: number;
      position?: bigint; notional?: bigint; im?: bigint; cm?: bigint }> = [];
    for (let index = 0; index < node.raw.outMessages.length; index += 1) {
      const message = node.raw.outMessages[index], body = bodyCell(message);
      if (!body || message.bounced || address(message.source) !== engine || address(message.destination) !== target) continue;
      try {
        const s = body.beginParse();
        if (phase === 1) {
          if (s.loadUint(32) !== RVLT) continue;
          const action = s.loadUintBig(64), bucket = s.loadUint(16), position = s.loadUintBig(256);
          const notional = s.loadCoins(), im = s.loadCoins(), cm = s.loadCoins(); end(s);
          if (!action || bucket !== states.after.riskVaultBucketId || position !== BigInt(`0x${perpsPositionKey(owner, request.marketId)}`)) continue;
          requests.push({ destination: receiptFor(node, index), body, messageKey: messageKey(message)!, action, bucket, position, notional, im, cm });
        } else {
          if (s.loadUint(32) !== RPRQ || s.loadUint(32) !== policy!.policyId ||
              s.loadUintBig(64).toString() !== queued.wireQueryId) continue;
          end(s); requests.push({ destination: receiptFor(node, index), body, messageKey: messageKey(message)! });
        }
      } catch { /* A malformed or unrelated outbound is not this admission. */ }
    }
    if (requests.length !== 1) return null;
    const sent = requests[0], service = sent.destination;
    if (!service || !success(service) || service.account !== target) return pending();
    if (!sent.messageKey || messageKey(service.raw.inMessage) !== sent.messageKey) return null;
    nodes.push(service);
    const replies: Node[] = [];
    for (let index = 0; index < service.raw.outMessages.length; index += 1) {
      const message = service.raw.outMessages[index], body = bodyCell(message), callback = receiptFor(service, index);
      if (!body || !callback || !success(callback) || callback.account !== engine || message.bounced ||
          address(message.source) !== target || address(message.destination) !== engine ||
          !messageKey(message) || messageKey(callback.raw.inMessage) !== messageKey(message)) continue;
      try {
        const s = body.beginParse(), opcode = s.loadUint(32);
        if (phase === 1) {
          if (![RVAK, RVNK].includes(opcode) || s.loadUintBig(64) !== sent.action || s.loadUint(16) !== sent.bucket ||
              s.loadUintBig(256) !== sent.position || s.loadUintBig(256) !== BigInt(`0x${sent.body.hash().toString('hex')}`)) continue;
          const notional = s.loadCoins(), im = s.loadCoins(), cm = s.loadCoins(), reason = s.loadUint(16); end(s);
          if (opcode === RVAK && (reason !== 0 || notional !== sent.notional || im !== sent.im || cm !== sent.cm)) continue;
          if (opcode === RVNK && reason === 0) continue;
        } else {
          if (opcode !== RPRS || s.loadUintBig(64).toString() !== queued.wireQueryId) continue;
          const lease = s.loadRef(); end(s);
          if (lease.bits.length !== 432 || lease.refs.length) continue;
          const p = lease.beginParse();
          if (p.loadUint(32) !== RPOL || p.loadUint(32) !== policy!.policyId || p.loadUint(32) !== request.marketId ||
              p.loadUint(32) !== policy!.registrationVersion) continue;
          p.loadUint(32); p.loadUint(32);
          if (p.loadUint(32) !== policy!.leaseSecs) continue;
        }
        replies.push(callback);
      } catch { /* Reject incomplete or conflicting callback envelopes. */ }
    }
    if (replies.length > 1) return null;
    if (!replies.length) return pending();
    const nextNode = replies[0], nextStates = await input.boundary(nextNode);
    if (!nextStates) return pending();
    const prior = nextStates.before.oracleRefreshes.get(request.marketId)?.get(owner);
    const next = nextStates.after.oracleRefreshes.get(request.marketId)?.get(owner);
    if (!prior?.order || !next?.order || !samePerpsAdmission(receipt, prior) || !samePerpsAdmission(receipt, next) ||
        prior.order.outcome !== 1 || prior.order.admissionPhase !== phase || next.order.admissionPhase < phase ||
        nextStates.before.riskVault !== target && phase === 1 ||
        nextStates.before.markets.get(request.marketId)?.riskPolicy?.controller !== target && phase === 2) return null;
    nodes.push(nextNode);
    const terminal = perpsOracleTradeTransition(nextStates.before, nextStates.after, owner, request);
    if (terminal) {
      if (next.completedAt !== String(nextNode.raw.utime) ||
          (next.order.outcome === 2 && (phase !== 2 || next.order.admissionPhase !== 2 ||
            !nextStates.after.markets.get(request.marketId)?.oraclePriceHealthy)) ||
          (phase === 1 && next.order.reason !== 8)) return null;
      return { receipt: next, nodes, execution: nextNode, states: nextStates };
    }
    if (phase !== 1 || next.order.outcome !== 1 || next.order.admissionPhase !== 2 ||
        JSON.stringify(perpsAccount(nextStates.before, owner)) !== JSON.stringify(perpsAccount(nextStates.after, owner)) ||
        JSON.stringify(perpsPosition(nextStates.before, owner, request.marketId)) !== JSON.stringify(perpsPosition(nextStates.after, owner, request.marketId)) ||
        JSON.stringify(perpsPending(nextStates.before, ownerWallet)) !== JSON.stringify(perpsPending(nextStates.after, ownerWallet))) return null;
    node = nextNode; states = nextStates; receipt = next;
  }
  return pending();
}
