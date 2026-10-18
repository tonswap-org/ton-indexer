import { readFileSync, existsSync, rmSync } from 'node:fs';
import { writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StoreSnapshot } from './store/memoryStore';

// A fixed temporary path requires serialization, including callers that use
// different spellings of the same target. No unbounded files accumulate on ENOSPC.
const pendingWrites = new Map<string, Promise<void>>();

export const loadSnapshotFile = (path: string): StoreSnapshot | null => {
  const target = resolve(path);
  if (!pendingWrites.has(target)) {
    try { rmSync(`${target}.tmp`, { force: true }); } catch { /* Reading the durable file can still succeed. */ }
  }
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as StoreSnapshot;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export function writeSnapshotFile(path: string, snapshot: StoreSnapshot): Promise<void> {
  const target = resolve(path);
  // Encode now so a caller cannot mutate its snapshot while waiting for a writer.
  let output: string;
  try { output = `${JSON.stringify(snapshot)}\n`; } catch (error) { return Promise.reject(error); }
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const tmpPath = `${target}.tmp`;
    try {
      await writeFile(tmpPath, output);
      await rename(tmpPath, target);
    } finally {
      await rm(tmpPath, { force: true });
    }
  });
  pendingWrites.set(target, write);
  // Both handlers are present: observing cleanup must not create an unhandled
  // rejection when the caller correctly catches a failed save.
  const release = () => { if (pendingWrites.get(target) === write) pendingWrites.delete(target); };
  void write.then(release, release);
  return write;
}
