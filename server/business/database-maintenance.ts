import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requireLocalAdministrator } from '../developer-capability.js';
import { ImportError } from '../import/errors.js';
import { audit } from './management.js';
import { developerModules } from '../../shared/developer.js';
import { quantityUnits } from '../../shared/operations.js';
import { precisionTotal } from '../../shared/precision.js';
import { FlowService } from '../flow/service.js';
import { sheetArea, purchaseLineAmount } from '../../shared/physical-flow.js';

const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const deletionSelection = z.strictObject({
  module: z.enum(developerModules),
  items: z
    .array(
      z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() }),
    )
    .min(1)
    .max(100),
  inventoryPolicy: z.enum(['preserve', 'recalculate']).default('preserve'),
});
type Selection = z.infer<typeof deletionSelection>;
type Row = Record<string, any> & { __rowid: number };
const businessTables = new Set([
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'stock_items',
  'flow_documents',
]);

/** 受控数据库维护：删除不是归档/冲销。关联处理由真实FK及单据引用决定。 */
export class DatabaseMaintenanceService {
  constructor(readonly store: Store) {}
  alignStock(before: any, after: any, actor: Actor) {
    requireLocalAdministrator(actor);
    const db = this.store.db,
      flow = new FlowService(this.store);
    const item = Object.fromEntries(
      [
        'name',
        'unit',
        'specification',
        'length',
        'width',
        'height',
        'dimensionUnit',
        'material',
        'flute',
        'notes',
      ].map((k) => [k, after[k]]),
    );
    for (const line of db
      .prepare('SELECT * FROM purchase_lines WHERE stock_item_id=?')
      .all(after.id)) {
      if (after.kind !== 'raw')
        db.prepare('UPDATE purchase_lines SET stock_item_id=NULL WHERE id=?').run(line.id);
      else
        db.prepare('UPDATE purchase_lines SET document=? WHERE id=?').run(
          JSON.stringify({ ...JSON.parse(String(line.document)), ...item }),
          line.id,
        );
      db.prepare('UPDATE purchases SET version=version+1 WHERE id=?').run(line.purchase_id);
    }
    for (const d of flow.list(undefined, true)) {
      let changed = false;
      if (d.kind === 'arrival')
        for (const l of d.lines)
          if (l.stockId === after.id) {
            if (after.kind !== 'raw') {
              l.stockId = null;
            } else {
              if (after.unit !== '张')
                throw new ImportError(
                  '关联到货按张记录；修改数量单位需要明确新的到货数量，不能自动换算。',
                );
              l.item = { ...l.item, ...item };
              l.area = sheetArea(l.item, l.quantity);
              l.amount = purchaseLineAmount({
                ...l.item,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                priceBasis: l.priceBasis,
              });
            }
            changed = true;
          }
      if (d.kind === 'production' && d.finishedStockId === after.id) {
        if (after.kind !== 'finished' || !after.productId)
          throw new ImportError(
            '生产登记的成品库存关联需要成品类型和真实产品，不能留下类型不符的引用。',
          );
        d.productId = after.productId;
        if (d.taskId && flow.get(d.taskId).productId !== d.productId) d.taskId = null;
        changed = true;
      }
      if (
        d.kind === 'production' &&
        d.materials.some((m: any) => m.stockId === after.id) &&
        (after.kind !== 'raw' || after.unit !== '张')
      )
        throw new ImportError(
          '生产领料的原材料引用需要张数；请明确新的领料数量和库存品后编辑关联，不能猜测换算。',
        );
      if (changed) {
        db.prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=?').run(
          JSON.stringify(d),
          d.id,
        );
        flow.maintenanceReferences(d.id);
      }
    }
    audit(
      this.store,
      actor,
      'database-maintenance',
      'edit-related-stock',
      'stock_items',
      after.id,
      { before, after },
    );
  }
  detachPurchaseLines(purchaseId: number, lineIds: number[], actor: Actor) {
    if (!lineIds.length) return;
    requireLocalAdministrator(actor);
    const ids = new Set(lineIds),
      db = this.store.db,
      flow = new FlowService(this.store);
    for (const arrival of flow.list('arrival', true)) {
      let changed = false;
      const lines = arrival.lines.map((l: any) => {
        if (!ids.has(l.purchaseLineId)) return l;
        changed = true;
        return { ...l, purchaseLineId: null, purchaseId: null, purchaseNumber: '' };
      });
      if (changed) {
        db.prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=?').run(
          JSON.stringify({ ...arrival, lines }),
          arrival.id,
        );
        flow.maintenanceReferences(arrival.id);
      }
    }
    for (const row of db
      .prepare('SELECT * FROM purchase_receipts WHERE purchase_id=?')
      .all(purchaseId)) {
      const d = JSON.parse(String(row.document)),
        items = (d.items || []).filter((i: any) => !ids.has(i.lineId));
      if (items.length !== d.items.length) {
        if (items.length)
          db.prepare('UPDATE purchase_receipts SET document=? WHERE id=?').run(
            JSON.stringify({ ...d, items }),
            row.id,
          );
        else {
          db.prepare(
            "UPDATE stock_movements SET source_kind='database-maintenance',source_id=NULL WHERE source_kind='purchase_receipt' AND source_id=?",
          ).run(row.id);
          db.prepare('DELETE FROM purchase_receipts WHERE id=?').run(row.id);
        }
      }
    }
    for (const id of lineIds) {
      db.prepare('UPDATE stock_movements SET purchase_line_id=NULL WHERE purchase_line_id=?').run(
        id,
      );
      db.prepare(
        'UPDATE flow_refs SET purchase_line_id=NULL,purchase_id=NULL WHERE purchase_line_id=?',
      ).run(id);
      db.prepare('UPDATE purchase_lines SET received_units=0 WHERE id=?').run(id);
    }
  }
  prepareOrderEdit(before: any, lines: any[], actor: Actor) {
    requireLocalAdministrator(actor);
    const keep = new Set(lines.map((l) => l.id).filter(Boolean)),
      flow = new FlowService(this.store);
    for (const d of flow.list('delivery', true)) {
      const next = d.lines.filter((l: any) => l.orderId !== before.id || keep.has(l.orderLineId));
      if (next.length === d.lines.length) continue;
      if (!next.length) {
        const selection = { module: 'delivery', items: [{ id: d.id, version: d.version }] },
          p = this.preview(selection, actor);
        this.delete(
          { ...selection, requestId: randomUUID(), deletionDigest: p.digest },
          actor,
          'order-edit',
        );
        continue;
      }
      this.retainDeliveryLines(d, next, actor);
    }
  }
  private retainDeliveryLines(d: any, lines: any[], actor: Actor) {
    const db = this.store.db;
    const detached: string[] = [];
    const expected = new Map<number, number>();
    for (const l of lines)
      expected.set(l.stockId, (expected.get(l.stockId) || 0) - quantityUnits(l.quantity));
    const movements = db
      .prepare("SELECT * FROM stock_movements WHERE source_kind='flow_delivery' AND source_id=?")
      .all(String(d.id));
    for (const stock of new Set(movements.map((r) => Number(r.item_id)))) {
      const group = movements.filter((m) => m.item_id === stock),
        total = group.reduce((n, m) => n + Number(m.delta_units), 0),
        target = expected.get(stock) || 0,
        first = group[0];
      for (const m of group) db.prepare('DELETE FROM stock_movements WHERE id=?').run(m.id);
      const insert = (id: string, delta: number, source: string, orderId: any) =>
        db
          .prepare('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            id,
            stock,
            'out',
            delta,
            0,
            0,
            source,
            source === 'flow_delivery' ? String(d.id) : null,
            null,
            orderId,
            first.date,
            first.notes,
            actor.id,
            actor.name,
            first.created_at,
          );
      if (target)
        insert(
          String(first.id),
          target,
          'flow_delivery',
          lines.find((l: any) => l.stockId === stock)?.orderId || null,
        );
      if (total - target) {
        const id = randomUUID();
        insert(id, total - target, 'database-maintenance', null);
        detached.push(id);
      }
    }
    db.prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=?').run(
      JSON.stringify({ ...d, lines }),
      d.id,
    );
    new FlowService(this.store).maintenanceReferences(d.id);
    return detached;
  }
  alignOrder(before: any, after: any, actor: Actor) {
    const flow = new FlowService(this.store),
      db = this.store.db;
    for (const task of flow.list('task', true).filter((t) => t.orderIds.includes(after.id)))
      if (!after.lines.some((l: any) => l.productId === task.productId)) {
        db.prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=?').run(
          JSON.stringify({
            ...task,
            orderIds: task.orderIds.filter((id: number) => id !== after.id),
          }),
          task.id,
        );
        flow.maintenanceReferences(task.id);
      }
    if (before.customerId !== after.customerId)
      for (const d of flow
        .list('delivery', true)
        .filter((d) => d.lines.some((l: any) => l.orderId === after.id))) {
        const affected = d.lines.filter((l: any) => l.orderId === after.id),
          other = d.lines.filter((l: any) => l.orderId !== after.id);
        if (!other.length) {
          db.prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=?').run(
            JSON.stringify({
              ...d,
              customerId: after.customerId,
              customerName: after.customerName,
            }),
            d.id,
          );
          flow.maintenanceReferences(d.id);
        } else {
          const detached = this.retainDeliveryLines(d, other, actor);
          // 被拆出订单的已有出库保留为独立流水；新单据只建立准确关联，不重复扣库存。
          const created = flow.save(
            'delivery',
            {
              ...d,
              customerId: after.customerId,
              lines: affected,
              correctionOf: null,
              requestId: randomUUID(),
            },
            actor,
          );
          db.prepare('UPDATE flow_documents SET status=?,document=? WHERE id=?').run(
            d.status,
            JSON.stringify({ ...created, customerName: after.customerName }),
            created.id,
          );
          for (const movementId of detached)
            db.prepare(
              "UPDATE stock_movements SET source_kind='flow_delivery',source_id=?,customer_order_id=? WHERE id=?",
            ).run(String(created.id), after.id, movementId);
          flow.maintenanceReferences(created.id);
        }
      }
    if (
      this.store.db.prepare('SELECT 1 FROM flow_refs WHERE order_id=?').get(after.id) ||
      before.lines.some((l: any) => l.shippedQuantity > 0)
    )
      flow.refreshOrderProgress([after.id]);
  }
  private graph(raw: unknown) {
    const selection = deletionSelection.parse(raw),
      db = this.store.db;
    const table = ['arrival', 'task', 'production', 'delivery'].includes(selection.module)
      ? 'flow_documents'
      : selection.module;
    const cache = new Map<string, Row[]>(),
      removed = new Map<string, Set<number>>(),
      patches = new Map<string, Map<number, any>>();
    const rows = (t: string) => {
      if (!cache.has(t))
        cache.set(t, db.prepare('SELECT rowid AS __rowid,* FROM ' + quote(t)).all() as Row[]);
      return cache.get(t)!;
    };
    const gone = (t: string, row: Row) => removed.get(t)?.has(row.__rowid) || false;
    const remove = (t: string, row: Row) => {
      if (!removed.has(t)) removed.set(t, new Set());
      const s = removed.get(t)!;
      if (s.has(row.__rowid)) return false;
      s.add(row.__rowid);
      return true;
    };
    const patch = (t: string, row: Row, value: any) => {
      if (!patches.has(t)) patches.set(t, new Map());
      patches.get(t)!.set(row.__rowid, { ...patches.get(t)!.get(row.__rowid), ...value });
    };
    const changed = (t: string, row: Row) => ({ ...row, ...patches.get(t)?.get(row.__rowid) });
    if (new Set(selection.items.map((r) => r.id)).size !== selection.items.length)
      throw new ImportError('重复选择记录。');
    for (const item of selection.items) {
      const r = rows(table).find((r) => r.id === item.id);
      if (
        !r ||
        r.version !== item.version ||
        (table === 'flow_documents' && r.kind !== selection.module)
      )
        throw new ImportError('记录不存在或版本已改变，请刷新。', 409);
      remove(table, r);
    }
    const tableNames = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => String(r.name));
    const refs = tableNames.flatMap((t) =>
      db
        .prepare('PRAGMA foreign_key_list(' + quote(t) + ')')
        .all()
        .map((r) => ({
          table: t,
          parent: String(r.table),
          from: String(r.from),
          to: String(r.to || 'id'),
        })),
    );
    const nullable = (t: string, column: string) =>
      !db
        .prepare('PRAGMA table_info(' + quote(t) + ')')
        .all()
        .find((r) => r.name === column)?.notnull;
    const ids = (t: string) =>
      new Set(
        rows(t)
          .filter((r) => gone(t, r))
          .map((r) => r.id),
      );
    let progress = true;
    while (progress) {
      progress = false;
      const deletedOrders = ids('orders'),
        deletedLines = ids('order_lines'),
        deletedProducts = ids('products'),
        deletedStocks = ids('stock_items'),
        deletedPurchases = ids('purchases'),
        deletedPurchaseLines = ids('purchase_lines'),
        deletedFlows = ids('flow_documents');
      for (const row of rows('flow_documents')) {
        if (gone('flow_documents', row)) continue;
        const doc = JSON.parse(changed('flow_documents', row).document),
          before = JSON.stringify(doc);
        const deleteDoc =
          (row.kind === 'arrival' && ids('suppliers').has(doc.supplierId)) ||
          (['task', 'production'].includes(row.kind) && deletedProducts.has(doc.productId)) ||
          (row.kind === 'production' &&
            (deletedStocks.has(doc.finishedStockId) ||
              doc.materials.some((m: any) => deletedStocks.has(m.stockId)))) ||
          (row.kind === 'delivery' &&
            (ids('customers').has(doc.customerId) ||
              doc.lines.some(
                (l: any) =>
                  deletedOrders.has(l.orderId) ||
                  deletedLines.has(l.orderLineId) ||
                  deletedStocks.has(l.stockId),
              )));
        if (deleteDoc) {
          progress = remove('flow_documents', row) || progress;
          continue;
        }
        if (doc.correctionOf && deletedFlows.has(doc.correctionOf)) doc.correctionOf = null;
        if (row.kind === 'task')
          doc.orderIds = doc.orderIds.filter((id: number) => !deletedOrders.has(id));
        if (row.kind === 'production' && deletedFlows.has(doc.taskId)) doc.taskId = null;
        if (row.kind === 'arrival')
          for (const l of doc.lines) {
            if (deletedStocks.has(l.stockId)) l.stockId = null;
            if (deletedPurchaseLines.has(l.purchaseLineId) || deletedPurchases.has(l.purchaseId)) {
              l.purchaseLineId = null;
              l.purchaseId = null;
              l.purchaseNumber = '';
            }
          }
        if (JSON.stringify(doc) !== before)
          patch('flow_documents', row, { document: JSON.stringify(doc) });
      }
      for (const row of rows('purchase_receipts'))
        if (ids('flow_documents').has(JSON.parse(row.document).flowId))
          progress = remove('purchase_receipts', row) || progress;
      // 数据库FK：拥有型子记录删除，可空引用解除，不把历史状态作为删除条件。
      for (const ref of refs) {
        const values = new Set(
          rows(ref.parent)
            .filter((r) => gone(ref.parent, r))
            .map((r) => r[ref.to]),
        );
        if (!values.size) continue;
        for (const row of rows(ref.table)) {
          if (gone(ref.table, row) || !values.has(changed(ref.table, row)[ref.from])) continue;
          if (
            nullable(ref.table, ref.from) &&
            !['product_extensions', 'order_extensions', 'order_line_extensions'].includes(ref.table)
          )
            patch(ref.table, row, { [ref.from]: null });
          else progress = remove(ref.table, row) || progress;
        }
      }
      for (const order of rows('orders'))
        if (
          !gone('orders', order) &&
          !rows('order_lines').some((l) => l.order_id === order.id && !gone('order_lines', l))
        )
          progress = remove('orders', order) || progress;
    }
    // 删除单据不强迫撤销已经发生的库存。默认明确解除流水来源，数量保持；可选择移除来源流水并重算。
    const deletedFlowIds = ids('flow_documents'),
      receiptIds = ids('purchase_receipts');
    for (const row of rows('stock_movements'))
      if (!gone('stock_movements', row)) {
        const flowSource =
          /^flow_(arrival|production|delivery|task|reversal)$/.test(row.source_kind) &&
          deletedFlowIds.has(Number(row.source_id));
        if (
          flowSource ||
          (row.source_kind === 'purchase_receipt' && receiptIds.has(row.source_id))
        ) {
          if (selection.inventoryPolicy === 'recalculate') remove('stock_movements', row);
          else
            patch('stock_movements', row, { source_kind: 'database-maintenance', source_id: null });
        }
      }
    // 单据/实收JSON中的流水索引也是引用，不能在删除库存后留下失效ID。
    const deletedMovements = ids('stock_movements');
    for (const t of ['flow_documents', 'purchase_receipts'])
      for (const row of rows(t)) {
        if (gone(t, row)) continue;
        const doc = JSON.parse(changed(t, row).document);
        if (
          Array.isArray(doc.movements) &&
          doc.movements.some((id: string) => deletedMovements.has(id))
        ) {
          doc.movements = doc.movements.filter((id: string) => !deletedMovements.has(id));
          patch(t, row, { document: JSON.stringify(doc) });
        }
      }
    const deletions = [...removed].flatMap(([t, set]) =>
      rows(t)
        .filter((r) => set.has(r.__rowid))
        .map((r) => ({ table: t, row: r })),
    );
    const updates = [...patches].flatMap(([t, map]) =>
      [...map]
        .filter(([id]) => !removed.get(t)?.has(id))
        .map(([id, value]) => ({ table: t, row: rows(t).find((r) => r.__rowid === id)!, value })),
    );
    const label = (t: string, r: Row) =>
      r.number ||
      r.name ||
      (t === 'flow_refs' ? '单据引用 #' + r.document_id : String(r.id ?? r.__rowid));
    const impact = [
      ...deletions.map(({ table: t, row: r }) => ({
        table: t,
        id: r.id ?? r.__rowid,
        name: label(t, r),
        action: 'delete',
        kind: r.kind,
      })),
      ...updates.map(({ table: t, row: r, value }) => ({
        table: t,
        id: r.id ?? r.__rowid,
        name: label(t, r),
        action: 'detach',
        fields: Object.keys(value),
      })),
    ];
    const digest = hash({
      selection,
      deletions,
      updates,
      stock: rows('stock_movements').map((r) => [
        r.id,
        r.delta_units,
        r.before_units,
        r.after_units,
      ]),
    });
    const independent =
      deletions.some(
        ({ table: t, row: r }) =>
          businessTables.has(t) && (t !== table || !selection.items.some((i) => i.id === r.id)),
      ) ||
      updates.length > 0 ||
      deletions.some((r) => r.table === 'stock_movements');
    return {
      selection,
      table,
      deletions,
      updates,
      digest,
      impact,
      hasIndependentImpact: independent,
    };
  }
  preview(raw: unknown, who: Actor | null | undefined) {
    requireLocalAdministrator(who);
    const p = this.graph(raw);
    return {
      selection: p.selection,
      digest: p.digest,
      impact: p.impact,
      hasIndependentImpact: p.hasIndependentImpact,
      inventoryEffect:
        p.selection.inventoryPolicy === 'preserve'
          ? '删除目标及必需子记录；解除可空引用。保留其他库存品已有流水数量，被删来源改为独立数据库维护流水。删除库存档案本身会一并删除它的全部流水。'
          : '删除目标及必需子记录，同时移除被删单据的来源流水，重新计算剩余库存及流水前后余额。',
      warning:
        '这是数据库物理删除，不能恢复，不会归档或进入回收站。清单列出所有删除及引用解除范围。',
    };
  }
  delete(raw: unknown, who: Actor | null | undefined, binding: string) {
    const actor = requireLocalAdministrator(who),
      v = deletionSelection
        .extend({ requestId: z.string().uuid(), deletionDigest: z.string().optional() })
        .parse(raw);
    if (!binding) throw new ImportError('登录会话无效。', 403);
    const key = hash({ v, user: actor.id, binding }),
      old = this.store.db
        .prepare(
          "SELECT digest,result FROM operation_requests WHERE kind='database-delete' AND request_id=?",
        )
        .get(v.requestId);
    if (old) {
      if (old.digest !== key) throw new ImportError('请求编号已用于其他操作。', 409);
      return JSON.parse(String(old.result));
    }
    this.store.db.exec('SAVEPOINT database_delete');
    try {
      const p = this.graph({
        module: v.module,
        items: v.items,
        inventoryPolicy: v.inventoryPolicy,
      });
      if ((p.hasIndependentImpact || v.deletionDigest) && p.digest !== v.deletionDigest)
        throw new ImportError(
          '关联删除范围未展示或已变化，请查询删除影响后提交同一范围。',
          409,
          'deletion-scope',
        );
      this.store.db.exec('PRAGMA defer_foreign_keys=ON');
      for (const { table, row, value } of p.updates) {
        const fields = Object.keys(value);
        if (!fields.length) continue;
        this.store.db
          .prepare(
            'UPDATE ' +
              quote(table) +
              ' SET ' +
              fields.map((k) => quote(k) + '=?').join(',') +
              (Object.hasOwn(row, 'version') ? ',version=version+1' : '') +
              ' WHERE rowid=?',
          )
          .run(...fields.map((k) => value[k]), row.__rowid);
      }
      for (const { table, row } of p.deletions) {
        if (businessTables.has(table)) {
          const entity = table === 'flow_documents' ? 'flow_' + row.kind : table;
          audit(this.store, actor, 'database-maintenance', 'delete', entity, Number(row.id), {
            before: row,
            inventoryPolicy: v.inventoryPolicy,
            requestId: v.requestId,
          });
          this.store.db
            .prepare('INSERT OR REPLACE INTO permanent_record_deletions VALUES(?,?,?,?,?)')
            .run(
              entity,
              row.id,
              new Date().toISOString(),
              actor.id,
              row.number || row.name || String(row.id),
            );
          this.store.db
            .prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?')
            .run(entity, row.id);
          if (table === 'orders')
            for (const receipt of this.store.db
              .prepare('SELECT id,document FROM import_executions WHERE order_id IS NULL')
              .all()) {
              const doc = JSON.parse(String(receipt.document));
              if (
                doc.orderId === row.id ||
                p.updates.some(
                  (u) =>
                    u.table === 'import_executions' &&
                    u.row.id === receipt.id &&
                    u.row.order_id === row.id,
                )
              ) {
                doc.permanentDeletion = {
                  at: new Date().toISOString(),
                  actorId: actor.id,
                  requestId: v.requestId,
                };
                this.store.db
                  .prepare('UPDATE import_executions SET document=? WHERE id=?')
                  .run(JSON.stringify(doc), receipt.id);
              }
            }
        }
        this.store.db.prepare('DELETE FROM ' + quote(table) + ' WHERE rowid=?').run(row.__rowid);
      }
      const orderIds = [...p.deletions, ...p.updates]
        .filter((r) => r.table === 'flow_documents')
        .flatMap((r) => {
          const d = JSON.parse(r.row.document);
          return r.row.kind === 'task'
            ? d.orderIds
            : r.row.kind === 'delivery'
              ? d.lines.map((l: any) => l.orderId)
              : [];
        });
      this.recompute(orderIds);
      if (this.store.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('外键重算校验失败，整个删除已回滚。', 409);
      const result = {
        module: v.module,
        action: 'delete',
        count: v.items.length,
        deleted: true,
        impact: p.impact,
        results: v.items.map((r) => ({ id: r.id, deleted: true })),
      };
      this.store.db
        .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
        .run('database-delete', v.requestId, key, JSON.stringify(result));
      this.store.db.exec('RELEASE database_delete');
      return result;
    } catch (e) {
      this.store.db.exec('ROLLBACK TO database_delete; RELEASE database_delete');
      throw e;
    }
  }
  recompute(affectedOrders?: number[]) {
    const db = this.store.db;
    const receipts = db
      .prepare('SELECT document FROM purchase_receipts')
      .all()
      .map((r) => JSON.parse(String(r.document)))
      .filter((r) => !r.reversed);
    for (const line of db.prepare('SELECT * FROM purchase_lines').all()) {
      const received = receipts.reduce(
        (n, r) =>
          n +
          (r.items || [])
            .filter((i: any) => i.lineId === line.id)
            .reduce((n: number, i: any) => n + quantityUnits(i.quantity), 0),
        0,
      );
      if (received !== line.received_units) {
        db.prepare('UPDATE purchase_lines SET received_units=? WHERE id=?').run(received, line.id);
        db.prepare('UPDATE purchases SET version=version+1 WHERE id=?').run(line.purchase_id);
      }
    }
    for (const item of db.prepare('SELECT id FROM stock_items').all()) {
      let balance = 0;
      for (const m of db
        .prepare('SELECT * FROM stock_movements WHERE item_id=? ORDER BY created_at,rowid')
        .all(item.id)) {
        const before = balance;
        balance += Number(m.delta_units);
        if (!Number.isSafeInteger(balance) || balance < 0 || balance > 999999999999)
          throw new ImportError(
            '库存编号' +
              item.id +
              '重算后出现无效余额。可选择保留已发生库存并解除来源引用；本次数据库改动已回滚。',
            409,
          );
        if (m.before_units !== before || m.after_units !== balance)
          db.prepare('UPDATE stock_movements SET before_units=?,after_units=? WHERE id=?').run(
            before,
            balance,
            m.id,
          );
      }
    }
    for (const order of this.store.orders(true)) {
      const total = precisionTotal(order.lines);
      if (order.totalCents !== total.cents)
        db.prepare('UPDATE orders SET total_cents=?,version=version+1 WHERE id=?').run(
          total.cents,
          order.id,
        );
      const extension = db
        .prepare('SELECT document FROM order_extensions WHERE order_id=?')
        .get(order.id);
      if (extension) {
        const doc = JSON.parse(String(extension.document));
        doc.totalAmountExact = total.exact;
        db.prepare('UPDATE order_extensions SET document=? WHERE order_id=?').run(
          JSON.stringify(doc),
          order.id,
        );
      }
    }
    new FlowService(this.store).refreshOrderProgress(affectedOrders);
  }
}
