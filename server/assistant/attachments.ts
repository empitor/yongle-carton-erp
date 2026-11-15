import { queueRemoteDeletion } from './remote-files.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, count, exists, inSavepoint, many, one, parseStoredJson, rows } from '../core/index.js';
import { attachmentKinds, attachmentLimits, type AssistantAttachment } from '../../shared/core/index.js';
import { validateAttachment } from '../core/index.js';
/**
 * 助手附件的存取：上传（只做安全检查，原件存库）、选中、关联消息、下载、删除、清空。
 * 交给模型怎么读在 chat/model-attachments.ts（直接放进用户消息：文字内联、图片现读、文档上传后按编号引用）。
 */
const publicColumns = 'id,thread_id,name,size,mime,kind,sha256,metadata,created_at,deleted_at';
const joinedColumns = publicColumns
  .split(',')
  .map((c) => 'a.' + c)
  .join(',');

type Transfer = AssistantAttachment['transfer'];
/** 交给模型的方式能取的值：写成按类型的全表，类型里加了取值这里不补就编译不过 */
const transfers: Record<Transfer, true> = { image: true, file: true, text: true };
/** 附件种类（和建表的 CHECK 一致） */
const kind = z.enum(attachmentKinds);
/** metadata 列（upload 写）：交给模型的方式、图片的宽高 */
const attachmentMetadata = z.object({
  transfer: z.custom<Transfer>((v) => typeof v === 'string' && Object.hasOwn(transfers, v), '不认识的交付方式'),
  width: z.number().optional(),
  height: z.number().optional(),
});
/** 给页面和模型看的那几列（不带原件） */
const publicRow = rows.assistant_attachments
  .pick({ id: true, thread_id: true, name: true, size: true, mime: true, sha256: true, metadata: true, created_at: true, deleted_at: true })
  .extend({ kind });
type PublicRow = z.infer<typeof publicRow>;
/** 带原件的整行 */
const contentRow = rows.assistant_attachments.extend({ kind });

/** 上传的是谁、写入前再核对一次现在登录的是谁（浏览器断开时为 null） */
type UploadBy = [who: Actor | null | undefined, recheck?: () => Actor | null];

export class AssistantAttachments {
  constructor(readonly store: Store) {}
  /** 会话的 document：清空会话时换新的附件纪元（clear），上传前后比一比，中间清空过就不存 */
  private threadDocument(thread: string) {
    const row = one(this.store.db, rows.assistant_threads.pick({ document: true }), 'SELECT document FROM assistant_threads WHERE id=?', thread);
    if (!row) throw new AppError('会话不存在或无权访问。', 404);
    return row.document;
  }
  private owner(thread: string, actor: Actor | null | undefined) {
    if (!actor) throw new AppError('请先登录。', 401);
    if (!exists(this.store.db, 'SELECT id FROM assistant_threads WHERE id=? AND user_id=?', z.uuid().parse(thread), actor.id))
      throw new AppError('会话不存在或无权访问。', 404);
    return actor;
  }
  private row(id: string, actor: Actor | null | undefined): PublicRow {
    if (!actor) throw new AppError('请先登录。', 401);
    const r = one(this.store.db, publicRow, 'SELECT ' + publicColumns + ' FROM assistant_attachments WHERE id=? AND user_id=?', z.uuid().parse(id), actor.id);
    if (!r) throw new AppError('附件不存在或无权访问。', 404);
    this.owner(r.thread_id, actor);
    return r;
  }
  /** 带原件读一份（交给模型、给人下载） */
  private withContent(id: string, actor: Actor | null | undefined) {
    if (!actor) throw new AppError('请先登录。', 401);
    const r = one(this.store.db, contentRow, 'SELECT * FROM assistant_attachments WHERE id=? AND user_id=?', z.uuid().parse(id), actor.id);
    if (!r) throw new AppError('附件不存在或无权访问。', 404);
    this.owner(r.thread_id, actor);
    return r;
  }
  private descriptor(r: PublicRow): AssistantAttachment {
    return {
      id: r.id,
      threadId: r.thread_id,
      name: r.name,
      size: r.size,
      mime: r.mime,
      kind: r.kind,
      sha256: r.sha256,
      createdAt: r.created_at,
      deleted: !!r.deleted_at,
      ...parseStoredJson(attachmentMetadata, r.metadata, 'assistant_attachments.metadata（附件 ' + r.id + '）'),
    };
  }
  private log(actor: Actor, thread: string, state: string, document: Record<string, unknown>) {
    this.store.db
      .prepare(
        'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        actor.id,
        thread,
        'attachment',
        state,
        JSON.stringify(document),
        new Date().toISOString(),
      );
  }
  pending(thread: string, actor: Actor | null | undefined) {
    const a = this.owner(thread, actor);
    return many(
      this.store.db,
      publicRow,
      'SELECT ' +
        joinedColumns +
        ' FROM assistant_attachments a WHERE thread_id=? AND user_id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM assistant_message_attachments r WHERE r.attachment_id=a.id) ORDER BY rowid',
      thread,
      a.id,
    ).map((r) => this.descriptor(r));
  }
  forMessage(message: string, actor: Actor) {
    return many(
      this.store.db,
      publicRow,
      'SELECT ' +
        joinedColumns +
        ' FROM assistant_message_attachments r JOIN assistant_attachments a ON a.id=r.attachment_id WHERE r.message_id=? AND a.user_id=? ORDER BY a.rowid',
      message,
      actor.id,
    ).map((r) => this.descriptor(r));
  }
  previous(thread: string, actor: Actor) {
    const row = one(
      this.store.db,
      rows.assistant_messages.pick({ id: true }),
      "SELECT m.id FROM assistant_messages m WHERE thread_id=? AND role='user' AND EXISTS(SELECT 1 FROM assistant_message_attachments r JOIN assistant_attachments a ON a.id=r.attachment_id WHERE r.message_id=m.id AND a.deleted_at IS NULL) ORDER BY m.rowid DESC LIMIT 1",
      thread,
    );
    return row ? this.forMessage(row.id, actor).filter((a) => !a.deleted) : [];
  }
  async upload(thread: string, bytes: Buffer, name: string, uploadId: string, ...by: UploadBy) {
    const [who, recheck] = by;
    const actor = this.owner(thread, who),
      epoch = this.threadDocument(thread);
    z.uuid().parse(uploadId);
    const metadata = await validateAttachment(bytes, name),
      sha = createHash('sha256').update(bytes).digest('hex');
    const live = recheck ? recheck() : who;
    if (live?.id !== actor.id) throw new AppError('登录身份已变化，附件未保存。', 403);
    this.owner(thread, live);
    if (this.threadDocument(thread) !== epoch) throw new AppError('会话已清空，已停止保存本次附件。', 409);
    return inSavepoint(this.store.db, () => {
      if (
        exists(
          this.store.db,
          "SELECT 1 FROM assistant_audit WHERE user_id=? AND thread_id=? AND tool='attachment' AND state='upload-cancelled' AND json_extract(document,'$.uploadId')=? LIMIT 1",
          actor.id,
          thread,
          uploadId,
        )
      )
        throw new AppError('此上传已被用户移除，不再保存。', 409);
      const old = one(this.store.db, publicRow, 'SELECT ' + publicColumns + ' FROM assistant_attachments WHERE user_id=? AND upload_id=?', actor.id, uploadId);
      if (old) {
        if (old.sha256 !== sha || old.name !== name || old.thread_id !== thread || old.deleted_at)
          throw new AppError('上传凭据已使用或附件已删除，请重新选择。', 409);
        return this.descriptor(old);
      }
      if (this.pending(thread, actor).length >= attachmentLimits.pendingCount)
        throw new AppError('本会话待发送附件最多6份，请先发送或移除。', 413);
      const used = (where: string, ...args: string[]) =>
        count(this.store.db, 'SELECT COALESCE(SUM(size),0) n FROM assistant_attachments WHERE deleted_at IS NULL' + where, ...args);
      if (
        used(' AND user_id=?', actor.id) + bytes.length > attachmentLimits.userBytes ||
        used('') + bytes.length > attachmentLimits.totalBytes
      )
        throw new AppError('附件空间已达上限，请删除不再需要的聊天附件。', 413);
      const id = randomUUID();
      const stored: z.input<typeof attachmentMetadata> = { transfer: metadata.transfer, width: metadata.width, height: metadata.height };
      this.store.db
        .prepare(
          'INSERT INTO assistant_attachments(id,thread_id,user_id,upload_id,name,size,mime,kind,sha256,metadata,bytes,created_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          id,
          thread,
          actor.id,
          uploadId,
          name,
          bytes.length,
          metadata.mime,
          metadata.kind,
          sha,
          JSON.stringify(stored),
          bytes,
          new Date().toISOString(),
        );
      this.log(actor, thread, 'uploaded', { id, name, sha256: sha, size: bytes.length });
      const result = this.descriptor(this.row(id, actor));
      return result;
    });
  }
  select(thread: string, ids: string[], previous: boolean, actor: Actor) {
    this.owner(thread, actor);
    if (new Set(ids).size !== ids.length || ids.length > attachmentLimits.messageCount)
      throw new AppError('每条消息最多6份不同附件。', 413);
    const selected = ids.length
      ? ids.map((id) => {
          const r = this.row(id, actor);
          if (r.thread_id !== thread || r.deleted_at)
            throw new AppError('附件已删除或不属于当前会话。', 409);
          return this.descriptor(r);
        })
      : previous
        ? this.previous(thread, actor)
        : [];
    if (selected.reduce((n, a) => n + a.size, 0) > attachmentLimits.messageBytes)
      throw new AppError('本条消息附件合计不能超过30MB。', 413);
    return selected;
  }
  /** 交给模型前读原件：已删的、内容被改过的不外发 */
  content(file: AssistantAttachment, actor: Actor) {
    const r = this.withContent(file.id, actor);
    if (r.deleted_at || !r.bytes) throw new AppError('附件已删除。', 410);
    const bytes = Buffer.from(r.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== r.sha256)
      throw new AppError('附件完整性验证失败，未外发。', 409);
    return bytes;
  }
  bind(message: string, files: AssistantAttachment[], thread: string, actor: Actor) {
    for (const file of files) {
      const r = this.row(file.id, actor);
      if (r.thread_id !== thread || r.deleted_at)
        throw new AppError('附件已变化，请重新确认。', 409);
      this.store.db
        .prepare('INSERT INTO assistant_message_attachments(message_id,attachment_id) VALUES(?,?)')
        .run(message, file.id);
    }
  }
  file(id: string, actor: Actor | null | undefined) {
    const r = this.withContent(id, actor);
    if (r.deleted_at || !r.bytes) throw new AppError('附件已删除，不能查看或下载。', 410);
    const bytes = Buffer.from(r.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== r.sha256)
      throw new AppError('附件完整性校验失败。', 409);
    return { meta: this.descriptor(r), bytes };
  }
  info(id: string, actor: Actor | null | undefined) {
    return this.descriptor(this.row(id, actor));
  }
  cancelUpload(thread: string, uploadId: string, who: Actor | null | undefined) {
    const actor = this.owner(thread, who);
    z.uuid().parse(uploadId);
    return inSavepoint(this.store.db, () => {
      this.log(actor, thread, 'upload-cancelled', { uploadId });
      const row = one(
        this.store.db,
        rows.assistant_attachments.pick({ id: true }),
        'SELECT id FROM assistant_attachments WHERE user_id=? AND thread_id=? AND upload_id=?',
        actor.id,
        thread,
        uploadId,
      );
      if (row) this.remove(row.id, actor);
      return { cancelled: true };
    });
  }
  remove(id: string, who: Actor | null | undefined) {
    if (!who) throw new AppError('请先登录。', 401);
    const r = this.row(id, who);
    if (!r.deleted_at) {
      inSavepoint(this.store.db, () => {
        queueRemoteDeletion(this.store, who.id, r.thread_id, [id]);
        this.store.db
          .prepare(
            'UPDATE assistant_attachments SET bytes=NULL,deleted_at=? WHERE id=?',
          )
          .run(new Date().toISOString(), id);
        this.log(who, r.thread_id, 'deleted', { id, sha256: r.sha256 });
      });
    }
    return this.descriptor(this.row(id, who));
  }
  /**
   * 清空会话附件：抹掉内容并标记删除，换新的附件纪元。
   * 传 upToRowid 时只清这个行号及以前的附件（提出清空那一刻已有的），之后上传的保留。
   */
  clear(thread: string, actor: Actor, upToRowid?: number) {
    this.owner(thread, actor);
    this.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_set(document,'$.attachmentEpoch',?) WHERE id=?",
      )
      .run(randomUUID(), thread);
    const cutoff = upToRowid === undefined ? '' : ' AND rowid<=?';
    // 传到 DeepSeek 的那几份跟着删（remote-files.ts）
    queueRemoteDeletion(
      this.store,
      actor.id,
      thread,
      many(
        this.store.db,
        rows.assistant_attachments.pick({ id: true }),
        'SELECT id FROM assistant_attachments WHERE thread_id=? AND user_id=? AND deleted_at IS NULL' + cutoff,
        thread,
        actor.id,
        ...(upToRowid === undefined ? [] : [upToRowid]),
      ).map((r) => r.id),
    );
    this.store.db
      .prepare(
        'UPDATE assistant_attachments SET bytes=NULL,deleted_at=COALESCE(deleted_at,?) WHERE thread_id=? AND user_id=?' +
          cutoff,
      )
      .run(
        new Date().toISOString(),
        thread,
        actor.id,
        ...(upToRowid === undefined ? [] : [upToRowid]),
      );
  }
}
