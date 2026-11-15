import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { inSavepoint, requirePermission, audit, many, one, rows } from '../core/index.js';
import { AppError } from '../core/index.js';
import { snapshotBeforeDestructive } from '../core/index.js';
import { markRemoveSchema, markSourceKinds, markUpdateSchema } from '../../shared/business/index.js';
import { MIB } from '../../shared/core/index.js';

const columns = `id,product_id AS productId,file_sha256 AS fileSha256,page,title,
source_kind AS sourceKind,source_ref AS sourceRef,created_by AS createdBy,
created_at AS createdAt,updated_at AS updatedAt,version,
(SELECT file_name FROM mark_files WHERE sha256=file_sha256) AS fileName`;
/** 一份唛头文件最多多大（MB）：上传接口收正文的上限和保存时的核对都按它 */
export const MARK_MAX_MB = 20;
const MARK_MAX_BYTES = MARK_MAX_MB * MIB;
const markColumns = rows.product_marks.shape,
  /** 挂在产品下的一份唛头文件（product_marks 一行，带文件名；文件名由外键保证一定有） */
  markRow = rows.product_marks.pick({ id: true, page: true, title: true, version: true }).extend({
    productId: markColumns.product_id,
    fileSha256: markColumns.file_sha256,
    sourceKind: z.enum(markSourceKinds),
    sourceRef: markColumns.source_ref,
    createdBy: markColumns.created_by,
    createdAt: markColumns.created_at,
    updatedAt: markColumns.updated_at,
    fileName: rows.mark_files.shape.file_name,
  });
const markFile = rows.mark_files.pick({ mime: true, content: true }).extend({ name: rows.mark_files.shape.file_name });
export class MarkService {
  constructor(readonly store: Store) {}
  private product(id: number) {
    if (!this.store.product(id)) throw new AppError('产品不存在或已归档。', 404);
  }
  /** 只读不要求产品未归档：归档产品的面板也要能看到唛头。 */
  list(productId: number) {
    if (!this.store.product(productId, true)) throw new AppError('产品不存在。', 404);
    return many(this.store.db, markRow, `SELECT ${columns} FROM product_marks WHERE product_id=? ORDER BY id`, productId);
  }
  listForProducts(ids: number[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    return many(
      this.store.db,
      markRow,
      `SELECT ${columns} FROM product_marks WHERE product_id IN (${unique.map(() => '?').join(',')}) ORDER BY id`,
      ...unique,
    );
  }
  get(id: number) {
    const mark = one(this.store.db, markRow, `SELECT ${columns} FROM product_marks WHERE id=?`, id);
    if (!mark) throw new AppError('唛头不存在。', 404);
    return mark;
  }
  file(id: number) {
    const mark = this.get(id);
    // 唛头引用文件有外键，读不到说明库坏了，按服务端错误报
    const row = one(this.store.db, markFile, 'SELECT file_name AS name,mime,content FROM mark_files WHERE sha256=?', mark.fileSha256);
    if (!row) throw new Error('唛头 ' + id + ' 引用的文件不在 mark_files 里');
    return { name: row.name, mime: row.mime, content: Buffer.from(row.content) };
  }
  add(
    input: {
      productId: number;
      bytes: Uint8Array;
      name: string;
      mime: string;
      page?: number;
      title?: string;
      sourceKind: (typeof markSourceKinds)[number];
      sourceRef?: string | null;
    },
    who: Actor | null | undefined,
  ) {
    const actor = requirePermission(who, 'business:edit');
    this.product(input.productId);
    if (!input.bytes.length || input.bytes.length > MARK_MAX_BYTES)
      throw new AppError('唛头文件须在 ' + MARK_MAX_MB + 'MB 以内。', 413);
    const page = z
        .number()
        .int()
        .nonnegative()
        .parse(input.page ?? 0);
    const name = z
      .string()
      .min(1)
      .refine((v) => !/[\x00-\x1f]/.test(v))
      .parse(input.name);
    const mime = z
      .string()
      .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/)
      .parse(input.mime.split(';')[0]);
    const hash = createHash('sha256').update(input.bytes).digest('hex'),
      db = this.store.db;
    const prior = one(
      db,
      rows.product_marks.pick({ id: true }),
      'SELECT id FROM product_marks WHERE product_id=? AND file_sha256=? AND page=?',
      input.productId,
      hash,
      page,
    );
    if (prior) return this.get(prior.id);
    return inSavepoint(db, () => {
      db.prepare('INSERT OR IGNORE INTO mark_files(sha256,content,size,mime,file_name) VALUES(?,?,?,?,?)').run(
        hash,
        input.bytes,
        input.bytes.length,
        mime,
        name,
      );
      const at = new Date().toISOString();
      const result = db
        .prepare(
          'INSERT INTO product_marks(product_id,file_sha256,page,title,source_kind,source_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          input.productId,
          hash,
          page,
          input.title ?? '',
          input.sourceKind,
          input.sourceRef ?? null,
          actor.id,
          at,
          at,
        );
      const mark = this.get(Number(result.lastInsertRowid));
      audit(this.store, actor, { action: 'add', entity: 'product_marks', id: mark.id, document: mark });
      return mark;
    });
  }
  update(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      before = this.get(id);
    this.product(before.productId);
    const v = markUpdateSchema.parse(raw);
    if (before.version !== v.expectedVersion) throw new AppError('唛头已修改，请刷新。', 409);
    const db = this.store.db;
    return inSavepoint(db, () => {
      db.prepare(
        'UPDATE product_marks SET title=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
      ).run(v.title, new Date().toISOString(), id, v.expectedVersion);
      const after = this.get(id);
      audit(this.store, actor, { action: 'update', entity: 'product_marks', id, document: { before, after } });
      return after;
    });
  }
  remove(id: number, raw: unknown, who: Actor | null | undefined): { id: number; removed: true } {
    const actor = requirePermission(who, 'business:edit'),
      before = this.get(id);
    this.product(before.productId);
    const v = markRemoveSchema.parse(raw);
    if (before.version !== v.expectedVersion) throw new AppError('唛头已修改，请刷新。', 409);
    const db = this.store.db;
    snapshotBeforeDestructive(this.store, 'mark-remove');
    return inSavepoint(db, () => {
      db.prepare('DELETE FROM product_marks WHERE id=?').run(id);
      db.prepare(
        'DELETE FROM mark_files WHERE sha256=? AND NOT EXISTS(SELECT 1 FROM product_marks WHERE file_sha256=?)',
      ).run(before.fileSha256, before.fileSha256);
      audit(this.store, actor, { action: 'remove', entity: 'product_marks', id, document: before });
      return { id, removed: true };
    });
  }
}
