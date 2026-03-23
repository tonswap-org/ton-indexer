import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoreSnapshot } from './store/memoryStore';

export const loadSnapshotFile = (path: string): StoreSnapshot | null => {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as StoreSnapshot;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveSnapshotFile = (path: string, snapshot: StoreSnapshot) => {
  const output = JSON.stringify(snapshot, null, 2) + '\n';
  const tmpPath = join(dirname(path), `.${Date.now()}.${Math.random().toString(16).slice(2)}.snapshot.tmp`);
  writeFileSync(tmpPath, output);
  renameSync(tmpPath, path);
};
