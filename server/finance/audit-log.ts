/** 财务操作记录页：按操作人、日期（北京时间）、对象、编号筛财务写的审计记录。 */
import { z } from 'zod';
import { dateSchema } from '../../shared/core/index.js';
import { financeAuditEntities } from '../../shared/finance/index.js';
import { clampPage, count, many, parsePaging, parseStoredJson, rows } from '../core/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { financeActor } from './core.js';
import { id } from './query.js';

/** 对象（表名）最长几个字 */
const ENTITY_MAX = 80;
const filters = z.object({
  actorId: z.string().max(100).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  entity: z.string().max(ENTITY_MAX).optional(),
  recordId: id.optional(),
});

export class FinanceAuditLog {
  constructor(private readonly store: Store) {}

  list(actor: Actor | null, rawQuery: unknown) {
    financeActor(actor, 'finance:close');
    // 页面按日期筛（YYYY-MM-DD），按北京时间的日期比较。
    const q = filters.parse(rawQuery);
    const from = q.from ?? null;
    const to = q.to ?? null;
    const { page: requestedPage, pageSize } = parsePaging(rawQuery);
    // 财务写的审计就是挂在财务对象上的那些（financeAudit 的对象只能是这张表的键）；来源只表示从哪个入口来，不用它分模块
    const args = [
      JSON.stringify(Object.keys(financeAuditEntities)),
      q.actorId ?? null,
      q.actorId ?? null,
      from,
      from,
      to,
      to,
      q.entity ?? null,
      q.entity ?? null,
      q.recordId ?? null,
      q.recordId ?? null,
    ];
    const local = "coalesce(date(at,'+8 hours'),substr(at,1,10))";
    const where = `FROM business_audit WHERE entity IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR actor_id=?) AND (? IS NULL OR ${local}>=?)
      AND (? IS NULL OR ${local}<=?) AND (? IS NULL OR entity=?) AND (? IS NULL OR record_id=?)`;
    const db = this.store.db;
    const total = count(db, 'SELECT count(*) ' + where, ...args);
    const page = clampPage(requestedPage ?? 1, pageSize, total);
    const found = many(db, rows.business_audit, 'SELECT * ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?', ...args, pageSize, (page - 1) * pageSize);
    // 审计内容是各处操作自己记的改前改后，原样交给页面显示
    const records = found.map((row) => ({
      ...row,
      document: parseStoredJson(z.json(), row.document, `business_audit.document（第 ${row.id} 条）`),
    }));
    return { rows: records, page, pageSize, filteredRecords: total };
  }
}
