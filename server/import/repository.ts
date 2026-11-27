import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { failureRecord, type ImportFailureRecord } from './failure-record.js';
import {
  AppError,
  StoredDataError,
  count,
  defaultDbPath,
  exists,
  many,
  one,
  openVersionedSqlite,
  parseStoredJson,
  registerVersionedSqlite,
  rows,
} from '../core/index.js';
import { FAILURE_PAGE, runningTaskStates, type ImportWorkspaceView, type UnreadableWorkspace, type WorkspaceSummary } from '../../shared/import/index.js';
import {
  checkedForWrite,
  restartSubject,
  storedFailure,
  storedWorkspace,
  workspaceSummary,
  workspaceText,
  type Workspace,
} from './workspace-document.js';
/**
 * JSON 路径取值按 JS 真值判断的 SQL 片段：缺失、null、false、0、空串为假，
 * 对象和数组（含空的）以及其余值为真，与 `!!value` 一致。路径只能是代码里的常量。
 */
export function jsonTruthy(path: string, column = 'document') {
  const at = `${column},'${path}'`;
  return `(CASE json_type(${at}) WHEN 'object' THEN 1 WHEN 'array' THEN 1 WHEN 'true' THEN 1
    WHEN 'integer' THEN json_extract(${at})<>0 WHEN 'real' THEN json_extract(${at})<>0
    WHEN 'text' THEN json_extract(${at})<>'' ELSE 0 END)`;
}
type Task = NonNullable<ImportWorkspaceView['task']>;
// 列表上的一份（WorkspaceSummary）、读不出来的一份（UnreadableWorkspace）的类型在 shared/import/workspace-list.ts（页面也按它显示）
/** 列表最多列多少份 */
const LIST_LIMIT = 200;
/**
 * AI 识别工作区库（ai-imports/workspaces.sqlite）的结构，基线是 0.9.0 的第 3 版；表结构或工作区里存的字段变了，
 * 在 steps 加一步（规矩见 server/core/backup/versioned-sqlite-spec.ts 开头），识别到一半的工作留着。
 * 工作区按编号引用客户、产品、到货单；0.9.0 的业务库从空库开始、编号重新排，
 * 以前留下的工作区会对到别的档案上：0.8.4 留下的（没记版本）比基线旧，按配置库的统一规则打开时删掉重建。
 * 同一原件可以建多个识别任务：file_hash 只建普通索引，不唯一。
 */
const workspaceDatabase = {
  label: 'AI 识别工作区',
  baseline: 3,
  steps: [],
  pragmas: 'PRAGMA synchronous=FULL',
  create(db: DatabaseSync) {
    db.exec(`-- 原件按工作区存在 ai-imports/<编号>/，正式导入的原件另存 import-archive/

      -- 识别结果 JSON，归档标记也在里面；没有回收站表，不存“已核对”标记
      CREATE TABLE workspaces(id TEXT PRIMARY KEY,file_hash TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL);
      CREATE INDEX workspaces_hash ON workspaces(file_hash);
      -- 错误档案
      CREATE TABLE recognition_failures(id TEXT PRIMARY KEY,workspace_id TEXT,recorded_at TEXT NOT NULL,legacy_key TEXT UNIQUE,document TEXT NOT NULL);
      CREATE INDEX recognition_failure_workspace ON recognition_failures(workspace_id,recorded_at);`);
  },
};
/** AI 识别工作区的默认目录：业务库所在目录下的 ai-imports（server/index.ts 装配时给 ImportManager 的就是它） */
export const defaultWorkspaceDirectory = () => join(dirname(defaultDbPath), 'ai-imports');
// 默认位置登记进配置库登记表：恢复备份的维护命令行不打开工作区，
// 靠这一条认出备份里的 ai-imports/workspaces.sqlite；0.9.0 以前留下的（没记版本）在恢复之前就拒绝
registerVersionedSqlite(workspaceDatabase, () => join(defaultWorkspaceDirectory(), 'workspaces.sqlite'));

const documentRow = rows.workspaces.pick({ document: true });
const failureRow = rows.recognition_failures.pick({ document: true });
/**
 * 列表的一行：按路径取出摘要那几栏（文字、数字用 json_extract 直接取，任务用 `->` 取 JSON 原文再按结构认），
 * 不把整份工作区（原文分块、识别结果历史）解析出来；识别结果只要真假（jsonTruthy）。各栏和整份读时一样一定有。
 */
/** 按编号、版本号和几栏 JSON 取的一行：编号、版本号是表上的列，一定有；几栏的 JSON 拼成一段文字再按结构认 */
const pickedRow = z.object({ id: z.string(), revision: z.number(), picked: z.string(), hasDraft: z.number() });
/** 取几栏拼成一段 JSON 的 SQL（栏目名是代码里的常量） */
const pickedColumns = (names: readonly string[]) =>
  'json_object(' + names.map((n) => `'${n}',json(document->'$.${n}')`).join(',') + ')';
const SUMMARY_FIELDS = ['fileName', 'fileHash', 'createdAt', 'task', 'mode', 'arrivalDocId', 'arrivalSourceId'] as const;
const RESTART_FIELDS = ['id', 'revision', 'fileName', 'fileHash', 'size', 'parsed', 'task'] as const;
/** 还没结束的识别任务状态，SQL 里一种一个占位符 */
const RUNNING_SLOTS = runningTaskStates.map(() => '?').join(',');
/** 按结构认一份工作区的几栏：对不上的抛 StoredDataError（已记日志、带工作区编号），由调用方决定这一份怎么办 */
function readPicked<S extends z.ZodType>(schema: S, row: z.infer<typeof pickedRow>) {
  return parseStoredJson(schema, row.picked, `workspaces.document（工作区 ${row.id}）`);
}

/** 写进库的错误档案文字：先按结构认一遍（对不上见 checkedForWrite） */
function failureText(record: ImportFailureRecord) {
  checkedForWrite(storedFailure, record, `recognition_failures.document（${record.id}）`);
  return JSON.stringify(record);
}

export class ImportRepository {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = openVersionedSqlite(file, workspaceDatabase);
    this.recordInterrupted();
    // 重启恢复：程序关掉时还在跑、在排队的任务改成失败，让人重新识别。
    this.db
      .prepare(
        `UPDATE workspaces SET document=json_set(document,'$.task',json_object('state','failed','error','上次处理被程序关闭中断，请重新识别。')) WHERE json_extract(document,'$.task.state') IN (${RUNNING_SLOTS})`,
      )
      .run(...runningTaskStates);
  }
  /**
   * 失败、或者上次没跑完的任务如果没有错误档案（写档案时出错、程序被关掉），启动时补记一条，
   * 让错误记录页如实显示“当时没留下详细原因”。legacy_key 保证同一任务同一版只补一次。
   */
  private recordInterrupted() {
    const found = many(
      this.db,
      pickedRow,
      `SELECT id,revision,${pickedColumns(RESTART_FIELDS)} AS picked,0 AS hasDraft FROM workspaces
        WHERE json_extract(document,'$.task.state') IN ('failed',${RUNNING_SLOTS})`,
      ...runningTaskStates,
    );
    for (const row of found) {
      let w: z.infer<typeof restartSubject>;
      try {
        w = readPicked(restartSubject, row);
      } catch (error) {
        // 这一份对不上结构：已记日志（带编号），打开它的时候会照样报；不为它挡住整个工作区库和系统启动
        if (error instanceof StoredDataError) continue;
        throw error;
      }
      const legacyKey = w.id + ':' + w.revision;
      if (w.task.failureId && this.failure(w.task.failureId)) continue;
      if (exists(this.db, 'SELECT 1 FROM recognition_failures WHERE legacy_key=?', legacyKey)) continue;
      const r = failureRecord(
        new AppError(
          w.task.error || '上次任务被程序关闭中断，当时没有留下详细原因。',
          422,
          w.task.state === 'failed' ? 'no-detail' : 'interrupted',
        ),
        w,
        { operation: 'restart', stage: 'historical-summary' },
      );
      this.addFailure(r, legacyKey);
    }
  }
  get(id: string): Workspace | null {
    const r = one(this.db, documentRow, 'SELECT document FROM workspaces WHERE id=?', id);
    return r ? parseStoredJson(storedWorkspace, r.document, `workspaces.document（工作区 ${id}）`) : null;
  }
  addFailure(record: ImportFailureRecord, legacyKey?: string) {
    if (record.workspaceId && !this.has(record.workspaceId)) return;
    this.db
      .prepare('INSERT INTO recognition_failures(id,workspace_id,recorded_at,legacy_key,document) VALUES(?,?,?,?,?)')
      .run(
        record.id,
        record.workspaceId,
        record.recordedAt,
        legacyKey || null,
        failureText(record),
      );
  }
  failures(workspaceId?: string, offset = 0) {
    const filter = workspaceId ? ' WHERE workspace_id=?' : '',
      params = workspaceId ? [workspaceId] : [];
    const total = count(this.db, 'SELECT count(*) FROM recognition_failures' + filter, ...params);
    const items = many(
      this.db,
      failureRow,
      'SELECT document FROM recognition_failures' + filter + ' ORDER BY recorded_at DESC,rowid DESC LIMIT ? OFFSET ?',
      ...params,
      FAILURE_PAGE,
      offset,
    ).map((r) => parseStoredJson(storedFailure, r.document, 'recognition_failures.document'));
    return { items, total, offset, limit: FAILURE_PAGE };
  }
  failure(id: string) {
    const row = one(this.db, failureRow, 'SELECT document FROM recognition_failures WHERE id=?', id);
    return row ? parseStoredJson(storedFailure, row.document, `recognition_failures.document（${id}）`) : null;
  }
  /** 有没有这份工作区（不解析内容） */
  has(id: string) {
    return exists(this.db, 'SELECT 1 FROM workspaces WHERE id=?', id);
  }
  private documents(sql: string, ...params: string[]) {
    return many(this.db, documentRow, sql, ...params).map((r) =>
      parseStoredJson(storedWorkspace, r.document, 'workspaces.document'),
    );
  }
  byHashAll(hash: string) {
    return this.documents('SELECT document FROM workspaces WHERE file_hash=? ORDER BY rowid DESC', hash);
  }
  /**
   * 同一原件可以复用的任务：同一识别类型、没归档、没有识别结果、没关联到货原件或到货单。
   * 其余的（换过类型、已识别、已归档）都不能复用，重新上传要另建任务。
   */
  reusableByHash(hash: string, mode: string) {
    return this.documents(
      `SELECT document FROM workspaces WHERE file_hash=?
          AND COALESCE(json_extract(document,'$.archived'),0)=0
          AND json_extract(document,'$.mode')=?
          AND json_extract(document,'$.draft') IS NULL
          AND json_extract(document,'$.arrivalSourceId') IS NULL
          AND json_extract(document,'$.arrivalDocId') IS NULL
          ORDER BY rowid DESC`,
      hash,
      mode,
    );
  }
  /**
   * 列表只取摘要那几栏（不把整份工作区解析出来，识别结果只要真假）。哪一份的摘要对不上结构，
   * 单独列进 unreadable（编号、版本号、给人看的那句），别的照常列；它能照常永久删除。
   */
  list(): { workspaces: WorkspaceSummary[]; unreadable: UnreadableWorkspace[] } {
    const found = many(
      this.db,
      pickedRow,
      `SELECT id,revision,${pickedColumns(SUMMARY_FIELDS)} AS picked,${jsonTruthy('$.draft')} AS hasDraft
        FROM workspaces WHERE COALESCE(json_extract(document,'$.archived'),0)=0 ORDER BY rowid DESC LIMIT ?`,
      LIST_LIMIT,
    );
    const workspaces: WorkspaceSummary[] = [],
      unreadable: UnreadableWorkspace[] = [];
    for (const row of found) {
      try {
        workspaces.push({ id: row.id, revision: row.revision, ...readPicked(workspaceSummary, row), hasDraft: !!row.hasDraft });
      } catch (error) {
        if (!(error instanceof StoredDataError)) throw error;
        unreadable.push({ id: row.id, revision: row.revision, problem: error.message });
      }
    }
    return { workspaces, unreadable };
  }
  /**
   * 永久删除、初始化清空要知道的：版本号和关联的到货原件（要停掉它的识别）。只读这两样，
   * 内容别处对不上结构也删得掉；到货原件编号不是文字的当作没有（坏数据，没有要停的识别）。
   */
  deletionFacts(id: string) {
    const row = one(
      this.db,
      z.object({ revision: z.number(), arrivalSourceId: z.unknown().optional() }),
      "SELECT revision,json_extract(document,'$.arrivalSourceId') AS arrivalSourceId FROM workspaces WHERE id=?",
      id,
    );
    return row && { revision: row.revision, arrivalSourceId: typeof row.arrivalSourceId === 'string' ? row.arrivalSourceId : null };
  }
  allIds() {
    return many(this.db, z.object({ id: z.string() }), 'SELECT id FROM workspaces ORDER BY id').map((r) => r.id);
  }
  stats() {
    return {
      count: count(this.db, 'SELECT COUNT(*) FROM workspaces'),
      bytes: count(this.db, "SELECT COALESCE(SUM(json_extract(document,'$.size')),0) FROM workspaces"),
    };
  }
  insert(w: Workspace) {
    this.db
      .prepare('INSERT INTO workspaces(id,file_hash,revision,document) VALUES(?,?,?,?)')
      .run(w.id, w.fileHash, w.revision, workspaceText(w));
  }
  /** 按版本号写回：别人先改过（版本对不上）抛错。document 是 workspaceText 认过的文字 */
  save(w: Workspace, expected: number, document = workspaceText(w)) {
    const r = this.db
      .prepare('UPDATE workspaces SET revision=?,document=? WHERE id=? AND revision=?')
      .run(w.revision, document, w.id, expected);
    if (!r.changes) throw new Error('revision');
  }
  close() {
    this.db.close();
  }
  task(id: string, task: Task) {
    const w = this.get(id);
    if (!w) return;
    w.task = task;
    this.save(w, w.revision);
  }
  archived() {
    return many(
      this.db,
      z.object({ id: z.string(), revision: z.number(), fileName: z.string().nullable() }),
      "SELECT id,revision,json_extract(document,'$.fileName') AS fileName FROM workspaces WHERE json_extract(document,'$.archived')=1 ORDER BY rowid DESC",
    );
  }
  physicalDelete(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
      this.db.prepare('DELETE FROM recognition_failures WHERE workspace_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
