import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ErrorKnowledge } from '../core/types';

let SQL: SqlJsStatic;

async function getSQL(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export class SQLiteStore {
  private db!: Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const sql = await getSQL();

    // Load existing or create new
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new sql.Database(buffer);
    } else {
      this.db = new sql.Database();
    }

    this.db.run('PRAGMA journal_mode = OFF'); // sql.js 不支持 WAL，用内存模式
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS knowledge (
        group_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_updated ON knowledge(updated_at)
    `);
  }

  loadAll(): ErrorKnowledge[] {
    const rows = this.db.exec('SELECT data FROM knowledge ORDER BY updated_at DESC');
    if (rows.length === 0 || !rows[0].values) return [];

    return rows[0].values.map((row: unknown[]) => this.deserialize(row[0] as string));
  }

  upsert(knowledge: ErrorKnowledge): void {
    const data = this.serialize(knowledge);
    this.db.run(
      'INSERT OR REPLACE INTO knowledge (group_id, data, updated_at) VALUES (?, ?, ?)',
      [knowledge.groupId, data, Date.now()],
    );
    this.persist();
  }

  delete(groupId: string): void {
    this.db.run('DELETE FROM knowledge WHERE group_id = ?', [groupId]);
    this.persist();
  }

  private persist(): void {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const buffer = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(buffer));
  }

  close(): void {
    this.db.close();
  }

  private serialize(knowledge: ErrorKnowledge): string {
    const obj: Record<string, unknown> = { ...knowledge };
    if (knowledge.embedding) {
      obj.embedding = Array.from(knowledge.embedding);
    }
    return JSON.stringify(obj);
  }

  private deserialize(data: string): ErrorKnowledge {
    const obj = JSON.parse(data);
    if (Array.isArray(obj.embedding)) {
      obj.embedding = new Float32Array(obj.embedding);
    }
    obj.solutions = (obj.solutions || []).map((s: Record<string, unknown>) => ({
      ...s,
      suppressed: s.suppressed || false,
      verifiedCount: s.verifiedCount || 0,
    }));
    return obj as ErrorKnowledge;
  }
}
