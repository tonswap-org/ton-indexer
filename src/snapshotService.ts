import { Config } from './config';
import { MemoryStore } from './store/memoryStore';
import { loadSnapshotFile, saveSnapshotFile } from './snapshot';

export class SnapshotService {
  private config: Config;
  private store: MemoryStore;

  constructor(config: Config, store: MemoryStore) {
    this.config = config;
    this.store = store;
  }

  save(path?: string) {
    const target = path ?? this.config.snapshotPath;
    if (!target) {
      throw new Error('SNAPSHOT_PATH not configured');
    }
    const snapshot = this.store.exportSnapshot();
    saveSnapshotFile(target, snapshot);
    return { path: target, entries: snapshot.entries.length };
  }

  load(path?: string) {
    const target = path ?? this.config.snapshotPath;
    if (!target) {
      throw new Error('SNAPSHOT_PATH not configured');
    }
    const snapshot = loadSnapshotFile(target);
    if (!snapshot) {
      throw new Error('Snapshot not found or invalid');
    }
    this.store.importSnapshot(snapshot);
    return { path: target, entries: snapshot.entries.length };
  }
}
