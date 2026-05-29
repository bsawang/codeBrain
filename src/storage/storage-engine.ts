import { ErrorKnowledge, StorageStats } from '../core/types';
import { MemoryIndex } from '../core/memory-index';
import { SQLiteStore } from './sqlite-store';
import path from 'path';
import os from 'os';

const CODEBRAIN_HOME = path.join(os.homedir(), '.codebrain');

export function getDefaultDbPath(): string {
  return path.join(CODEBRAIN_HOME, 'knowledge.db');
}

export class StorageEngine {
  private index: MemoryIndex;
  private disk: SQLiteStore;

  constructor(dbPath?: string) {
    this.index = new MemoryIndex();
    this.disk = new SQLiteStore(dbPath || getDefaultDbPath());
  }

  async initialize(): Promise<void> {
    await this.disk.init();
    const all = this.disk.loadAll();
    for (const knowledge of all) {
      if (knowledge.status !== 'deprecated') {
        this.index.add(knowledge);
      }
    }
  }

  getIndex(): MemoryIndex {
    return this.index;
  }

  async upsert(knowledge: ErrorKnowledge): Promise<void> {
    // 1. 内存即时更新
    this.index.update(knowledge);
    // 2. 磁盘异步写入
    await Promise.resolve(); // 非阻塞
    this.disk.upsert(knowledge);
  }

  async stats(): Promise<StorageStats> {
    return {
      totalGroups: this.index.size,
      totalEvents: this.index.getAll().reduce((sum, k) => sum + k.occurrences, 0),
      lastUpdate: Date.now(),
    };
  }

  close(): void {
    this.disk.close();
  }
}
