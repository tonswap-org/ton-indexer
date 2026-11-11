import { orderHash, orderJson } from '../orders/discovery';

/** A decoder-version/release-scoped fact derived from one fully verified original
 * boundary. It is not a current answer or a partially reconstructed tree. */
export type ArchiveBoundaryCheckpoint = {
  scope: string; account: string; lt: string; hash: string;
  previousLt: string; previousHash: string; before: string; after: string;
  seqno: number; unixTime: number; payload: unknown; digest: string;
};
export interface ArchiveCheckpointStore {
  archiveCheckpoints(scope: string, account: string): Promise<ArchiveBoundaryCheckpoint[]>;
  retainArchiveCheckpoint(checkpoint: ArchiveBoundaryCheckpoint): Promise<void>;
}
export const ARCHIVE_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;
const ltPattern = /^(0|[1-9][0-9]*)$/;
export function validateArchiveCheckpoint(value: ArchiveBoundaryCheckpoint): ArchiveBoundaryCheckpoint {
  const { digest, ...body } = value;
  if (!hashPattern.test(value.scope) || !/^0:[0-9a-f]{64}$/.test(value.account)
    || !ltPattern.test(value.lt) || BigInt(value.lt) <= 0n || BigInt(value.lt) >= 1n << 64n
    || !ltPattern.test(value.previousLt) || BigInt(value.previousLt) >= BigInt(value.lt)
    || ![value.hash, value.previousHash, value.before, value.after, digest].every(v => hashPattern.test(v))
    || (value.previousLt === '0') !== (value.previousHash === '0'.repeat(64))
    || !Number.isSafeInteger(value.seqno) || value.seqno < 0 || !Number.isSafeInteger(value.unixTime) || value.unixTime < 0
    || Buffer.byteLength(orderJson(value)) > 256 * 1024 || orderHash(body) !== digest)
    throw Error('Invalid immutable archive checkpoint');
  return value;
}
export function archiveCheckpoint(body: Omit<ArchiveBoundaryCheckpoint, 'digest'>): ArchiveBoundaryCheckpoint {
  return validateArchiveCheckpoint({ ...body, digest: orderHash(body) });
}

/** Every request walks its own exact head. Shared facts can survive restart and
 * head advance, but a fork can reuse only identical, physically linked hashes.
 * Atomic immutable inserts make concurrent requests safe without a live worker,
 * mutable cursor or lock held across network reads. */
export async function readArchiveCheckpointHistory(input: {
  scope: string; account: string; current: { lt: string; hash: string; shardHash: string; seqno: number; unixTime: number };
  store: ArchiveCheckpointStore; verify(lt: string, hash: string): Promise<ArchiveBoundaryCheckpoint>;
  signal?: AbortSignal; historyLimit: number;
  slice?: { rows: number; milliseconds: number };
}) {
  const slice = input.slice ?? { rows: 64, milliseconds: 8000 }, started = performance.now();
  if (!Number.isInteger(slice.rows) || slice.rows < 1 || slice.rows > 64 || slice.milliseconds < 0 || slice.milliseconds > 8000)
    throw Error('Invalid archive slice limit');
  input.signal?.throwIfAborted();
  const cached = await input.store.archiveCheckpoints(input.scope, input.account), lookup = new Map<string, ArchiveBoundaryCheckpoint>();
  if (cached.length > input.historyLimit) throw Error('Archive checkpoint history limit');
  let bytes = 0;
  for (const value of cached) {
    validateArchiveCheckpoint(value);
    bytes += Buffer.byteLength(orderJson(value));
    if (bytes > ARCHIVE_CHECKPOINT_BYTES) throw Error('Archive checkpoint byte limit');
    if (value.scope !== input.scope || value.account !== input.account) throw Error('Archive checkpoint scope mismatch');
    const key = `${value.lt}:${value.hash}`;
    if (lookup.has(key)) throw Error('Duplicate archive checkpoint');
    lookup.set(key, value);
  }
  let lt = input.current.lt, hash = input.current.hash, expected = input.current.shardHash, verified = 0;
  const rows: ArchiveBoundaryCheckpoint[] = [];
  while (lt !== '0') {
    input.signal?.throwIfAborted();
    if (rows.length >= input.historyLimit) throw Error('Archive history limit');
    if (rows.length % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    let row = lookup.get(`${lt}:${hash}`);
    if (!row) {
      if (verified >= slice.rows || performance.now() - started >= slice.milliseconds)
        return { complete: false as const, rows, verified };
      row = validateArchiveCheckpoint(await input.verify(lt, hash));
      input.signal?.throwIfAborted();
      if (row.scope !== input.scope || row.account !== input.account || row.lt !== lt || row.hash !== hash)
        throw Error('Verified archive checkpoint identity mismatch');
      // Validate the current-to-original link before durable admission too.
      if (row.after !== expected || row.seqno > input.current.seqno || row.unixTime > input.current.unixTime)
        throw Error('Archive checkpoint is outside the current chain');
      await input.store.retainArchiveCheckpoint(row);
      verified++;
    }
    if (row.after !== expected || row.seqno > input.current.seqno || row.unixTime > input.current.unixTime)
      throw Error('Archive checkpoint chain mismatch');
    rows.push(row); lt = row.previousLt; hash = row.previousHash; expected = row.before;
  }
  input.signal?.throwIfAborted();
  if (hash !== '0'.repeat(64)) throw Error('Archive history is not genesis linked');
  return { complete: true as const, rows, verified };
}
