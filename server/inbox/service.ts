import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Store, InputError, ConflictError, exists, notFound, one } from '../core/index.js';
import { fileRow, itemRow, itemView, listInbox } from './item-list.js';
import type { Actor } from '../core/index.js';
import { audit, inSavepoint, requirePermission } from '../core/index.js';
import { AppError } from '../core/index.js';
import {
  INBOX_MAX_FILE,
  INBOX_MAX_FILE_TEXT,
  inboxChannels,
  inboxConvertSchema,
  inboxFilterSchema,
  inboxKinds,
  inboxStatusSchema,
  type ConvertedKind,
  type InboxIncoming,
} from '../../shared/import/index.js';

/** 转入后拿到的识别任务：收件箱只看编号、版本和识别类型（类型只拿来和要转的比，不管有哪几种） */
type ImportWorkspaceRef = { id: string; revision: number; mode: string };
/** 只依赖上传和切换类型，避免收件箱反向依赖整个导入模块。 */
export type InboxImportTarget = {
  upload(
    buffer: Buffer,
    fileName: string,
    isolate?: boolean,
    mode?: ConvertedKind,
  ): Promise<{ workspace: ImportWorkspaceRef; duplicate?: boolean }>;
  setMode(id: string, raw: unknown): ImportWorkspaceRef;
};
const incomingSchema = z.object({
  channel: z.enum(inboxChannels),
  externalId: z.string().min(1),
  senderId: z.string().optional(),
  senderName: z.string().optional(),
  conversation: z.string().optional(),
  kind: z.enum(inboxKinds),
  text: z.string().optional(),
  receivedAt: z.iso.datetime({ offset: true }),
  file: z
    .object({ name: z.string(), mime: z.string(), bytes: z.instanceof(Uint8Array) })
    .optional(),
});
export class InboxService {
  constructor(private store: Store) {}
  ingest(input: InboxIncoming) {
    const v = incomingSchema.parse(input),
      db = this.store.db;
    const existing = one(db, itemRow, 'SELECT * FROM inbox_items WHERE channel=? AND external_id=?', v.channel, v.externalId);
    if (existing) return itemView(existing);
    if (v.file && v.file.bytes.byteLength > INBOX_MAX_FILE)
      throw new InputError('文件不能超过' + INBOX_MAX_FILE_TEXT);
    const hash = v.file ? createHash('sha256').update(v.file.bytes).digest('hex') : null;
    return inSavepoint(db, () => {
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
      return this.get(Number(result.lastInsertRowid));
    });
  }
  has(channel: string, externalId: string) {
    return exists(this.store.db, 'SELECT 1 FROM inbox_items WHERE channel=? AND external_id=?', channel, externalId);
  }
  get(id: number) {
    const row = one(this.store.db, itemRow, 'SELECT * FROM inbox_items WHERE id=?', id);
    return row ? itemView(row) : notFound('收件不存在');
  }
  list(filters: z.input<typeof inboxFilterSchema> = {}, query: unknown = {}) {
    return listInbox(this.store.db, filters, query);
  }
  file(id: number) {
    const row = one(
      this.store.db,
      fileRow,
      'SELECT i.file_name,i.file_mime,f.content FROM inbox_items i JOIN inbox_files f ON f.sha256=i.file_sha256 WHERE i.id=?',
      id,
    );
    if (!row) return notFound('文件不存在');
    // 有原件的收件一定写了文件名和类型（ingest 一起写）
    return { name: row.file_name ?? '', mime: row.file_mime ?? '', content: row.content };
  }
  /**
   * 把收件转给 AI 导入：沿用原上传流程，原件、哈希和重复检查由它负责，不触发识别。
   * 页面和助手都走这里；已转过的直接返回原任务，重复点击不会再建一份。
   * 拿到的任务类型必须和要转的类型一致才标记已转，否则收件保持待处理、可以重试。
   */
  async toImport(
    id: number,
    raw: unknown,
    actor: Actor,
    imports: InboxImportTarget,
  ) {
    requirePermission(actor, 'business:edit');
    const v = inboxConvertSchema.parse(raw),
      item = this.get(id);
    if (item.status === 'converted' && item.convertedRef)
      return { workspaceId: item.convertedRef, item, reused: true };
    if (item.version !== v.expectedVersion)
      throw new ConflictError();
    if (!item.fileName) throw new InputError('这条内容没有文件，不能转入 AI 导入。');
    const file = this.file(id);
    const uploaded = await imports.upload(Buffer.from(file.content), file.name, false, v.kind);
    let workspace = uploaded.workspace;
    if (workspace.mode !== v.kind)
      workspace = imports.setMode(workspace.id, {
        expectedRevision: workspace.revision,
        mode: v.kind,
      });
    if (!workspace.id || workspace.mode !== v.kind)
      throw new AppError(
        '转入的识别任务类型不对，收件仍是待处理，可以重试或到 AI 导入页面处理。',
        409,
      );
    const next = this.changeStatus(
      id,
      {
        status: 'converted',
        convertedKind: v.kind,
        convertedRef: workspace.id,
        expectedVersion: v.expectedVersion,
      },
      actor,
      'to-import',
    );
    return { workspaceId: workspace.id, item: next, reused: false };
  }
  setStatus(id: number, input: z.input<typeof inboxStatusSchema>, actor: Actor) {
    return this.changeStatus(id, input, actor, 'status');
  }
  /**
   * 改处理状态并写审计。审计只记状态变化和转入的识别任务，不记消息正文、发送人、文件内容，
   * 也不记机器人的凭据。
   */
  private changeStatus(
    id: number,
    input: z.input<typeof inboxStatusSchema>,
    actor: Actor,
    action: 'status' | 'to-import',
  ) {
    requirePermission(actor, 'business:edit');
    const v = inboxStatusSchema.parse(input);
    const before = this.get(id);
    // 已经是这个状态（双击、网络重试）：直接返回，不报版本冲突、不重复写审计
    if (
      before.status === v.status &&
      before.convertedKind === (v.convertedKind ?? null) &&
      before.convertedRef === (v.convertedRef ?? null)
    )
      return before;
    const db = this.store.db;
    return inSavepoint(db, () => {
      const result = db
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
      const after = this.get(id);
      audit(this.store, actor, {
        action,
        entity: 'inbox_items',
        id,
        document: {
          channel: before.channel,
          kind: before.kind,
          before: { status: before.status, version: before.version },
          after: {
            status: after.status,
            convertedKind: after.convertedKind,
            convertedRef: after.convertedRef,
            version: after.version,
          },
        },
      });
      return after;
    });
  }
}
