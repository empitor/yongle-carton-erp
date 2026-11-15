import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { one, rows } from '../core/index.js';
import { financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { id, label, request, row } from './query.js';
import type { attachmentMediaTypes } from './stored-values.js';
import { MIB } from '../../shared/core/index.js';

/** 一份财务附件最多多大（MB） */
const ATTACHMENT_MAX_MB = 20;
/** 按文件头认文件类型：PNG 文件头 8 字节、JPEG 3 字节、PDF 以“%PDF-”开头 */
const signatures = [
  { type: 'image/png', head: '89504e470d0a1a0a' },
  { type: 'image/jpeg', head: 'ffd8ff' },
  { type: 'application/pdf', head: Buffer.from('%PDF-').toString('hex') },
] as const;

/** 按文件头判断附件类型，认不出的记 application/octet-stream */
function mediaType(bytes: Buffer): (typeof attachmentMediaTypes)[number] {
  const found = signatures.find((s) => bytes.subarray(0, s.head.length / 2).toString('hex') === s.head);
  return found?.type ?? 'application/octet-stream';
}

/** 保存附件的结果（同一个文件已经存过就是原来那份）：编号、摘要、文件名、类型、字节数 */
const savedAttachment = rows.fin_attachments
  .pick({ id: true, sha256: true, filename: true, media_type: true })
  .extend({ size: z.number() });

/** 财务附件（发票、凭证的扫描件）：按内容去重保存，按编号取回。 */
export class FinanceAttachments {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  save(actor: Actor | null, raw: unknown, bytes: Buffer) {
    const user = financeActor(actor, 'finance:edit');
    const v = request.extend({ filename: label }).parse(raw);
    if (!bytes.length || bytes.length > ATTACHMENT_MAX_MB * MIB || /[/\\\r\n\0]/.test(v.filename))
      financeError('附件名称或大小不合法。');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const type = mediaType(bytes);
    const input = { ...v, sha };
    return financeWrite(this.store, user, { action: 'attachment.save', input, result: savedAttachment }, () => {
      const found = one(
        this.db,
        savedAttachment,
        'SELECT id,sha256,filename,media_type,length(bytes) AS size FROM fin_attachments WHERE sha256=?',
        sha,
      );
      if (found) return { ...found };
      const key = Number(
        this.db
          .prepare('INSERT INTO fin_attachments(sha256,filename,media_type,bytes,created_at) VALUES(?,?,?,?,?)')
          .run(sha, v.filename, type, bytes, new Date().toISOString()).lastInsertRowid,
      );
      const result = { id: key, sha256: sha, filename: v.filename, media_type: type, size: bytes.length };
      financeAudit(this.store, user, { action: 'create', entity: 'fin_attachments', id: key, before: null, after: result });
      return result;
    });
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    return row(this.db, 'fin_attachments', id.parse(rawId));
  }
}
