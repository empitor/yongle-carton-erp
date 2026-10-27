import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { audit, requirePermission, isSuperMode } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { OperationsService } from '../operations/service.js';
import { quantityUnits, quantityString, stockItemSchema } from '../../shared/operations.js';
import {
  flowInput,
  sheetArea,
  purchaseLineAmount,
  type FlowKind,
} from '../../shared/physical-flow.js';
import { normalizedDimensions } from '../../shared/product-details.js';
import { isDeveloperActor, requireDeveloper } from '../developer-capability.js';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fail(message: string, status = 422): never {
  throw new ImportError(message, status);
}
const signature = (v: any) =>
  JSON.stringify([
    v.unit,
    v.material || '',
    v.flute || '',
    v.specification || '',
    v.dimensionUnit ? normalizedDimensions(v) : [v.length, v.width, v.height, null],
  ]);
export function flowReference(store: Store, entity: string, id: number) {
  const column: Record<string, string> = {
    customers: 'customer_id',
    suppliers: 'supplier_id',
    products: 'product_id',
    orders: 'order_id',
    purchases: 'purchase_id',
    stock_items: 'stock_id',
  };
  return (
    !!column[entity] &&
    !!store.db.prepare('SELECT 1 FROM flow_refs WHERE ' + column[entity] + '=? LIMIT 1').get(id)
  );
}
export function shippedUnits(store: Store, lineId: number, excluding?: number) {
  let n = 0;
  for (const row of store.db
    .prepare("SELECT id,document FROM flow_documents WHERE kind='delivery' AND status='confirmed'")
    .all())
    if (Number(row.id) !== excluding)
      for (const l of JSON.parse(String(row.document)).lines)
        if (l.orderLineId === lineId) n += quantityUnits(l.quantity);
  return n;
}
export class FlowService {
  readonly ops: OperationsService;
  constructor(readonly store: Store) {
    this.ops = new OperationsService(store);
  }
  private tx<T>(job: () => T): T {
    this.store.db.exec('SAVEPOINT physical_flow');
    try {
      const result = job();
      this.store.db.exec('RELEASE physical_flow');
      return result;
    } catch (e) {
      this.store.db.exec('ROLLBACK TO physical_flow; RELEASE physical_flow');
      throw e;
    }
  }
  list(kind?: FlowKind, includeArchived = false): any[] {
    return this.store.db
      .prepare('SELECT * FROM flow_documents ORDER BY date DESC,id DESC')
      .all()
      .filter(
        (r) =>
          (!kind || r.kind === kind) &&
          (includeArchived || !this.store.archived('flow_' + r.kind, Number(r.id))),
      )
      .map((r) => {
        const doc = JSON.parse(String(r.document));
        const completed =
          r.kind === 'task'
            ? this.list('production', true)
                .filter((p) => p.status === 'confirmed' && p.taskId === r.id)
                .reduce((n, p) => n + quantityUnits(p.goodQuantity), 0)
            : null;
        return {
          ...doc,
          id: Number(r.id),
          kind: r.kind,
          number: r.number,
          date: r.date,
          status: r.status,
          version: r.version,
          actorName: r.actor_name,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          archived: this.store.archived('flow_' + r.kind, Number(r.id)),
          ...(completed == null
            ? {}
            : {
                completed: quantityString(completed),
                progress: Math.min(
                  100,
                  Math.floor((completed / quantityUnits(doc.quantity)) * 100),
                ),
              }),
        };
      });
  }
  get(id: number) {
    return this.list(undefined, true).find((r) => r.id === id) || fail('业务单据不存在。', 404);
  }
  private refs(id: number, doc: any, kind: FlowKind) {
    const add = (r: Record<string, number | null>) => {
      const columns = Object.keys(r);
      this.store.db
        .prepare(
          'INSERT INTO flow_refs(document_id,' +
            columns.join(',') +
            ') VALUES(?,' +
            columns.map(() => '?').join(',') +
            ')',
        )
        .run(id, ...Object.values(r));
    };
    this.store.db.prepare('DELETE FROM flow_refs WHERE document_id=?').run(id);
    if (kind === 'arrival') {
      add({ supplier_id: doc.supplierId });
      for (const l of doc.lines) {
        const p = l.purchaseLineId
          ? this.store.db
              .prepare('SELECT purchase_id FROM purchase_lines WHERE id=?')
              .get(l.purchaseLineId)
          : null;
        add({
          stock_id: l.stockId,
          purchase_line_id: l.purchaseLineId,
          purchase_id: p ? Number(p.purchase_id) : null,
        });
      }
    }
    if (kind === 'task') {
      add({ product_id: doc.productId });
      for (const orderId of doc.orderIds) add({ order_id: orderId });
    }
    if (kind === 'production') {
      add({ product_id: doc.productId, stock_id: doc.finishedStockId, task_id: doc.taskId });
      for (const m of doc.materials) add({ stock_id: m.stockId });
    }
    if (kind === 'delivery') {
      add({ customer_id: doc.customerId });
      for (const l of doc.lines)
        add({
          order_id: l.orderId,
          order_line_id: l.orderLineId,
          stock_id: l.stockId,
          product_id:
            this.store.order(l.orderId, true)?.lines.find((x) => x.id === l.orderLineId)
              ?.productId || null,
        });
    }
  }
  save(kind: FlowKind, raw: any, who: Actor | null | undefined, id?: number) {
    const actor = requirePermission(who, 'business:edit'),
      v = flowInput(kind, raw);
    return this.tx(() => {
      const requestId = raw.requestId === undefined ? null : z.string().uuid().parse(raw.requestId);
      const digest = hash({
        actor: actor.id,
        kind,
        id: id || null,
        input: v,
        version: raw.version,
      });
      if (requestId) {
        const prior = this.store.db
          .prepare(
            "SELECT digest,result FROM operation_requests WHERE kind='flow-save' AND request_id=?",
          )
          .get(requestId);
        if (prior) {
          if (prior.digest !== digest)
            fail('保存请求已使用，请先核对已保存单据，不能用同一请求提交不同内容。', 409);
          return JSON.parse(String(prior.result));
        }
      }
      const before = id ? this.get(id) : null;
      if (before && (before.kind !== kind || before.status !== 'draft'))
        fail('只能编辑未确认草稿，已确认单据请使用冲销更正。', 409);
      if (before?.archived) fail('请先从业务回收站恢复草稿。');
      if (before && before.version !== raw.version) fail('草稿已被修改，请刷新。', 409);
      if (v.correctionOf) {
        const old = this.get(v.correctionOf);
        if (!isSuperMode(actor) || old.kind !== kind || old.status !== 'reversed')
          fail('更正仅允许已验证的超级管理员引用同类型已冲销单据。', 403);
      }
      this.validate(kind, v, actor, false);
      const at = new Date().toISOString();
      if (id)
        this.store.db
          .prepare(
            'UPDATE flow_documents SET document=?,date=?,version=version+1,updated_at=? WHERE id=?',
          )
          .run(JSON.stringify(v), v.date, at, id);
      else {
        const n = Number(
          this.store.db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM flow_documents').get()!.n,
        );
        const prefix = { arrival: 'DH', task: 'SC', production: 'DJ', delivery: 'SH' }[kind];
        id = Number(
          this.store.db
            .prepare(
              "INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at) VALUES(?,?,?,'draft',?,?,?,?,?)",
            )
            .run(
              kind,
              prefix + '-' + v.date.replaceAll('-', '') + '-' + String(n).padStart(5, '0'),
              v.date,
              JSON.stringify(v),
              actor.id,
              actor.name,
              at,
              at,
            ).lastInsertRowid,
        );
      }
      this.refs(id, v, kind);
      const after = this.get(id);
      audit(
        this.store,
        actor,
        'physical-flow',
        before ? 'update-draft' : 'create-draft',
        'flow_' + kind,
        id,
        { before, after },
      );
      if (requestId)
        this.store.db
          .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
          .run('flow-save', requestId, digest, JSON.stringify(after));
      return after;
    });
  }
  private validate(kind: FlowKind, v: any, actor: Actor, confirm: boolean) {
    if (v.correctionOf) {
      const original = this.get(v.correctionOf);
      if (!isSuperMode(actor) || original.status !== 'reversed' || original.kind !== kind)
        fail('更正须由已验证超级管理员操作，且原单必须已冲销。', 403);
    }
    const items = this.ops.repo.items(true),
      purchases = this.ops.repo.purchases(true),
      changes: any[] = [],
      warnings: string[] = [],
      lines: any[] = [];
    const item = (id: number, k: string) => {
      const it = items.find((i) => i.id === id);
      if (!it || it.kind !== k || it.archived)
        fail('请选择正常的' + (k === 'raw' ? '原材料' : '成品') + '库存品。');
      return it;
    };
    const change = (it: any, delta: number, reason: string, lineId?: number, orderId?: number) => {
      changes.push({
        stockId: it.id,
        name: it.name,
        unit: it.unit,
        deltaUnits: delta,
        reason,
        purchaseLineId: lineId || null,
        orderId: orderId || null,
      });
    };
    if (kind === 'arrival') {
      if (!this.ops.repo.suppliers().some((s) => s.id === v.supplierId))
        fail('供应商不存在或已停用。');
      if (v.sourceId) {
        const source = this.store.db
          .prepare('SELECT * FROM flow_sources WHERE id=?')
          .get(v.sourceId);
        if (!source) fail('AI识别原件不存在。');
        if (
          createHash('sha256')
            .update(source!.bytes as Uint8Array)
            .digest('hex') !== source!.hash
        )
          fail('来源文件完整性校验失败。');
      }
      if (
        new Set(v.lines.filter((l: any) => l.purchaseLineId).map((l: any) => l.purchaseLineId))
          .size !== v.lines.filter((l: any) => l.purchaseLineId).length
      )
        fail('同一采购明细不能重复出现，请合并本次到货数量。');
      for (const l of v.lines) {
        stockItemSchema.parse({ ...l.item, kind: 'raw', productId: null });
        const qty = quantityUnits(l.quantity);
        if (qty % 1000) fail('纸板库存按整张登记，不能填写小数张。');
        if (
          l.statedQuantity !== null &&
          quantityUnits(l.statedQuantity) !== qty &&
          !l.differenceReason
        )
          fail('实收数量与送货单数量不一致，请记录差异原因。');
        const purchase = l.purchaseLineId
            ? purchases.find((p) => p.lines.some((x: any) => x.id === l.purchaseLineId))
            : null,
          pl = purchase?.lines.find((x: any) => x.id === l.purchaseLineId);
        if (l.purchaseLineId) {
          if (
            !purchase ||
            purchase.archived ||
            purchase.baseStatus !== '已订货' ||
            purchase.supplierId !== v.supplierId
          )
            fail('采购明细须属于当前供应商的正常已订货采购单。');
          if (v.date < purchase.orderDate) fail('到货日期不能早于采购日期。');
          if (signature(pl) !== signature(l.item))
            fail('实收规格、材质、楞型或单位与采购明细不符，请重新匹配或作为无采购单收货。');
          if (pl.receivedUnits + qty > pl.quantityUnits)
            fail('实收超过采购剩余数量；请核对采购，超出部分作为独立无采购单明细并填写差异原因。');
          if (pl.stockItemId && l.stockId !== pl.stockItemId)
            fail('请使用采购明细已关联的原材料库存品。');
        }
        if (!l.purchaseLineId && !l.differenceReason)
          warnings.push('无采购单收货：' + l.item.name + '，请确认供应商与实际规格。');
        const it = l.stockId ? item(l.stockId, 'raw') : null;
        if (it && signature(it) !== signature(l.item))
          fail('所选库存品的尺寸、材质、楞型、规格或单位不一致，不允许合并。');
        const area = sheetArea(l.item, l.quantity),
          amount = purchaseLineAmount({
            ...l.item,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            priceBasis: l.priceBasis,
          });
        if (area === null)
          warnings.push(l.item.name + '缺少可换算面积的尺寸/单位，面积和面积计价金额待补充。');
        if (l.statedArea !== null && area !== null && Number(l.statedArea) !== Number(area))
          warnings.push(l.item.name + '单据面积与计算面积不同，请核对。');
        const newItem = !it ? { ...l.item, kind: 'raw', productId: null } : null;
        changes.push({
          stockId: it?.id || null,
          name: l.item.name,
          unit: '张',
          deltaUnits: qty,
          reason: '采购到货',
          purchaseLineId: l.purchaseLineId,
          orderId: purchase?.customerOrderId || null,
          newItem,
        });
        lines.push({
          ...l,
          area,
          amount,
          purchaseId: purchase?.id || null,
          purchaseNumber: purchase?.number || '',
          supplierName: this.ops.repo.suppliers().find((s) => s.id === v.supplierId)?.name,
        });
      }
    }
    if (kind === 'task') {
      if (!this.store.product(v.productId)) fail('产品不存在或已停用。');
      if (new Set(v.orderIds).size !== v.orderIds.length) fail('关联客户订单重复。');
      for (const id of v.orderIds) {
        const order = this.store.order(id);
        if (
          !order ||
          !['已确认', '生产中', '待发货'].includes(order.status) ||
          !order.lines.some((l) => l.productId === v.productId)
        )
          fail('生产任务只能关联包含当前产品的正常待完成客户订单。');
      }
    }
    if (kind === 'production') {
      if (!this.store.product(v.productId)) fail('产品不存在或已停用。');
      const finished = item(v.finishedStockId, 'finished');
      if (finished.productId !== v.productId) fail('成品库存品必须关联本次生产产品。');
      const task = v.taskId ? this.get(v.taskId) : null;
      if (
        task &&
        (task.kind !== 'task' ||
          task.status !== 'confirmed' ||
          task.productId !== v.productId ||
          task.unit !== finished.unit ||
          task.archived)
      )
        fail('生产任务、产品、成品单位或状态不匹配。');
      if (new Set(v.materials.map((m: any) => m.stockId)).size !== v.materials.length)
        fail('同一原材料只能登记一次。');
      for (const m of v.materials) {
        const raw = item(m.stockId, 'raw'),
          issued = quantityUnits(m.issued),
          returned = quantityUnits(m.returned);
        if (raw.unit !== '张') fail('生产领用纸板按张登记，请使用数量单位为张的原材料档案。');
        if (issued % 1000 || returned % 1000) fail('领料、退料按整张登记。');
        if (confirm && issued > raw.balanceUnits)
          fail(raw.name + '库存不足，领料数量超过实际库存。', 409);
        change(raw, -issued, '生产领料');
        if (returned) change(raw, returned, '生产退料');
      }
      const good = quantityUnits(v.goodQuantity);
      if (!good && !quantityUnits(v.scrapQuantity)) fail('请登记合格成品或报废数量。');
      if (good) change(finished, good, '生产完工入库');
      if (task && quantityUnits(task.completed) + good > quantityUnits(task.quantity))
        warnings.push('本次完工后将超过生产计划数量，请核对实际产量。');
    }
    if (kind === 'delivery') {
      if (!this.store.customer(v.customerId)) fail('客户不存在或已停用。');
      const selected = new Set<number>();
      for (const l of v.lines) {
        if (selected.has(l.orderLineId)) fail('同一订单明细请合并为一条发货数量。');
        selected.add(l.orderLineId);
        const o = this.store.order(l.orderId),
          ol = o?.lines.find((x) => x.id === l.orderLineId);
        if (
          !o ||
          o.customerId !== v.customerId ||
          !ol ||
          o.status === '草稿' ||
          o.status === '已取消'
        )
          fail('请选择同一客户正常已确认订单的有效产品明细。');
        if (
          o.status === '已发货' &&
          !this.store.db
            .prepare(
              "SELECT 1 FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.order_id=? AND d.kind='delivery'",
            )
            .get(o.id)
        )
          fail('该历史订单已手工标记发货，请先由超级管理员核对并重新开放订单，避免重复交付。');
        const it = item(l.stockId, 'finished'),
          unit = ol.unit || '';
        if (it.productId !== ol.productId || !unit || it.unit !== unit)
          fail('成品产品或计量单位与订单明细不一致，请先补充/核对订单单位。');
        if (
          it.specification &&
          ol.specification &&
          it.specification.replace(/\s+/g, '').replaceAll('×', 'x') !==
            ol.specification.replace(/\s+/g, '').replaceAll('×', 'x')
        )
          fail('成品库存型号与订单规格不同，请选择正确的成品档案，不按产品名称混合出库。');
        const qty = quantityUnits(l.quantity),
          shipped = shippedUnits(this.store, l.orderLineId);
        if (qty + shipped > ol.quantity * 1000) {
          if (!v.allowOverdelivery || !isSuperMode(actor) || !v.overdeliveryReason)
            fail('本次发货超过订单剩余数量，须由已验证的超级管理员明确批准并填写原因。', 403);
          warnings.push(o.number + '超订单数量发货：' + ol.productName);
        }
        change(it, -qty, '客户发货', undefined, o.id);
        lines.push({
          ...l,
          productName: ol.productName,
          specification: ol.specification,
          unit,
          orderNumber: o.number,
          productId: ol.productId,
        });
      }
    }
    const grouped = new Map<number, number>();
    for (const c of changes)
      if (c.stockId) grouped.set(c.stockId, (grouped.get(c.stockId) || 0) + c.deltaUnits);
    if (confirm)
      for (const [id, delta] of grouped) {
        const it = items.find((i) => i.id === id)!;
        if (it.balanceUnits + delta < 0) fail(it.name + '库存不足，不能确认。', 409);
        if (
          !Number.isSafeInteger(it.balanceUnits + delta) ||
          it.balanceUnits + delta > 999999999999
        )
          fail('库存数量超出可保存范围。');
      }
    return { changes, warnings: [...new Set(warnings)], lines };
  }
  private snapshot(doc: any) {
    const refs = this.store.db.prepare('SELECT * FROM flow_refs WHERE document_id=?').all(doc.id),
      snap: any[] = [];
    const tables: Record<string, string> = {
      customer_id: 'customers',
      supplier_id: 'suppliers',
      product_id: 'products',
      order_id: 'orders',
      purchase_id: 'purchases',
      stock_id: 'stock_items',
      task_id: 'flow_documents',
    };
    for (const r of refs)
      for (const [k, t] of Object.entries(tables))
        if (r[k])
          snap.push([
            t,
            r[k],
            this.store.db.prepare('SELECT version FROM ' + t + ' WHERE id=?').get(r[k])?.version,
            this.store.archived(t, Number(r[k])),
          ]);
    const source = doc.sourceId
      ? this.store.db.prepare('SELECT hash,bytes FROM flow_sources WHERE id=?').get(doc.sourceId)
      : null;
    if (
      source &&
      createHash('sha256')
        .update(source.bytes as Uint8Array)
        .digest('hex') !== source.hash
    )
      fail('来源原件校验失败。');
    return {
      id: doc.id,
      version: doc.version,
      document: doc,
      snap,
      sourceHash: source?.hash || null,
    };
  }
  preview(id: number, who: Actor | null | undefined, binding: string) {
    const actor = requirePermission(who, 'business:edit');
    return this.tx(() => {
      const doc = this.get(id);
      if (doc.status !== 'draft' || doc.archived) fail('只有正常草稿可确认。', 409);
      const plan = this.validate(doc.kind, doc, actor, true),
        snapshot = this.snapshot(doc),
        previewId = randomUUID(),
        expiresAt = Date.now() + 10 * 60000;
      this.store.db
        .prepare('INSERT INTO flow_previews VALUES(?,?,?,?,?,?,?)')
        .run(
          previewId,
          id,
          actor.id,
          binding,
          expiresAt,
          hash(snapshot),
          JSON.stringify({ snapshot, plan }),
        );
      return { previewId, expiresAt, document: doc, ...plan, sourceHash: snapshot.sourceHash };
    });
  }
  private movement(
    stockId: number,
    delta: number,
    doc: any,
    actor: Actor,
    reason: string,
    lineId: number | null = null,
    orderId: number | null = null,
    sourceKind?: string,
  ) {
    const before = this.ops.repo.balance(stockId),
      after = before + delta;
    if (after < 0 || !Number.isSafeInteger(after) || after > 999999999999)
      fail('库存不足或数量超限，整张单据未提交。', 409);
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        stockId,
        delta < 0 ? 'out' : doc.kind === 'arrival' ? 'purchase' : 'in',
        delta,
        before,
        after,
        sourceKind || 'flow_' + doc.kind,
        String(doc.id),
        lineId,
        orderId,
        doc.date,
        doc.number + ' · ' + reason,
        actor.id,
        actor.name,
        new Date().toISOString(),
      );
    this.store.db.prepare('UPDATE stock_items SET version=version+1 WHERE id=?').run(stockId);
    return id;
  }
  private updateOrders(ids: number[]) {
    for (const id of new Set(ids)) {
      const order = this.store.order(id, true);
      if (!order) continue;
      const full = order.lines.every((l) => shippedUnits(this.store, l.id!) >= l.quantity * 1000),
        any = order.lines.some((l) => shippedUnits(this.store, l.id!) > 0);
      const tasks = this.store.db
          .prepare(
            "SELECT DISTINCT d.id FROM flow_documents d JOIN flow_refs r ON r.document_id=d.id WHERE r.order_id=? AND d.kind='task' AND d.status='confirmed'",
          )
          .all(id)
          .map((r) => this.get(Number(r.id))),
        pendingStatus = tasks.length
          ? tasks.every((t) => t.progress >= 100)
            ? '待发货'
            : '生产中'
          : '已确认';
      this.store.db
        .prepare('UPDATE orders SET status=?,version=version+1,updated_at=? WHERE id=?')
        .run(full ? '已发货' : any ? '待发货' : pendingStatus, new Date().toISOString(), id);
    }
  }
  confirm(id: number, raw: unknown, who: Actor | null | undefined, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      v = z
        .strictObject({
          previewId: z.string().uuid(),
          requestId: z.string().uuid(),
          acknowledged: z.literal(true),
        })
        .parse(raw),
      input = { id, actor: actor.id, ...v };
    return this.tx(() => {
      const replay = this.store.db
        .prepare(
          "SELECT digest,result FROM operation_requests WHERE kind='flow-confirm' AND request_id=?",
        )
        .get(v.requestId);
      if (replay) {
        if (replay.digest !== hash(input)) fail('请求凭据已用于不同确认内容。', 409);
        return JSON.parse(String(replay.result));
      }
      const p = this.store.db.prepare('SELECT * FROM flow_previews WHERE id=?').get(v.previewId),
        doc = this.get(id);
      if (
        !p ||
        Number(p.document_id) !== id ||
        p.actor_id !== actor.id ||
        p.session_binding !== binding ||
        Number(p.expires_at) < Date.now() ||
        doc.status !== 'draft' ||
        doc.archived
      )
        fail('确认预览失效，请重新核对。', 409);
      if (p.digest !== hash(this.snapshot(doc)))
        fail('单据、库存或关联档案已变化，请重新生成预览。', 409);
      const plan = this.validate(doc.kind, doc, actor, true);
      if (doc.kind === 'arrival') {
        const key = doc.reference.trim().normalize('NFKC').toUpperCase(),
          prior = this.store.db
            .prepare(
              'SELECT document_id FROM flow_receipt_keys WHERE supplier_id=? AND reference=?',
            )
            .get(doc.supplierId, key);
        const legacy = this.store.db
          .prepare(
            'SELECT r.reference,r.document FROM purchase_receipts r JOIN purchases p ON p.id=r.purchase_id WHERE p.supplier_id=?',
          )
          .all(doc.supplierId)
          .some(
            (r) =>
              !JSON.parse(String(r.document)).flowId &&
              String(r.reference).trim().normalize('NFKC').toUpperCase() === key,
          );
        if (legacy) fail('该供应商送货单号已由旧版到货登记入库，不能重复收货。', 409);
        if (prior && Number(prior.document_id) !== doc.correctionOf)
          fail('同一供应商送货单号已收货，不能重复入库。', 409);
        const source = doc.sourceId
          ? this.store.db.prepare('SELECT hash FROM flow_sources WHERE id=?').get(doc.sourceId)
          : null;
        const used = source
          ? this.store.db
              .prepare('SELECT document_id FROM flow_file_uses WHERE hash=?')
              .get(source.hash)
          : null;
        if (used && Number(used.document_id) !== doc.correctionOf)
          fail('该原始送货文件已经确认入库。', 409);
        this.store.db
          .prepare(
            'INSERT INTO flow_receipt_keys VALUES(?,?,?) ON CONFLICT(supplier_id,reference) DO UPDATE SET document_id=excluded.document_id',
          )
          .run(doc.supplierId, key, id);
        if (source)
          this.store.db
            .prepare(
              'INSERT INTO flow_file_uses VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET document_id=excluded.document_id',
            )
            .run(source.hash, id);
      }
      const movements: string[] = [];
      for (const [index, c] of plan.changes.entries()) {
        if (!c.stockId) {
          const created = this.ops.saveItem(c.newItem, actor);
          c.stockId = created.id;
          doc.lines[index].stockId = created.id;
          plan.lines[index].stockId = created.id;
        }
        movements.push(
          this.movement(c.stockId, c.deltaUnits, doc, actor, c.reason, c.purchaseLineId, c.orderId),
        );
        if (doc.kind === 'arrival' && c.purchaseLineId) {
          this.store.db
            .prepare(
              'UPDATE purchase_lines SET received_units=received_units+?,stock_item_id=? WHERE id=?',
            )
            .run(c.deltaUnits, c.stockId, c.purchaseLineId);
        }
      }
      if (doc.kind === 'arrival')
        for (const purchaseId of new Set(
          plan.lines.map((l: any) => l.purchaseId).filter(Boolean),
        )) {
          const relevant = plan.lines.filter((l: any) => l.purchaseId === purchaseId),
            reference = doc.reference + ' [收货' + id + ']';
          this.store.db.prepare('INSERT INTO purchase_receipts VALUES(?,?,?,?,?,?,?,?)').run(
            'flow-' + id + '-' + purchaseId,
            purchaseId,
            reference,
            doc.date,
            JSON.stringify({
              flowId: id,
              items: relevant.map((l: any) => ({
                lineId: l.purchaseLineId,
                quantity: l.quantity,
              })),
              movements,
            }),
            actor.id,
            actor.name,
            new Date().toISOString(),
          );
          this.store.db
            .prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?')
            .run(new Date().toISOString(), Number(purchaseId));
        }
      if (doc.kind === 'production' && doc.taskId)
        this.store.db
          .prepare('UPDATE flow_documents SET version=version+1,updated_at=? WHERE id=?')
          .run(new Date().toISOString(), doc.taskId);
      const after = {
        ...doc,
        supplierName: doc.supplierId
          ? this.ops.repo.suppliers(true).find((s) => s.id === doc.supplierId)?.name
          : undefined,
        customerName: doc.customerId ? this.store.customer(doc.customerId, true)?.name : undefined,
        productName: doc.productId ? this.store.product(doc.productId, true)?.name : undefined,
        lines: plan.lines.length ? plan.lines : doc.lines,
        movements,
        confirmedBy: actor.name,
        confirmedAt: new Date().toISOString(),
      };
      this.store.db
        .prepare(
          "UPDATE flow_documents SET status='confirmed',version=version+1,document=?,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(after), new Date().toISOString(), id);
      this.refs(id, after, doc.kind);
      if (doc.kind === 'delivery') this.updateOrders(doc.lines.map((l: any) => l.orderId));
      if (doc.kind === 'task')
        for (const orderId of doc.orderIds)
          this.store.db
            .prepare(
              "UPDATE orders SET status='生产中',version=version+1 WHERE id=? AND status='已确认'",
            )
            .run(orderId);
      const result = this.get(id);
      this.store.db
        .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
        .run('flow-confirm', v.requestId, hash(input), JSON.stringify(result));
      audit(
        this.store,
        actor,
        doc.sourceId ? 'reviewed-supplier-ai' : 'physical-flow',
        'confirm',
        'flow_' + doc.kind,
        id,
        {
          before: doc,
          after: result,
          plan,
          previewId: v.previewId,
          sourceHash: JSON.parse(String(p.document)).snapshot.sourceHash,
        },
      );
      return result;
    });
  }
  cancel(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit'),
      v = z
        .strictObject({
          version: z.number().int(),
          reason: z.string().trim().min(1).max(1000),
          acknowledged: z.literal(true),
        })
        .parse(raw);
    return this.tx(() => {
      const doc = this.get(id);
      const remainingTask = doc.kind === 'task' && doc.status === 'confirmed' && doc.progress < 100;
      if (doc.version !== v.version || (doc.status !== 'draft' && !remainingTask))
        fail('仅未确认草稿可取消；已确认单据请冲销。', 409);
      this.store.db
        .prepare(
          "UPDATE flow_documents SET status='cancelled',document=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            ...doc,
            cancellation: { reason: v.reason, by: actor.name, at: new Date().toISOString() },
          }),
          new Date().toISOString(),
          id,
        );
      if (remainingTask) this.updateOrders(doc.orderIds);
      audit(this.store, actor, 'physical-flow', 'cancel', 'flow_' + doc.kind, id, {
        before: doc,
        reason: v.reason,
      });
      return this.get(id);
    });
  }
  reverse(id: number, raw: unknown, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'business:edit');
    if (!isSuperMode(actor)) fail('冲销须先验证密码进入超级管理员模式。', 403);
    const v = z
      .strictObject({
        version: z.number().int(),
        reason: z.string().trim().min(1).max(1000),
        acknowledged: z.literal(true),
      })
      .parse(raw);
    return this.tx(() => {
      const doc = this.get(id);
      if (doc.status === 'reversed' && doc.reversal?.reason === v.reason) return doc;
      if (doc.version !== v.version || doc.status !== 'confirmed')
        fail('单据已变更或不是已确认状态。', 409);
      if (
        doc.kind === 'task' &&
        this.list('production', true).some((p) => p.taskId === id && p.status === 'confirmed')
      )
        fail('任务已有确认生产登记，请先冲销相关生产登记。');
      const totals = new Map<number, number>();
      for (const r of this.store.db
        .prepare('SELECT * FROM stock_movements WHERE source_kind=? AND source_id=?')
        .all('flow_' + doc.kind, String(id)))
        totals.set(Number(r.item_id), (totals.get(Number(r.item_id)) || 0) - Number(r.delta_units));
      for (const [stockId, delta] of totals)
        if (this.ops.repo.balance(stockId) + delta < 0)
          fail('相关库存已被后续业务使用，无法冲销；请先处理后续记录。', 409);
      const movements = [];
      for (const [stockId, delta] of totals)
        if (delta)
          movements.push(
            this.movement(
              stockId,
              delta,
              {
                ...doc,
                date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
              },
              actor,
              '冲销：' + v.reason,
              null,
              null,
              'flow_reversal',
            ),
          );
      if (doc.kind === 'arrival') {
        for (const l of doc.lines)
          if (l.purchaseLineId) {
            this.store.db
              .prepare(
                'UPDATE purchase_lines SET received_units=received_units-? WHERE id=? AND received_units>=?',
              )
              .run(quantityUnits(l.quantity), l.purchaseLineId, quantityUnits(l.quantity));
            this.store.db
              .prepare('UPDATE purchases SET version=version+1,updated_at=? WHERE id=?')
              .run(new Date().toISOString(), l.purchaseId);
          }
        this.store.db
          .prepare(
            "UPDATE purchase_receipts SET document=json_set(document,'$.reversed',1) WHERE json_extract(document,'$.flowId')=?",
          )
          .run(id);
      }
      if (doc.kind === 'production' && doc.taskId)
        this.store.db
          .prepare('UPDATE flow_documents SET version=version+1 WHERE id=?')
          .run(doc.taskId);
      this.store.db
        .prepare(
          "UPDATE flow_documents SET status='reversed',version=version+1,document=?,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            ...doc,
            reversal: { reason: v.reason, by: actor.name, at: new Date().toISOString(), movements },
          }),
          new Date().toISOString(),
          id,
        );
      if (doc.kind === 'delivery') this.updateOrders(doc.lines.map((l: any) => l.orderId));
      audit(this.store, actor, 'super-admin', 'reverse', 'flow_' + doc.kind, id, {
        before: doc,
        after: this.get(id),
        reason: v.reason,
        movements,
      });
      return this.get(id);
    });
  }
  developerUpdateTask(id: number, raw: any, who: Actor) {
    const actor = requireDeveloper(who),
      v = flowInput('task', raw);
    return this.tx(() => {
      const before = this.get(id);
      if (before.kind !== 'task' || before.version !== raw.version)
        fail('生产任务版本已变化。', 409);
      if (before.productId !== v.productId || before.unit !== v.unit)
        fail('已有生产登记的任务不能改变产品或数量单位。');
      if (quantityUnits(v.quantity) < quantityUnits(before.completed || '0'))
        fail('计划数量不能少于实际合格完工数量。');
      this.validate('task', v, actor, true);
      this.store.db
        .prepare(
          'UPDATE flow_documents SET document=?,date=?,version=version+1,updated_at=? WHERE id=?',
        )
        .run(JSON.stringify(v), v.date, new Date().toISOString(), id);
      this.refs(id, v, 'task');
      audit(this.store, actor, 'local-developer', 'correct-task', 'flow_task', id, {
        before,
        after: this.get(id),
      });
      return this.get(id);
    });
  }
  archive(id: number, restore: boolean, who: Actor | null | undefined, expectedVersion?: number) {
    const actor = requirePermission(who, 'business:edit');
    return this.tx(() => {
      const doc = this.get(id);
      if (expectedVersion !== undefined && doc.version !== expectedVersion)
        fail('单据已被修改，请刷新后重新核对删除或恢复操作。', 409);
      if (
        !restore &&
        !['draft', 'cancelled', ...(isDeveloperActor(actor) ? ['reversed'] : [])].includes(
          doc.status,
        )
      )
        fail('已影响库存或确认任务必须保留历史，请使用冲销。');
      if (!restore && this.store.db.prepare('SELECT 1 FROM flow_refs WHERE task_id=?').get(id))
        fail('任务存在生产记录关联，不能删除。');
      if (restore)
        this.store.db
          .prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?')
          .run('flow_' + doc.kind, id);
      else
        this.store.db
          .prepare('INSERT OR IGNORE INTO record_lifecycle VALUES(?,?,?,?)')
          .run('flow_' + doc.kind, id, new Date().toISOString(), actor.id);
      this.store.db.prepare('UPDATE flow_documents SET version=version+1 WHERE id=?').run(id);
      audit(
        this.store,
        actor,
        'physical-flow',
        restore ? 'restore' : 'archive',
        'flow_' + doc.kind,
        id,
        { before: doc },
      );
      return this.get(id);
    });
  }
}
