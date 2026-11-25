import { assertFreshHeadTime } from '../data/freshHead';
import type { ChainHead, ChainSource } from '../data/dataSource';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { collectProductPhysicalGraph, type ProductPhysicalGraph } from './productEvidence';

type ExecutionInput = Pick<Parameters<typeof collectProductPhysicalGraph>[3],
  'owner' | 'target' | 'body' | 'dispatch' | 'pins' | 'reader' | 'activity'> & {
    provesExecution(rows: OrderTransactionEvidence[]): boolean;
  };

/** Positive direct execution requires an uninterrupted current-to-dispatch interval for every
 * followed account, exact original message links, successful transactions and a product verdict. */
export async function collectProductExecutionGraph(source: ChainSource, store: PhysicalEvidenceStore, head: ChainHead,
  input: ExecutionInput, signal?: AbortSignal): Promise<ProductPhysicalGraph> {
  const { provesExecution, ...origin } = input;
  const graph = await collectProductPhysicalGraph(source, store, head, { ...origin, completeAccounts: [] }, signal);
  if (!graph.coverage.complete) return { coverage: graph.coverage, transactions: [] };
  const successful = graph.transactions.every(row => {
    const { tx, succeeded } = verifyOrderTransaction(row);
    return succeeded && !(tx.inMessage?.info.type === 'internal' && tx.inMessage.info.bounced);
  });
  if (!successful || !provesExecution(graph.transactions)) {
    return { coverage: { complete: false, gaps: [{ code: 'positive_execution_unproven', account: input.target }] }, transactions: [] };
  }
  assertFreshHeadTime(head.utime);
  signal?.throwIfAborted();
  return graph;
}
