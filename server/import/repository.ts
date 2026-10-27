import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { failureRecord, type ImportFailureRecord } from './failure-record.js';
import { ImportError } from './errors.js';
export class ImportRepository {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      `PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,file_hash TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL);`,
    );
    // 旧库的 file_hash 唯一约束会阻止“同一原件重新建立导入任务”，迁移为普通索引。
    const table = this.db
      .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='workspaces'")
      .get() as { sql?: string } | undefined;
    if (table?.sql && /file_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(table.sql)) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .exec(`CREATE TABLE workspaces_v2(id TEXT PRIMARY KEY,file_hash TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL);
        INSERT INTO workspaces_v2 SELECT id,file_hash,revision,document FROM workspaces;
        DROP TABLE workspaces; ALTER TABLE workspaces_v2 RENAME TO workspaces;`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS workspaces_hash ON workspaces(file_hash)');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS recognition_failures(id TEXT PRIMARY KEY,workspace_id TEXT,recorded_at TEXT NOT NULL,legacy_key TEXT UNIQUE,document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recognition_failure_workspace ON recognition_failures(workspace_id,recorded_at);`);
    // Historical task summaries have no upstream details; preserve them honestly once.
    for (const row of this.db
      .prepare(
        "SELECT document FROM workspaces WHERE json_extract(document,'$.task.state') IN ('failed','running','queued','backoff')",
      )
      .all()) {
      const w = JSON.parse(String(row.document)),
        legacyKey = w.id + ':' + w.revision;
      if (w.task.failureId && this.failure(w.task.failureId)) continue;
      if (this.db.prepare('SELECT 1 FROM recognition_failures WHERE legacy_key=?').get(legacyKey))
        continue;
      const r = failureRecord(
        new ImportError(
          w.task.error || '上次任务被程序关闭中断；旧版未保存上游详细原因。',
          422,
          w.task.state === 'failed' ? 'legacy-summary' : 'interrupted',
        ),
        w,
        { operation: 'restart', stage: 'historical-summary' },
      );
      this.addFailure(r, legacyKey);
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_trash(id TEXT PRIMARY KEY,document TEXT NOT NULL,removed_at TEXT NOT NULL)',
    );
    this.db.exec(
      `UPDATE workspaces SET document=json_set(document,'$.task',json_object('state','failed','error','上次处理被程序关闭中断，请重新识别。')) WHERE json_extract(document,'$.task.state') IN ('running','queued','backoff')`,
    );
  }
  get(id: string): any | null {
    const r = this.db.prepare('SELECT document FROM workspaces WHERE id=?').get(id) as any;
    return r ? JSON.parse(r.document) : null;
  }
  addFailure(record: ImportFailureRecord, legacyKey?: string) {
    this.db
      .prepare('INSERT INTO recognition_failures VALUES(?,?,?,?,?)')
      .run(
        record.id,
        record.workspaceId,
        record.recordedAt,
        legacyKey || null,
        JSON.stringify(record),
      );
  }
  failures(workspaceId?: string, offset = 0) {
    const filter = workspaceId ? ' WHERE workspace_id=?' : '',
      params = workspaceId ? [workspaceId] : [];
    const total = Number(
      this.db.prepare('SELECT count(*) AS n FROM recognition_failures' + filter).get(...params)!.n,
    );
    const items = this.db
      .prepare(
        'SELECT document FROM recognition_failures' +
          filter +
          ' ORDER BY recorded_at DESC,rowid DESC LIMIT 50 OFFSET ?',
      )
      .all(...params, offset)
      .map((r) => JSON.parse(String(r.document)) as ImportFailureRecord);
    return { items, total, offset, limit: 50 };
  }
  failure(id: string) {
    const row = this.db.prepare('SELECT document FROM recognition_failures WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.document)) as ImportFailureRecord) : null;
  }
  byHash(hash: string): any | null {
    const r = this.db
      .prepare('SELECT document FROM workspaces WHERE file_hash=? ORDER BY rowid DESC LIMIT 1')
      .get(hash) as any;
    return r ? JSON.parse(r.document) : null;
  }
  byHashAll(hash: string): any[] {
    return this.db
      .prepare('SELECT document FROM workspaces WHERE file_hash=? ORDER BY rowid DESC')
      .all(hash)
      .map((r: any) => JSON.parse(r.document));
  }
  list(): { id: string; fileName: string; createdAt: string }[] {
    return this.db
      .prepare('SELECT document FROM workspaces ORDER BY rowid DESC LIMIT 200')
      .all()
      .map((r: any) => {
        const w = JSON.parse(r.document);
        return {
          id: w.id,
          fileName: w.fileName,
          fileHash: w.fileHash,
          createdAt: w.createdAt,
          task: w.task || { state: w.draft ? 'ready' : 'uploaded' },
          reviewed: w.confirmedRevision === w.revision,
          hasDraft: !!w.draft,
          mode: w.mode || 'order',
          arrivalDocId: w.arrivalDocId ?? null,
          arrivalSourceId: w.arrivalSourceId ?? null,
        };
      });
  }
  stats() {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(document,'$.size')),0) AS bytes FROM (SELECT document FROM workspaces UNION ALL SELECT document FROM workspace_trash)",
      )
      .get() as { count: number; bytes: number };
    return r;
  }
  insert(w: any) {
    this.db
      .prepare('INSERT INTO workspaces VALUES(?,?,?,?)')
      .run(w.id, w.fileHash, w.revision, JSON.stringify(w));
  }
  save(w: any, expected: number) {
    const r = this.db
      .prepare('UPDATE workspaces SET revision=?,document=? WHERE id=? AND revision=?')
      .run(w.revision, JSON.stringify(w), w.id, expected);
    if (!r.changes) throw new Error('revision');
  }
  close() {
    this.db.close();
  }
  task(id: string, task: unknown) {
    const w = this.get(id);
    if (!w) return;
    w.task = task;
    this.save(w, w.revision);
  }
  remove(id: string) {
    const w = this.get(id);
    if (!w) throw new Error('missing');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO workspace_trash VALUES(?,?,?)')
        .run(id, JSON.stringify(w), new Date().toISOString());
      this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  trash() {
    return this.db
      .prepare(
        "SELECT id,json_extract(document,'$.fileName') AS fileName,removed_at AS removedAt FROM workspace_trash ORDER BY removed_at DESC",
      )
      .all();
  }
  forgetTrash(id: string) {
    this.db.prepare('DELETE FROM workspace_trash WHERE id=?').run(id);
  }
  restore(id: string) {
    const row = this.db.prepare('SELECT document FROM workspace_trash WHERE id=?').get(id);
    if (!row) throw new Error('missing');
    const w = JSON.parse(String(row.document));
    if (this.get(w.id)) throw new Error('duplicate');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insert(w);
      this.db.prepare('DELETE FROM workspace_trash WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return w;
  }
}
