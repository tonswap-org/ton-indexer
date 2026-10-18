import type { ChainHead } from '../data/dataSource';

export type OwnerCycle = { boundary: ChainHead; signal?: AbortSignal };
export type DependencyRefresh = {
  account: string;
  /** Stored generation after this attempt, including an unchanged prior generation. */
  generation: string | null;
  head: { lt: string; hash: string } | null;
  /** The stored chain links to genesis; independent from freshness. */
  complete: boolean;
  /** The stored head equals the account head read at the cycle boundary. */
  atBoundary: boolean;
  errorCode: string | null;
};
/** Never throws: a failed refresh preserves the stored facts and reports its reason. */
export type RefreshDependency = (account: string, cycle: OwnerCycle) => Promise<DependencyRefresh>;
