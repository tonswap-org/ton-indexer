import type { Node, ProjectionInput } from './project';
import type { LedgerEvidenceRef } from './types';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { bodyCell, tokenWire, TRANSFER } from './wire';
import { launchpadCommand } from './launchpadWire';

export type LaunchpadOriginalRequest = {
  transaction: LedgerEvidenceRef; messageIndex: number; messageBodyHash: string; incomingBodyHash: string | null;
};
export type LaunchpadRequestIdentity = {
  kind: 'contribute' | 'bid' | 'claim'; sale: string; outerQueryId: string; innerQueryId: string | null;
  sourceWallet: string | null; forwardPayloadHash: string | null; originalRequest: LaunchpadOriginalRequest;
};
const address = (value?: string | null) => { try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; } };
export function launchpadOriginalRequest(anchor: Node, messageIndex: number): LaunchpadOriginalRequest {
  const body = bodyCell(anchor.raw.outMessages[messageIndex]);
  if (!body) throw Error('launchpad_original_request_body_unavailable');
  return { transaction: { account: anchor.account, lt: anchor.raw.lt, hash: canonicalLedgerHash(anchor.raw.hash), utime: anchor.raw.utime },
    messageIndex, messageBodyHash: body.hash().toString('hex'), incomingBodyHash: bodyCell(anchor.raw.inMessage)?.hash().toString('hex') ?? null };
}

/** Exact original requests remain observable before any recipient history or
 * settlement is available. This asserts neither acceptance nor delivered cash. */
export function readLaunchpadRequests(input: ProjectionInput, node: Node): LaunchpadRequestIdentity[] {
  if (node.account !== input.owner) return [];
  const controllers = new Set([...(input.launchpadControllers ?? []), ...(input.launchpadSales?.keys() ?? [])]);
  return node.raw.outMessages.flatMap((message, messageIndex): LaunchpadRequestIdentity[] => {
    if (message.bounced || address(message.source) !== input.owner) return [];
    const destination = address(message.destination), command = launchpadCommand(message);
    if (destination && controllers.has(destination) && command?.kind === 'claim') return [{
      kind: 'claim', sale: destination, outerQueryId: command.queryId, innerQueryId: null, sourceWallet: null, forwardPayloadHash: null,
      originalRequest: launchpadOriginalRequest(node, messageIndex),
    }];
    if (!destination || input.wallets.get(destination)?.owner !== input.owner) return [];
    const wire = tokenWire(message);
    if (wire?.op !== TRANSFER || !wire.owner || !controllers.has(wire.owner) || BigInt(wire.amountRaw) <= 0n) return [];
    const inner = launchpadCommand({ body: wire.forward.toBoc().toString('base64') });
    if (inner?.kind !== 'contribute' && inner?.kind !== 'bid') return [];
    return [{ kind: inner.kind, sale: wire.owner, outerQueryId: wire.queryId, innerQueryId: inner.queryId,
      sourceWallet: destination, forwardPayloadHash: wire.forward.hash().toString('hex'), originalRequest: launchpadOriginalRequest(node, messageIndex) }];
  });
}
