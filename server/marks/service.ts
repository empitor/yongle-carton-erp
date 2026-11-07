import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission, audit } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { snapshotBeforeDestructive } from '../backup.js';
import { markFieldsSchema } from '../../shared/shipping-mark.js';

const columns = `id,product_id AS productId,file_sha256 AS fileSha256,page,title,fields,
source_kind AS sourceKind,source_ref AS sourceRef,created_by AS createdBy,
created_at AS createdAt,updated_at AS updatedAt,version,
(SELECT file_name FROM mark_files WHERE sha256=file_sha256) AS fileName`;
const versionSchema = z.number().int().positive();
export class MarkService {
  constructor(readonly store: Store) {}
  private product(id: number) {
    if (!this.store.product(id)) throw new ImportError('产品不存在或已归档。', 404);
  }
  private row(row: any) {
    return { ...row, fields: markFieldsSchema.parse(JSON.parse(row.fields)) };
  }
  /** 只读不要求产品未归档：归档产品的面板也要能看到唛头。 */
  list(productId: number) {
    if (!this.store.product(productId, true)) throw new ImportError('产品不存在。', 404);
    return this.store.db
      .prepare(`SELECT ${columns} FROM product_marks WHERE product_id=? ORDER BY id`)
      .all(productId)
      .map((r) => this.row(r));
  }
  listForProducts(ids: number[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    return this.store.db
      .prepare(
        `SELECT ${columns} FROM product_marks WHERE product_id IN (${unique.map(() => '?').join(',')}) ORDER BY id`,
      )
      .all(...unique)
      .map((r) => this.row(r));
  }
  get(id: number) {
    const row = this.store.db.prepare(`SELECT ${columns} FROM product_marks WHERE id=?`).get(id);
    if (!row) throw new ImportError('唛头不存在。', 404);
    return this.row(row);
  }
  file(id: number) {
    const mark = this.get(id);
    const row = this.store.db
      .prepare('SELECT file_name AS name,mime,content FROM mark_files WHERE sha256=?')
      .get(mark.fileSha256)!;
    return {
      name: String(row.name),
      mime: String(row.mime),
      content: Buffer.from(row.content as Uint8Array),
    };
  }
  add(
    input: {
      productId: number;
      bytes: Uint8Array;
      name: string;
      mime: string;
      page?: number;
      title?: string;
      fields: unknown;
      sourceKind: string;
      sourceRef?: string | null;
    },
    who: Actor | null | undefined,
  ) {
    const actor = requirePermission(who, 'business:edit');
    this.product(input.productId);
    if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024)
      throw new ImportError('唛头文件须在 20MB 以内。', 413);
    const fields = markFieldsSchema.parse(input.fields),
      page = z
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
    const prior = db
      .prepare('SELECT id FROM product_marks WHERE product_id=? AND file_sha256=? AND page=?')
      .get(input.productId, hash, page);
    if (prior) return this.get(Number(prior.id));
    db.exec('SAVEPOINT mark_add');
    try {
      db.prepare('INSERT OR IGNORE INTO mark_files VALUES(?,?,?,?,?)').run(
        hash,
        input.bytes,
        input.bytes.length,
        mime,
        name,
      );
      const at = new Date().toISOString();
      const result = db
        .prepare(
          'INSERT INTO product_marks(product_id,file_sha256,page,title,fields,source_kind,source_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          input.productId,
          hash,
          page,
          input.title ?? '',
          JSON.stringify(fields),
          input.sourceKind,
          input.sourceRef ?? null,
          actor.id,
          at,
          at,
        );
      const mark = this.get(Number(result.lastInsertRowid));
      audit(this.store, actor, 'marks', 'add', 'product_marks', mark.id, mark);
      db.exec('RELEASE mark_add');
      return mark;
    } catch (e) {
      db.exec('ROLLBACK TO mark_add; RELEASE mark_add');
      throw e;
    }
  }
  update(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      before = this.get(id);
    this.product(before.productId);
    const v = z
      .strictObject({ title: z.string(), fields: markFieldsSchema, expectedVersion: versionSchema })
      .parse(raw);
    if (before.version !== v.expectedVersion) throw new ImportError('唛头已修改，请刷新。', 409);
    const db = this.store.db;
    db.exec('SAVEPOINT mark_update');
    try {
      db.prepare(
        'UPDATE product_marks SET title=?,fields=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
      ).run(v.title, JSON.stringify(v.fields), new Date().toISOString(), id, v.expectedVersion);
      const after = this.get(id);
      audit(this.store, actor, 'marks', 'update', 'product_marks', id, { before, after });
      db.exec('RELEASE mark_update');
      return after;
    } catch (e) {
      db.exec('ROLLBACK TO mark_update; RELEASE mark_update');
      throw e;
    }
  }
  remove(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      before = this.get(id);
    this.product(before.productId);
    const v = z.strictObject({ expectedVersion: versionSchema }).parse(raw);
    if (before.version !== v.expectedVersion) throw new ImportError('唛头已修改，请刷新。', 409);
    const db = this.store.db;
    snapshotBeforeDestructive(this.store, 'mark-remove');
    db.exec('SAVEPOINT mark_remove');
    try {
      db.prepare('DELETE FROM product_marks WHERE id=?').run(id);
      db.prepare(
        'DELETE FROM mark_files WHERE sha256=? AND NOT EXISTS(SELECT 1 FROM product_marks WHERE file_sha256=?)',
      ).run(before.fileSha256, before.fileSha256);
      audit(this.store, actor, 'marks', 'remove', 'product_marks', id, before);
      db.exec('RELEASE mark_remove');
      return { id, removed: true };
    } catch (e) {
      db.exec('ROLLBACK TO mark_remove; RELEASE mark_remove');
      throw e;
    }
  }
}
