import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { StoreSnapshot } from './store/memoryStore';

export const loadSnapshotFile = (path: string): StoreSnapshot | null => {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as StoreSnapshot;
  if (!parsed || parsed.version !== 1) return null;
  return parsed;
};

export const saveSnapshotFile = (path: string, snapshot: StoreSnapshot) => {
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
};
