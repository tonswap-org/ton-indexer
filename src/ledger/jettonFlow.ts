import type { RawTransaction } from '../data/dataSource';
import type { LedgerAsset } from './types';
import { canonicalLedgerAddress } from './normalize';
import { INTERNAL, SETTLEMENT_INTERNAL, TRANSFER, messageKey, tokenWire, type TokenWire } from './wire';

type PhysicalNode = { account: string; raw: RawTransaction };
type FlowIssue = 'jetton_counterparty_identity_unresolved' | 'jetton_settlement_unconfirmed' | 'jetton_debit_request_unverified';
export type PhysicalJettonFlow<N extends PhysicalNode> =
  | { kind: 'irrelevant' }
  | { kind: 'unresolved'; issue: FlowIssue; recipient?: N }
  | { kind: 'matched'; sourceAsset: LedgerAsset; recipientAsset: LedgerAsset; destination: string;
      recipient: N; wire: TokenWire; request: TokenWire; typed: boolean };

const address = (value?: string) => {
  try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; }
};
const succeeded = (raw: RawTransaction) => raw.success && (!raw.status || raw.status === 'success');

/** Match one physical debit request to its exact internal-transfer receipt.
 * Wallet identities, historical code/balance transitions and history coverage
 * are qualified by the caller. This match has no selected-owner restriction. */
export function matchPhysicalJettonFlow<N extends PhysicalNode>(
  source: N, outIndex: number, wallets: ReadonlyMap<string, LedgerAsset>, recipient: N | null,
): PhysicalJettonFlow<N> {
  const sourceAsset = wallets.get(source.account), message = source.raw.outMessages[outIndex];
  const wire = tokenWire(message);
  if (!sourceAsset || !wire || ![INTERNAL, SETTLEMENT_INTERNAL].includes(wire.op)) return { kind: 'irrelevant' };
  const destination = address(message.destination), recipientAsset = destination ? wallets.get(destination) : null;
  if (!recipientAsset || sourceAsset.master !== recipientAsset.master || wire.owner !== sourceAsset.owner || address(message.source) !== source.account)
    return { kind: 'unresolved', issue: 'jetton_counterparty_identity_unresolved' };
  if (!recipient || recipient.account !== destination || !messageKey(message) || messageKey(message) !== messageKey(recipient.raw.inMessage) ||
      !succeeded(source.raw) || !succeeded(recipient.raw) || message.bounced || recipient.raw.inMessage?.bounced)
    return { kind: 'unresolved', issue: 'jetton_settlement_unconfirmed' };
  const typed = wire.op === SETTLEMENT_INTERNAL, request = tokenWire(source.raw.inMessage);
  const requestMatches = request?.op === TRANSFER && address(source.raw.inMessage?.source) === sourceAsset.owner &&
    request.owner === recipientAsset.owner && request.queryId === wire.queryId && request.amountRaw === wire.amountRaw && request.forward.hash().equals(wire.forward.hash());
  const typedMarker = typed && request?.custom?.bits.length === 32 && request.custom.refs.length === 0 &&
    request.custom.beginParse().preloadUint(32) === 0x4a535454 && wire.response === source.account;
  if (!requestMatches || typed && !typedMarker) return { kind: 'unresolved', issue: 'jetton_debit_request_unverified', recipient };
  return { kind: 'matched', sourceAsset, recipientAsset, destination: destination!, recipient, wire, request: request!, typed };
}
