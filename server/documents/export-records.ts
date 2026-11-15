import { z } from 'zod';
import type { Store } from '../core/index.js';
import { count, many, one, parseStoredJson, rows } from '../core/index.js';
import {
  documentFormats,
  documentKinds,
  exportOptionsSchema,
  templateSnapshotSchema,
  type DocumentExport,
  type DocumentFormat,
  type DocumentKind,
  type DocumentTemplate,
  type ExportOptions,
} from '../../shared/documents/index.js';
import { DAY_MS } from '../../shared/core/index.js';
// 导出记录表 document_exports 的读写：存一份导出（含文件内容）、按编号读回对外的导出记录、读文件内容、
// 记已下载、已交付完成，过了保存期只清文件内容。权限、核对和改业务状态在 service.ts。

/** 导出文件内容保留多少天：过期后只清文件内容，导出记录留着；还要这份文件就重新导出 */
export const EXPORT_FILE_KEEP_DAYS = 180;
/** 过了保存期的导出文件只清内容（bytes 置空），行、摘要、模板快照都留着。返回清了几份 */
export function purgeExportFiles(store: Store, keepDays = EXPORT_FILE_KEEP_DAYS, now = new Date()) {
  const cutoff = new Date(now.getTime() - keepDays * DAY_MS).toISOString();
  return Number(
    store.db
      .prepare('UPDATE document_exports SET bytes=NULL WHERE bytes IS NOT NULL AND created_at<?')
      .run(cutoff).changes,
  );
}
/** 这个请求编号存过导出没有：存过返回当时的摘要（同一请求再来原样返回，换了内容拒绝） */
export function exportDigest(store: Store, id: string): string | undefined {
  return one(store.db, rows.document_exports.pick({ digest: true }), 'SELECT digest FROM document_exports WHERE id=?', id)?.digest;
}
/**
 * 要写进 options 列的文字：写之前按读出时的同一份结构核对。对不上是服务端自己拼错了，
 * 按服务端错误报（回 500、记日志），不当成“输入不对”。
 */
function optionsText(options: ExportOptions, id: string) {
  const checked = exportOptionsSchema.safeParse(options);
  if (!checked.success)
    throw new Error('导出记录的 options 不合结构，没有写入（导出 ' + id + '）：' + z.prettifyError(checked.error), { cause: checked.error });
  return JSON.stringify(checked.data);
}
/** 存一份导出：一次导出一行，文件内容原样存；不按列查的内容放 options（写之前按读出时的同一份结构核对） */
export function insertExport(
  store: Store,
  e: {
    id: string;
    digest: string;
    kind: DocumentKind;
    recordId: number;
    actorId: string;
    format: DocumentFormat;
    filename: string;
    sha256: string;
    templateId: string;
    templateRevision: number;
    batchNumber: string | null;
    shipDate: string | null;
    options: ExportOptions;
    templateSnapshot: DocumentTemplate;
    bytes: Buffer;
  },
) {
  store.db
    .prepare(
      'INSERT INTO document_exports(id,digest,record_kind,record_id,actor_id,format,filename,sha256,size,template_id,template_revision,batch_number,ship_date,created_at,options,template_snapshot,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      e.id,
      e.digest,
      e.kind,
      e.recordId,
      e.actorId,
      e.format,
      e.filename,
      e.sha256,
      e.bytes.length,
      e.templateId,
      e.templateRevision,
      e.batchNumber,
      e.shipDate,
      new Date().toISOString(),
      optionsText(e.options, e.id),
      JSON.stringify(e.templateSnapshot),
      e.bytes,
    );
}
/** 读导出记录要的列：除了摘要和文件内容，文件内容只看还在不在（建表的 CHECK 限定了种类和格式） */
const exportRow = rows.document_exports
  .omit({ digest: true, bytes: true })
  .extend({ record_kind: z.enum(documentKinds), format: z.enum(documentFormats), file_expired: z.number() });
const exportColumns =
  'id,record_kind,record_id,actor_id,format,filename,sha256,size,template_id,template_revision,batch_number,ship_date,created_at,delivered_at,completed_at,options,template_snapshot,bytes IS NULL AS file_expired';
/** 把 document_exports 的一行拼回对外的导出记录（字段名是前端和助手在用的，不能改）；不含文件内容 */
function view(row: z.output<typeof exportRow>): DocumentExport {
  const where = (column: string) => 'document_exports.' + column + '（导出 ' + row.id + '）';
  return {
    kind: row.record_kind,
    id: row.record_id,
    format: row.format,
    ...parseStoredJson(exportOptionsSchema, row.options, where('options')),
    requestId: row.id,
    actorId: row.actor_id,
    filename: row.filename,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    completedAt: row.completed_at,
    shipDate: row.ship_date,
    templateId: row.template_id,
    templateRevision: row.template_revision,
    templateSnapshot: parseStoredJson(templateSnapshotSchema, row.template_snapshot, where('template_snapshot')),
    // 文件内容过了保存期已清掉（purgeExportFiles）：再下载返回 410，要这份文件就用新的请求号重新导出
    fileExpired: row.file_expired !== 0,
    ...(row.record_kind === 'purchase' ? { batchNumber: row.batch_number } : {}),
  };
}
/** 按编号读回导出记录；文件内容（bytes）不在这里读，只看它还在不在。没有返回 null */
export function readExport(store: Store, id: string): DocumentExport | null {
  const row = one(store.db, exportRow, 'SELECT ' + exportColumns + ' FROM document_exports WHERE id=?', id);
  return row ? view(row) : null;
}
/**
 * 最近的导出（新的在前），助手的 exports.list、jobs.status 用。actorId 给了只看这个账号导出的，
 * pending 只看还没交付完成的；文件内容不读。
 */
export function listExports(
  store: Store,
  filter: { actorId?: string; pending?: boolean },
  page: { limit: number; offset: number },
): { total: number; rows: DocumentExport[] } {
  const where = [filter.actorId ? 'actor_id=?' : '', filter.pending ? 'completed_at IS NULL' : ''].filter(Boolean),
    sql = where.length ? ' WHERE ' + where.join(' AND ') : '',
    params = filter.actorId ? [filter.actorId] : [];
  const total = count(store.db, 'SELECT count(*) FROM document_exports' + sql, ...params);
  const found = many(
    store.db,
    exportRow,
    'SELECT ' + exportColumns + ' FROM document_exports' + sql + ' ORDER BY created_at DESC,id LIMIT ? OFFSET ?',
    ...params,
    page.limit,
    page.offset,
  ).map(view);
  return { total, rows: found };
}
/** 文件内容；过了保存期已清掉的返回 null */
export function exportBytes(store: Store, id: string): Buffer | null {
  const row = one(store.db, rows.document_exports.pick({ bytes: true }), 'SELECT bytes FROM document_exports WHERE id=?', id);
  return row?.bytes == null ? null : Buffer.from(row.bytes);
}
/** 记下文件已经完整发给浏览器；只记第一次，重复下载不变 */
export function markDelivered(store: Store, id: string) {
  store.db
    .prepare('UPDATE document_exports SET delivered_at=? WHERE id=? AND delivered_at IS NULL')
    .run(new Date().toISOString(), id);
}
/** 记下交付完成（业务状态已经跟着改了）；只记第一次 */
export function markCompleted(store: Store, id: string) {
  store.db
    .prepare('UPDATE document_exports SET completed_at=? WHERE id=? AND completed_at IS NULL')
    .run(new Date().toISOString(), id);
}
