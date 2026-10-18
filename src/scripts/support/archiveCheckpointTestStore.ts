import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { orderJson } from '../../orders/discovery';
import { validateArchiveCheckpoint, type ArchiveBoundaryCheckpoint, type ArchiveCheckpointStore } from '../../runtime/archiveCheckpoint';

/** Capture harness only. Optional append-only journal proves collector restart
 * behavior; production persistence is independently tested through PostgreSQL SQL. */
export function archiveCheckpointTestStore(journal?: string): ArchiveCheckpointStore {
  const rows = new Map<string, ArchiveBoundaryCheckpoint>();
  const key = (r: ArchiveBoundaryCheckpoint) => `${r.scope}:${r.account}:${r.lt}:${r.hash}`;
  const add = (r: ArchiveBoundaryCheckpoint) => {
    validateArchiveCheckpoint(r); const previous = rows.get(key(r));
    if (previous && orderJson(previous) !== orderJson(r)) throw Error('Immutable archive checkpoint conflict');
    rows.set(key(r), structuredClone(r)); return !previous;
  };
  if (journal && existsSync(journal)) for (const line of readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean)) add(JSON.parse(line));
  return {
    archiveCheckpoints: async (scope, account) => [...rows.values()].filter(r => r.scope === scope && r.account === account).map(r => structuredClone(r)),
    retainArchiveCheckpoint: async row => { if (add(row) && journal) appendFileSync(journal, JSON.stringify(row) + '\n', { mode: 0o600 }); },
  };
}
