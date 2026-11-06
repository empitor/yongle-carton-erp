import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Store, InputError, ConflictError } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { clampPage, parsePaging } from '../paging.js';
import {
  inboxChannels,
  inboxStatuses,
  inboxKinds,
  convertedKinds,
  type InboxIncoming,
} from '../../shared/inbox.js';

export const statusSchema = z.object({
  status: z.enum(inboxStatuses),
  convertedKind: z.enum(convertedKinds).optional(),
  convertedRef: z.string().optional(),
  expectedVersion: z.number().int().positive(),
});
export const convertSchema = z.strictObject({
  kind: z.enum(convertedKinds),
  expectedVersion: z.number().int().positive(),
});
/** 只依赖上传和切换类型，避免收件箱反向依赖整个导入模块。 */
export type InboxImportTarget = {
  upload(buffer: Buffer, fileName: string): Promise<{ workspace: any; duplicate?: boolean }>;
  setMode(id: string, raw: unknown): any;
};
export const filterSchema = z.object({
  status: z.enum(inboxStatuses).optional(),
  channel: z.enum(inboxChannels).optional(),
  q: z.string().optional(),
});
const incomingSchema = z.object({
  channel: z.enum(inboxChannels),
  externalId: z.string().min(1),
  senderId: z.string().optional(),
  senderName: z.string().optional(),
  conversation: z.string().optional(),
  kind: z.enum(inboxKinds),
  text: z.string().optional(),
  receivedAt: z.string().datetime({ offset: true }),
  file: z
    .object({ name: z.string(), mime: z.string(), bytes: z.instanceof(Uint8Array) })
    .optional(),
});
function rowView(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );
}
const searchFunctions = new WeakSet<Store['db']>();
// SQLite 内置 lower 只处理 ASCII。非 ASCII 沿用原列表的 JS 大小写规则。
const inboxScope = `
  WHERE ($channel IS NULL OR channel = $channel)
    AND ($q IS NULL OR (${['sender_name', 'conversation', 'text', 'file_name']
      .map((column) => `CASE
        WHEN $ascii AND octet_length(${column}) = length(${column})
          THEN instr(lower(${column}), lower($q))
        ELSE instr(inbox_unicode_lower(${column}), inbox_unicode_lower($q))
      END > 0`)
      .join(' OR ')}))`;
export class InboxService {
  constructor(private store: Store) {}
  ingest(input: InboxIncoming) {
    const v = incomingSchema.parse(input),
      db = this.store.db;
    const existing = db
      .prepare('SELECT * FROM inbox_items WHERE channel=? AND external_id=?')
      .get(v.channel, v.externalId);
    if (existing) return rowView(existing);
    if (v.file && v.file.bytes.byteLength > 20 * 1024 * 1024)
      throw new InputError('文件不能超过20MB');
    const hash = v.file ? createHash('sha256').update(v.file.bytes).digest('hex') : null;
    db.exec('SAVEPOINT inbox_ingest');
    try {
      if (v.file)
        db.prepare('INSERT OR IGNORE INTO inbox_files(sha256,content,size) VALUES(?,?,?)').run(
          hash,
          v.file.bytes,
          v.file.bytes.byteLength,
        );
      const result = db
        .prepare(
          `INSERT INTO inbox_items(channel,external_id,sender_id,sender_name,conversation,kind,text,file_name,file_mime,file_size,file_sha256,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          v.channel,
          v.externalId,
          v.senderId ?? '',
          v.senderName ?? '',
          v.conversation ?? '',
          v.kind,
          v.text ?? '',
          v.file?.name ?? null,
          v.file?.mime ?? null,
          v.file?.bytes.byteLength ?? null,
          hash,
          v.receivedAt,
          new Date().toISOString(),
        );
      const row = this.get(Number(result.lastInsertRowid));
      db.exec('RELEASE inbox_ingest');
      return row;
    } catch (e) {
      db.exec('ROLLBACK TO inbox_ingest; RELEASE inbox_ingest');
      throw e;
    }
  }
  has(channel: string, externalId: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM inbox_items WHERE channel=? AND external_id=?')
      .get(channel, externalId);
  }
  get(id: number) {
    const row = this.store.db.prepare('SELECT * FROM inbox_items WHERE id=?').get(id);
    if (!row) throw new ImportError('收件不存在', 404);
    return rowView(row);
  }
  file(id: number) {
    const row = this.store.db
      .prepare(
        'SELECT i.file_name,i.file_mime,f.content FROM inbox_items i JOIN inbox_files f ON f.sha256=i.file_sha256 WHERE i.id=?',
      )
      .get(id);
    if (!row) throw new ImportError('文件不存在', 404);
    return {
      name: String(row.file_name),
      mime: String(row.file_mime),
      content: row.content as Uint8Array,
    };
  }
  list(filters: z.input<typeof filterSchema> = {}, query: unknown = {}) {
    const f = filterSchema.parse(filters), paging = parsePaging(query), db = this.store.db;
    if (!searchFunctions.has(db)) {
      db.function('inbox_unicode_lower', { deterministic: true }, (value) =>
        typeof value === 'string' ? value.toLowerCase() : null,
      );
      searchFunctions.add(db);
    }
    const scope = { $channel: f.channel ?? null, $q: f.q || null, $ascii: /^[\x01-\x7f]*$/.test(f.q ?? '') ? 1 : 0 };
    const totalRecords = Number(db.prepare('SELECT COUNT(*) AS n FROM inbox_items').get()!.n);
    // 页签数字不受当前状态筛选影响，来源和关键词仍然生效。
    const counts = { pending: 0, converted: 0, ignored: 0 };
    let filteredRecords = 0;
    for (const group of db.prepare(`SELECT status, COUNT(*) AS n FROM inbox_items ${inboxScope} GROUP BY status`).all(scope)) {
      const status = group.status as keyof typeof counts, count = Number(group.n);
      counts[status] = count;
      if (!f.status || f.status === status) filteredRecords += count;
    }
    const page = paging.page && clampPage(paging.page, paging.pageSize, filteredRecords);
    // 显式 sort 沿用旧分页比较器；收件记录没有 name、number 或交期字段。
    const sort = page ? paging.sort ?? null : null;
    const rows = db.prepare(`SELECT * FROM inbox_items ${inboxScope}
      AND ($status IS NULL OR status = $status)
      ORDER BY CASE WHEN $sort = 'oldest' THEN id END ASC,
        CASE WHEN $sort IS NULL THEN received_at END DESC, id DESC
      LIMIT $limit OFFSET $offset`).all({
      ...scope,
      $status: f.status ?? null,
      $sort: sort,
      $limit: page ? paging.pageSize : -1,
      $offset: page ? (page - 1) * paging.pageSize : 0,
    });
    return {
      rows: rows.map(rowView), filteredRecords,
      ...(page ? { page, pageSize: paging.pageSize } : {}), totalRecords, counts,
    };
  }
  /**
   * 把收件转给 AI 导入：沿用原上传流程，原件、哈希和重复检查由它负责，不触发识别。
   * 页面和助手都走这里；已转过的直接返回原任务，重复点击不会再建一份。
   */
  async toImport(id: number, raw: unknown, actor: Actor, imports: InboxImportTarget) {
    requirePermission(actor, 'business:edit');
    const v = convertSchema.parse(raw),
      item = this.get(id) as any;
    if (item.status === 'converted' && item.convertedRef)
      return { workspaceId: String(item.convertedRef), item, reused: true };
    if (item.version !== v.expectedVersion)
      throw new ConflictError();
    if (!item.fileName) throw new InputError('这条内容没有文件，不能转入 AI 导入。');
    const file = this.file(id);
    const uploaded = await imports.upload(Buffer.from(file.content), file.name);
    let workspace = uploaded.workspace;
    if (v.kind !== 'order' && workspace.mode !== v.kind)
      workspace = imports.setMode(workspace.id, {
        expectedRevision: workspace.revision,
        mode: v.kind,
      });
    const next = this.setStatus(
      id,
      {
        status: 'converted',
        convertedKind: v.kind,
        convertedRef: workspace.id,
        expectedVersion: v.expectedVersion,
      },
      actor,
    );
    return { workspaceId: String(workspace.id), item: next, reused: false };
  }
  setStatus(id: number, input: z.input<typeof statusSchema>, actor: Actor) {
    requirePermission(actor, 'business:edit');
    const v = statusSchema.parse(input);
    this.get(id);
    const result = this.store.db
      .prepare(
        'UPDATE inbox_items SET status=?,converted_kind=?,converted_ref=?,handled_by=?,handled_at=?,version=version+1 WHERE id=? AND version=?',
      )
      .run(
        v.status,
        v.convertedKind ?? null,
        v.convertedRef ?? null,
        actor.id,
        new Date().toISOString(),
        id,
        v.expectedVersion,
      );
    if (!result.changes) throw new ConflictError();
    return this.get(id);
  }
}
