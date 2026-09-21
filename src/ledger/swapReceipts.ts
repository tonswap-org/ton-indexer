import type { AccountSwapExecution } from '../indexerService';
import type { IndexedTx, Network } from '../models';
import type { LedgerEvent, LedgerPage, LedgerQuery } from './types';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { bodyCell, protocolForward, tokenWire, TRANSFER } from './wire';

export type SwapLedgerReader = (owner: string, query: LedgerQuery) => Promise<LedgerPage>;
const address = (value?: string | null) => { try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; } };
const hash = (value: string) => { try { return canonicalLedgerHash(value); } catch { return null; } };
const raw = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,35})$/.test(value) && BigInt(value) < 1n << 120n;
const positive = (value: unknown): value is string => raw(value) && BigInt(value) > 0n;
const displayIssues = new Set(['jetton_decimals_unresolved', 'transaction_fee_unavailable']);

/** Enrich a request only from a qualified owner-ledger receipt, bound to the
 * original wallet transaction and its exact outgoing transfer body. Query IDs,
 * symbols, pool acknowledgements and current balances are never identities.
 */
export async function enrichSwapReceipts(network: Network, owner: string, swaps: AccountSwapExecution[],
  transactions: readonly IndexedTx[], read: SwapLedgerReader): Promise<void> {
  if (!swaps.length) return;
  let generation: string | null = null, cursor: string | undefined;
  const events = new Map<string, LedgerEvent>(), cursors = new Set<string>();
  const fromUtime = Math.min(...swaps.map(swap => swap.utime)), toUtime = Math.floor(Date.now() / 1000) + 1;
  try {
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await read(owner, { fromUtime, toUtime, limit: 500, ...(cursor ? { cursor } : {}) });
      if (page.network !== network || address(page.account) !== owner || !page.coverage.snapshotComplete ||
        !page.coverage.generation || generation && page.coverage.generation !== generation) return;
      generation = page.coverage.generation;
      for (const event of page.events) {
        if (events.has(event.id)) return; // Duplicate pagination cannot establish uniqueness.
        events.set(event.id, event);
      }
      if (page.nextCursor === null) break;
      if (!page.nextCursor || cursors.has(page.nextCursor) || pageIndex === 9) return;
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    for (const swap of swaps) {
      if (swap.status !== 'success') continue;
      const originalHash = hash(swap.hash);
      if (!originalHash) continue;
      const originals = transactions.filter(tx => tx.lt === swap.lt && hash(tx.hash) === originalHash);
      if (originals.length !== 1) continue;
      const original = originals[0];
      const requests = original.outMessages.flatMap(message => {
        const wire = tokenWire(message), body = bodyCell(message), forward = wire && protocolForward(wire.forward);
        return wire?.op === TRANSFER && body && address(message.source) === owner &&
          wire.queryId === swap.queryId && wire.amountRaw === swap.requestedPayAmount && wire.owner && forward?.operation === 'swap'
          ? [{ wire, forward, wallet: address(message.destination), bodyHash: body.hash().toString('hex') }] : [];
      });
      if (requests.length !== 1) continue;
      const request = requests[0];
      const matches = [...events.values()].flatMap(event => {
        const settlement = event.settlement;
        if (event.network !== network || address(event.account) !== owner || event.status !== 'success' || event.kind !== 'swap' ||
          settlement?.status !== 'confirmed' || settlement.protocol !== 'dlmm' || settlement.operation !== 'swap' ||
          settlement.queryId !== request.forward.queryId || address(settlement.pool) !== request.wire.owner ||
          event.issues.some(issue => !displayIssues.has(issue))) return [];
        const originalEvidence = event.movements.some(movement => movement.evidence.transactionStatus === 'success' &&
          movement.evidence.transactions?.some(ref => address(ref.account) === owner && ref.lt === swap.lt && hash(ref.hash) === originalHash));
        if (!originalEvidence) return [];
        const debit = event.movements.filter(movement => movement.direction === 'out' && movement.asset.kind === 'jetton' &&
          address(movement.source) === owner && address(movement.destination) === request.wire.owner &&
          address(movement.asset.owner) === owner && address(movement.asset.wallet) === request.wallet &&
          movement.amountRaw === request.wire.amountRaw && movement.evidence.kind === 'jetton_transfer' &&
          movement.evidence.requestBodyHash === request.bodyHash);
        if (debit.length !== 1 || !address(debit[0].asset.master) ||
          debit[0].asset.id !== `${network}:jetton:${debit[0].asset.master}`) return [];
        const m = settlement.dlmmSwap;
        if (!m || !positive(m.paidInputRaw) || !raw(m.consumedInputRaw) || !raw(m.returnedInputRaw) || !raw(m.outputRaw) ||
          m.paidInputRaw !== request.wire.amountRaw || BigInt(m.paidInputRaw) !== BigInt(m.consumedInputRaw) + BigInt(m.returnedInputRaw) ||
          (m.outputRaw === '0' ? m.consumedInputRaw !== '0' || m.returnedInputRaw !== m.paidInputRaw : !positive(m.consumedInputRaw)) ||
          m.inputMovementId !== debit[0].id || address(request.forward.owner) !== owner) return [];
        const evidenceKey = (ref: {account: string; lt: string; hash: string; utime: number}) =>
          `${address(ref.account)}:${ref.lt}:${hash(ref.hash)}:${ref.utime}`;
        const settlementEvidence = new Set(settlement.evidence.map(evidenceKey));
        if (address(m.acceptance.account) !== request.wire.owner || !hash(m.acceptance.hash) || !settlementEvidence.has(evidenceKey(m.acceptance)) ||
          m.finalizations.length !== Number(m.outputRaw !== '0') + Number(m.returnedInputRaw !== '0') ||
          new Set(m.finalizations.map(evidenceKey)).size !== m.finalizations.length || m.finalizations.some(ref =>
            address(ref.account) !== request.wire.owner || !hash(ref.hash) || BigInt(ref.lt) <= BigInt(m.acceptance.lt) || !settlementEvidence.has(evidenceKey(ref)))) return [];
        const cash = event.movements.filter(movement => movement.asset.kind !== 'native');
        const incoming = (id: string | null, amount: string, refund: boolean) => cash.filter(movement => movement.id === id &&
          movement.direction === 'in' && movement.asset.kind === 'jetton' && address(movement.asset.owner) === owner &&
          address(movement.destination) === owner && address(movement.source) === request.wire.owner &&
          (refund ? movement.asset.master === debit[0].asset.master && address(movement.asset.wallet) === request.wallet : movement.asset.master !== debit[0].asset.master) &&
          !!address(movement.asset.master) && !!address(movement.asset.wallet) && movement.asset.id === `${network}:jetton:${movement.asset.master}` &&
          movement.amountRaw === amount && positive(amount) && movement.evidence.kind === 'jetton_transfer' && movement.evidence.transactions?.length === 2);
        const credits = incoming(m.outputMovementId, m.outputRaw, false), refunds = incoming(m.refundMovementId, m.returnedInputRaw, true);
        if ((m.outputRaw === '0' ? m.outputMovementId !== null || credits.length : credits.length !== 1) ||
          (m.returnedInputRaw === '0' ? m.refundMovementId !== null || refunds.length : refunds.length !== 1) ||
          cash.length !== 1 + credits.length + refunds.length || new Set(cash.map(movement => movement.id)).size !== cash.length) return [];
        return [{ event, credit: credits[0], consumed: m.consumedInputRaw, returned: m.returnedInputRaw }];
      });
      if (matches.length !== 1) continue;
      swap.payAmount = matches[0].consumed;
      swap.returnedPayAmount = matches[0].returned;
      // A fully returned request has no output receipt. Publishing zero input
      // consumption and its return still distinguishes it from an unknown send.
      if (matches[0].credit) {
        swap.receiveAmount = matches[0].credit.amountRaw;
        swap.receiveAmountSource = 'actual';
        swap.receipt = { ledgerEventId: matches[0].event.id, generation: generation!, assetId: matches[0].credit.asset.id };
      }
    }
  } catch {
    // Missing durable evidence never turns a request or minimum into a receipt.
  }
}
