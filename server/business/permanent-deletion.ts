import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { ImportError } from '../import/errors.js';
import { audit, isSuperMode } from './management.js';
import { recordEntities } from '../../shared/operations.js';
import { flowReference } from '../flow/service.js';
import { isLocalAdministrator } from '../developer-capability.js';
import { DatabaseMaintenanceService } from './database-maintenance.js';
const selectionSchema = z.strictObject({
  entity: z.enum(recordEntities),
  items: z
    .array(
      z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() }),
    )
    .min(1)
    .max(1000),
  includeRelatedOrders: z.boolean().default(false),
});
type Selection = z.infer<typeof selectionSchema>;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class PermanentDeletionService {
  constructor(private store: Store) {}
  private actor(actor: Actor | null | undefined) {
    if (!actor) throw new ImportError('请先登录。', 401);
    if (!isSuperMode(actor)) throw new ImportError('永久删除仅限已验证密码的超级管理员模式。', 403);
    return actor;
  }
  private plan(selection: Selection) {
    if (new Set(selection.items.map((i) => i.id)).size !== selection.items.length)
      throw new ImportError('重复选择了同一记录。');
    const all = this.store[selection.entity](true);
    const records = selection.items
      .map((i) => {
        const row = all.find((r) => r.id === i.id);
        if (!row || row.version !== i.version)
          throw new ImportError('选中记录不存在或已修改，请刷新后重新预览。', 409);
        return { ...row, archived: this.store.archived(selection.entity, row.id) };
      })
      .sort((a, b) => a.id - b.id);
    const ids = new Set(records.map((r) => r.id));
    const related = this.store
      .orders(true)
      .filter((o) =>
        selection.entity === 'customers'
          ? ids.has(o.customerId)
          : selection.entity === 'products'
            ? o.lines.some((l) => ids.has(l.productId))
            : false,
      )
      .map((o) => ({ ...o, archived: this.store.archived('orders', o.id) }))
      .sort((a, b) => a.id - b.id);
    const orders =
      selection.entity === 'orders'
        ? (records as ReturnType<Store['orders']>)
        : selection.includeRelatedOrders
          ? related
          : [];
    if (orders.length > 1000 || related.length > 1000)
      throw new ImportError('本次关联订单超过1000条，请分批处理。');
    const blockers =
      related.length && !selection.includeRelatedOrders
        ? [
            '选中档案关联' +
              related.length +
              '张订单。默认禁止删除，请先核对关联订单；若确需一并永久删除，请明确勾选后重新预览。',
          ]
        : [];
    if (
      records.some((r) => flowReference(this.store, selection.entity, r.id)) ||
      orders.some((o) => flowReference(this.store, 'orders', o.id))
    )
      blockers.push(
        '记录已关联采购到货、生产或送货单据，不能永久删除；请保留历史并按冲销流程更正。',
      );
    if (
      selection.entity === 'suppliers' &&
      records.some((r) =>
        this.store.db.prepare('SELECT 1 FROM purchases WHERE supplier_id=? LIMIT 1').get(r.id),
      )
    )
      blockers.push('供应商已关联历史采购，不能永久删除；可停用归档，采购历史保留。');
    if (
      selection.entity === 'purchases' &&
      records.some((r) =>
        this.store.db
          .prepare('SELECT 1 FROM purchase_receipts WHERE purchase_id=? LIMIT 1')
          .get(r.id),
      )
    )
      blockers.push('采购单已有到货及库存流水，不能永久删除；可取消剩余订货并归档。');
    if (
      selection.entity === 'stock_items' &&
      records.some((r) =>
        this.store.db
          .prepare(
            'SELECT 1 FROM stock_movements WHERE item_id=? UNION ALL SELECT 1 FROM purchase_lines WHERE stock_item_id=? LIMIT 1',
          )
          .get(r.id, r.id),
      )
    )
      blockers.push('库存品已有流水或采购引用，不能永久删除；余额为零且无未完成采购时可归档。');
    for (const order of orders)
      if (
        this.store.db
          .prepare(
            'SELECT 1 FROM purchases WHERE customer_order_id=? UNION ALL SELECT 1 FROM stock_movements WHERE customer_order_id=? LIMIT 1',
          )
          .get(order.id, order.id)
      ) {
        blockers.push('拟删除订单已关联采购或库存流水，不能永久删除这些历史订单。');
        break;
      }
    if (
      selection.entity === 'products' &&
      records.some((r) =>
        this.store.db.prepare('SELECT 1 FROM stock_items WHERE product_id=? LIMIT 1').get(r.id),
      )
    )
      blockers.push('产品已关联成品库存档案，不能永久删除；可停用归档。');
    return {
      selection,
      records,
      relatedOrders: related,
      orders,
      blockers,
      counts: {
        customers: selection.entity === 'customers' ? records.length : 0,
        products: selection.entity === 'products' ? records.length : 0,
        orders: orders.length,
        lines: orders.reduce((n, o) => n + o.lines.length, 0),
        ...(selection.entity === 'suppliers' ? { suppliers: records.length } : {}),
        ...(selection.entity === 'purchases' ? { purchases: records.length } : {}),
        ...(selection.entity === 'stock_items' ? { stock_items: records.length } : {}),
      },
      warning:
        '永久删除不可在回收站恢复。未选中的其他客户和产品不会删除；订单原件、幂等来源凭据与审计保留。',
    };
  }
  preview(raw: unknown, who: Actor | null | undefined, binding: string) {
    const actor = this.actor(who);
    if (!binding) throw new ImportError('登录会话无效。', 403);
    if (isLocalAdministrator(actor)) {
      const selection = selectionSchema.parse(raw),
        maintenance = new DatabaseMaintenanceService(this.store).preview(
          { module: selection.entity, items: selection.items },
          actor,
        );
      const counts: any = {};
      for (const entry of maintenance.impact.filter((r) => r.action === 'delete'))
        counts[entry.table] = (counts[entry.table] || 0) + 1;
      const plan = {
        ...maintenance,
        maintenance: true,
        counts,
        blockers: [],
        records: this.store[selection.entity](true).filter((r) =>
          selection.items.some((i) => i.id === r.id),
        ),
        orders: this.store
          .orders(true)
          .filter((o) =>
            maintenance.impact.some(
              (r) => r.table === 'orders' && r.action === 'delete' && r.id === o.id,
            ),
          ),
        relatedOrders: [],
      };
      const preview = { id: randomUUID(), expiresAt: Date.now() + 10 * 60000, plan };
      this.store.db
        .prepare('INSERT INTO permanent_delete_previews VALUES(?,?,?,?,?,?,NULL)')
        .run(preview.id, actor.id, binding, preview.expiresAt, digest(plan), JSON.stringify(plan));
      return preview;
    }
    const plan = this.plan(selectionSchema.parse(raw));
    const preview = { id: randomUUID(), expiresAt: Date.now() + 10 * 60000, plan };
    this.store.db
      .prepare('INSERT INTO permanent_delete_previews VALUES(?,?,?,?,?,?,NULL)')
      .run(preview.id, actor.id, binding, preview.expiresAt, digest(plan), JSON.stringify(plan));
    return preview;
  }
  execute(raw: unknown, who: Actor | null | undefined, binding: string) {
    const actor = this.actor(who);
    const input = z
      .strictObject({
        previewId: z.string().uuid(),
        acknowledged: z.literal(true),
        confirmation: z.literal('永久删除').optional(),
      })
      .parse(raw);
    if (!isLocalAdministrator(actor) && input.confirmation !== '永久删除')
      throw new ImportError('请输入“永久删除”确认不可恢复操作。');
    const preview = this.store.db
      .prepare('SELECT * FROM permanent_delete_previews WHERE id=?')
      .get(input.previewId);
    if (
      !preview ||
      preview.actor_id !== actor.id ||
      !binding ||
      preview.session_binding !== binding
    )
      throw new ImportError('删除预览不属于当前账号和会话，请重新预览。', 403);
    if (Number(preview.expires_at) < Date.now())
      throw new ImportError('删除预览已过期，请重新预览。', 409);
    if (preview.result) return JSON.parse(String(preview.result));
    const original = JSON.parse(String(preview.document));
    if (original.maintenance && isLocalAdministrator(actor)) {
      const result = new DatabaseMaintenanceService(this.store).delete(
        { ...original.selection, requestId: input.previewId, deletionDigest: original.digest },
        actor,
        binding,
      );
      const response = { ...result, id: input.previewId, counts: original.counts };
      this.store.db
        .prepare('UPDATE permanent_delete_previews SET result=? WHERE id=?')
        .run(JSON.stringify(response), input.previewId);
      return response;
    }
    this.store.db.exec('SAVEPOINT permanent_delete_execute');
    try {
      if (digest(original) !== preview.digest)
        throw new ImportError('删除预览摘要异常，操作已停止。', 409);
      const plan = this.plan(selectionSchema.parse(original.selection));
      if (digest(plan) !== preview.digest)
        throw new ImportError('影响范围或记录已变化，请重新预览。', 409);
      if (plan.blockers.length) throw new ImportError(plan.blockers.join('；'), 409);
      this.checkAdditionalReferences(plan);
      const at = new Date().toISOString();
      const remove = (entity: Selection['entity'], row: any) => {
        audit(this.store, actor, 'super-admin', 'permanent-delete', entity, row.id, {
          before: row,
          after: null,
          previewId: preview.id,
          scope: plan.counts,
        });
        this.store.db
          .prepare('INSERT INTO permanent_record_deletions VALUES(?,?,?,?,?)')
          .run(entity, row.id, at, actor.id, row.number || row.name);
        if (entity === 'orders') {
          for (const receipt of this.store.db
            .prepare('SELECT id,document FROM import_executions WHERE order_id=?')
            .all(row.id)) {
            const document = JSON.parse(String(receipt.document));
            document.permanentDeletion = { at, actorId: actor.id, previewId: preview.id };
            this.store.db
              .prepare('UPDATE import_executions SET order_id=NULL,document=? WHERE id=?')
              .run(JSON.stringify(document), receipt.id);
          }
          this.store.db
            .prepare(
              'DELETE FROM order_line_extensions WHERE line_id IN (SELECT id FROM order_lines WHERE order_id=?)',
            )
            .run(row.id);
          this.store.db.prepare('DELETE FROM order_lines WHERE order_id=?').run(row.id);
          this.store.db.prepare('DELETE FROM order_extensions WHERE order_id=?').run(row.id);
        } else if (entity === 'purchases')
          this.store.db.prepare('DELETE FROM purchase_lines WHERE purchase_id=?').run(row.id);
        else if (entity === 'products')
          this.store.db.prepare('DELETE FROM product_extensions WHERE product_id=?').run(row.id);
        this.store.db
          .prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?')
          .run(entity, row.id);
        this.store.db.prepare('DELETE FROM ' + entity + ' WHERE id=?').run(row.id);
      };
      for (const order of plan.orders) remove('orders', order);
      if (plan.selection.entity !== 'orders')
        for (const record of plan.records) remove(plan.selection.entity, record);
      if (this.store.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('关联校验失败，全部删除已回滚。', 409);
      const result = { id: input.previewId, deletedAt: at, counts: plan.counts };
      this.store.db
        .prepare('UPDATE permanent_delete_previews SET result=? WHERE id=?')
        .run(JSON.stringify(result), input.previewId);
      this.store.db.exec('RELEASE permanent_delete_execute');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK TO permanent_delete_execute; RELEASE permanent_delete_execute');
      if (error instanceof ImportError) throw error;
      throw new ImportError('永久删除未完成，所有改动已回滚。可能仍有关联业务，请重新核对。', 409);
    }
  }
  private checkAdditionalReferences(plan: ReturnType<PermanentDeletionService['plan']>) {
    // 新模块若增加关联且未纳入删除方案，宁可拒绝，也不能靠CASCADE静默删除。
    const targets: Record<string, number[]> = {
      suppliers: plan.selection.entity === 'suppliers' ? plan.records.map((r) => r.id) : [],
      purchases: plan.selection.entity === 'purchases' ? plan.records.map((r) => r.id) : [],
      purchase_lines:
        plan.selection.entity === 'purchases'
          ? plan.records.flatMap((r: any) => r.lines.map((l: any) => l.id))
          : [],
      stock_items: plan.selection.entity === 'stock_items' ? plan.records.map((r) => r.id) : [],
      customers: plan.selection.entity === 'customers' ? plan.records.map((r) => r.id) : [],
      products: plan.selection.entity === 'products' ? plan.records.map((r) => r.id) : [],
      orders: plan.orders.map((o) => o.id),
      order_lines: plan.orders.flatMap((o) => o.lines.map((l) => l.id!).filter(Boolean)),
    };
    const known = new Set([
      'purchase_lines.purchase_id',
      'orders.customer_id',
      'order_lines.product_id',
      'order_lines.order_id',
      'product_extensions.product_id',
      'order_extensions.order_id',
      'order_line_extensions.line_id',
      'import_executions.order_id',
    ]);
    const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    for (const table of this.store.db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      for (const ref of this.store.db
        .prepare('PRAGMA foreign_key_list(' + quote(String(table.name)) + ')')
        .all()) {
        const ids = targets[String(ref.table)];
        if (!ids?.length || known.has(table.name + '.' + ref.from)) continue;
        const exists = this.store.db
          .prepare(
            'SELECT 1 FROM ' +
              quote(String(table.name)) +
              ' WHERE ' +
              quote(String(ref.from)) +
              ' IN (' +
              ids.map(() => '?').join(',') +
              ') LIMIT 1',
          )
          .get(...ids);
        if (exists)
          throw new ImportError(
            '存在尚未纳入删除方案的关联数据（' +
              table.name +
              '），已停止删除，请先补齐该模块的处理规则。',
            409,
          );
      }
    }
  }
}
