// 采购库存的表在删除、初始化时怎么处理（登记接口见 server/core/deletion-rules.ts）。由本模块的 index.ts 引入。
import { audit, one, registerRecordKinds, registerReset, registerTableDeletion, rows } from '../core/index.js';
import { quantityString } from '../../shared/core/index.js';
import { batchRowKey } from '../../shared/business/index.js';
import { batchScheduleText, readBatchSchedule } from './batches/batch-schedule.js';
import { readPurchaseLineDocument, recordMovementRevision, touchPurchases, touchStockItems } from './ledger/ledger.js';
import type { DeletionContext, DeletionGraph, DeletionRow, Store } from '../core/index.js';

// 供应商、采购单、库存品能归档、删了留墓碑（server/core/record-kinds.ts）
registerRecordKinds('采购库存', ['suppliers', 'purchases', 'stock_items']);

/** 删除时一行里的一个值（库里读出来的原样）：按 id 分组、找行用它作键 */
type Cell = DeletionRow[string];

/**
 * 删除时保留下来的订货单，这次去掉的是哪几张采购单：规划（下面 after 那条）按读出的那一行订货单记下，
 * 执行时删除引擎改这一行、afterUpdate 拿到的是同一个行对象，按它取出来写审计。只在这一次删除里用，WeakMap 不留旧的。
 */
const detachedPurchases = new WeakMap<DeletionRow, number[]>();
const batchNow = rows.order_batches.pick({ id: true, number: true, version: true, schedule: true });
const purchaseNumber = rows.purchases.pick({ number: true });
/**
 * 删除里改了订货单（去掉采购单、到货安排去掉只属于它的行、版本号加一）：给订货单记一条审计，和删采购单那条在同一个事务里。
 * 和从订货单移出采购单（batches.ts 的 detach）同一个动作名，来源是数据维护的删除；写清去掉了哪几张、安排少了几行、版本号前后。
 */
function auditBatchDetach(store: Store, ctx: DeletionContext, row: DeletionRow) {
  const purchaseIds = detachedPurchases.get(row) ?? [];
  // 只管“去掉了采购单”这一种改动；别的外键置空（比如导出记录没了）不在这里记
  if (!purchaseIds.length) return;
  const now = one(store.db, batchNow, 'SELECT id,number,version,schedule FROM order_batches WHERE rowid=?', row.__rowid);
  if (!now) return;
  const purchaseNumbers = purchaseIds.map((id) => one(store.db, purchaseNumber, 'SELECT number FROM purchases WHERE id=?', id)?.number ?? ''),
    // 改之前的安排：规划时读的那一行（规划登记了要读 schedule 列）
    before = readBatchSchedule(textOf(row.schedule), now.id),
    after = readBatchSchedule(now.schedule, now.id),
    removed = before.length - after.length,
    named = purchaseNumbers.filter(Boolean);
  audit(store, ctx.actor, {
    action: 'detach',
    entity: 'order_batches',
    id: now.id,
    document: {
      purchaseIds,
      purchaseNumbers,
      deleted: false,
      before,
      after,
      version: { before: row.version ?? null, after: now.version },
      reason:
        '删除采购单' +
        (named.length ? ' ' + named.join('、') : '') +
        '，订货单 ' +
        now.number +
        ' 保留：去掉' +
        (purchaseIds.length > 1 ? '这 ' + purchaseIds.length + ' 张采购单' : '这张采购单') +
        (removed > 0 ? '，到货安排去掉只属于它的 ' + removed + ' 行' : '') +
        '，版本号加一',
      requestId: ctx.mark.requestId ?? null,
    },
  });
}

// 流水来源的单据叫法（修订原因里用，和流水页“来源”同一套说法）
const sourceNames: Record<string, string> = {
  flow_arrival: '到货单',
  flow_production: '完工单',
  flow_delivery: '送货单',
  flow_reversal: '撤销记录',
  purchase_return: '采购退货',
};
/** “这笔出库 -1000 只”：方向、带正负号的数量和单位，单位按主键读库存品 */
function movementWords(store: Store, row: DeletionRow) {
  const delta = Number(row.delta_units),
    unit = one(store.db, rows.stock_items.pick({ unit: true }), 'SELECT unit FROM stock_items WHERE id=?', Number(row.item_id))?.unit;
  return (
    '这笔' +
    (delta < 0 ? '出库 -' : '入库 +') +
    quantityString(Math.abs(delta)) +
    (unit ? ' ' + unit : '')
  );
}
/** 一个值写成文字；没有（null、undefined）是空串 */
const textOf = (v: Cell | undefined) => (v == null ? '' : String(v));

/** 影响清单里一笔流水叫什么：库存品名称、出库还是入库、数量和单位、日期 */
function movementLabel(r: DeletionRow, g: Pick<DeletionGraph, 'byId'>) {
  const item = g.byId('stock_items').get(r.item_id),
    delta = Number(r.delta_units),
    unit = textOf(item?.unit);
  return (
    (textOf(item?.name) || '库存品') +
    ' ' +
    (delta < 0 ? '出库 ' : '入库 ') +
    quantityString(Math.abs(delta)) +
    (unit ? ' ' + unit : '') +
    (r.date ? '（' + textOf(r.date) + '）' : '')
  );
}
/**
 * 订货单里的一张采购单（表名“订货单里的采购单”由界面显示）：只有一张采购单的订货单，单号就是采购单号，
 * 只写一遍；几张一起订的写“采购单号（订货单 DG-…）”
 */
function batchMemberLabel(r: DeletionRow, g: Pick<DeletionGraph, 'byId'>) {
  const batch = textOf(g.byId('order_batches').get(r.batch_id)?.number),
    purchase = textOf(g.byId('purchases').get(r.purchase_id)?.number);
  if (!purchase) return batch ? '订货单 ' + batch : '订货单里的一张采购单';
  return !batch || batch === purchase ? purchase : purchase + '（订货单 ' + batch + '）';
}

/** 按 key 列把行分组（订货单的成员按订货单、采购明细按采购单） */
function groupBy(list: DeletionRow[], key: string) {
  const groups = new Map<Cell, DeletionRow[]>();
  for (const r of list) groups.set(r[key], [...(groups.get(r[key]) || []), r]);
  return groups;
}

registerTableDeletion({
  module: '采购库存',
  statements: {
    suppliers: { update: 'UPDATE suppliers SET', remove: 'DELETE FROM suppliers WHERE rowid=?' },
    purchases: { update: 'UPDATE purchases SET', remove: 'DELETE FROM purchases WHERE rowid=?' },
    purchase_lines: { update: 'UPDATE purchase_lines SET', remove: 'DELETE FROM purchase_lines WHERE rowid=?' },
    stock_items: { update: 'UPDATE stock_items SET', remove: 'DELETE FROM stock_items WHERE rowid=?' },
    stock_movements: { update: 'UPDATE stock_movements SET', remove: 'DELETE FROM stock_movements WHERE rowid=?' },
    order_batches: { update: 'UPDATE order_batches SET', remove: 'DELETE FROM order_batches WHERE rowid=?' },
    order_batch_purchases: {
      update: 'UPDATE order_batch_purchases SET',
      remove: 'DELETE FROM order_batch_purchases WHERE rowid=?',
    },
  },
  // 订货单读到货安排（schedule）：删掉其中一张采购单、订货单还留着时，把只属于它的安排行一起去掉
  columns: { purchase_lines: ['document'], stock_items: ['unit'], stock_movements: 'all', order_batches: ['schedule'] },
  // 管理员改写、删除库存流水都要留修订记录
  // 原因里写清这笔是入库还是出库、带正负号的数量（修订记录表的数量列只写大小），和流水详情上的“数量”对得上
  beforeUpdate(store, ctx, table, row, values) {
    if (table !== 'stock_movements') return;
    const which = movementWords(store, row);
    recordMovementRevision(
      store,
      ctx.actor,
      values.source_kind === 'database-maintenance'
        ? (sourceNames[textOf(row.source_kind)] || '来源单据') +
            '删除，' +
            which +
            '留着、库存数量不动，改成“系统维护”流水'
        : '关联记录删除，' + which + '只解除关联、库存数量不动',
      row,
      values,
    );
  },
  // 流水删了（“库存改回”），这个库存品的结余就变了：版本号加一，删除前打开着的核对入库、登记完工预览
  // （摘要按库存品版本算）确认时报“已变化”，库存编辑窗保存时提示刷新。同一个库存品删几笔就加几次，只要变了就行
  beforeRemove(store, ctx, table, row) {
    if (table !== 'stock_movements') return;
    recordMovementRevision(store, ctx.actor, '随关联记录删除，' + movementWords(store, row) + '一起删掉', row, null);
    touchStockItems(store, [Number(row.item_id)]);
  },
  // 采购明细自己没有版本号：改了它，所属采购单版本加一，删除前打开着的编辑窗保存时会提示刷新。
  // 明细按行关联的客户订单（customer_order_id）是可空外键：订单删了，通用的外键规划把它置空，也走到这里
  // 订货单（有版本号，删除引擎改它时已经加一）：记下改动时间，再给订货单记一条审计（auditBatchDetach）
  afterUpdate(store, ctx, table, row) {
    if (table === 'purchase_lines') touchPurchases(store, [Number(row.purchase_id)], new Date().toISOString());
    if (table === 'order_batches') {
      store.db.prepare('UPDATE order_batches SET updated_at=? WHERE rowid=?').run(ctx.at, row.__rowid);
      auditBatchDetach(store, ctx, row);
    }
  },
  // 库存流水、采购明细、批次成员没有单号和名称：用库存品、所属采购单、批次号给人看
  label(table, r, g) {
    if (table === 'stock_movements') return movementLabel(r, g);
    if (table === 'purchase_lines') {
      const doc = readPurchaseLineDocument(textOf(r.document), Number(r.id));
      return [textOf(g.byId('purchases').get(r.purchase_id)?.number), doc.name].filter(Boolean).join(' ') || textOf(r.id);
    }
    if (table === 'order_batch_purchases') return batchMemberLabel(r, g);
  },
  planners: [
    {
      // 成品一定关联产品（库上有约束），产品删了它的成品库存不能只解除关联、留成没有产品的成品，跟着一起删；
      // 库存品删了，它的流水再按外键跟着删（和直接删这个库存品一样）。放在通用的外键步骤（order 60）前面
      phase: 'cascade',
      order: 20,
      run(g) {
        const products = g.ids('products');
        if (!products.size) return;
        let progress = false;
        for (const item of g.rows('stock_items'))
          if (item.product_id != null && products.has(item.product_id) && !g.gone('stock_items', item))
            progress = g.remove('stock_items', item) || progress;
        return progress;
      },
    },
    {
      // 订货批次：采购单删了就从批次里去掉（按外键删了成员），批次里一张采购单都不剩就一起删
      phase: 'cascade',
      order: 80,
      run(g) {
        // 批次成员表没有 id 列：ids() 里是 undefined，但只要有标成要删的行就不是空的
        if (!g.ids('order_batch_purchases').size) return;
        let progress = false;
        const members = groupBy(g.rows('order_batch_purchases'), 'batch_id');
        for (const batch of g.rows('order_batches')) {
          const list = members.get(batch.id) || [];
          if (!g.gone('order_batches', batch) && list.length && list.every((m) => g.gone('order_batch_purchases', m)))
            progress = g.remove('order_batches', batch) || progress;
        }
        return progress;
      },
    },
    {
      // 订货单里去掉了采购单、订货单还留着（里面还有别的采购单）：到货安排里只属于去掉的采购单的行一起去掉
      // （剩下的采购单明细里已经没有这一行），订货单改一次，版本号加一（删除引擎按版本列自动加）。
      // 打开着的到货安排窗口保存时提示“已更新，请刷新”，不会报“有一行不在这份订货单里”；订货单详情也不留孤立的安排行。
      // 剩下的行照旧：数量比安排的少了，详情按订购数截掉多出来的（shared/business/order-batch.ts 的 scheduleView）。
      // 安排是按现在库里的内容算的、不带时间，预览和执行算出来一样，范围摘要对得上。
      phase: 'after',
      order: 30,
      run(g) {
        const members = g.rows('order_batch_purchases');
        const touched = new Set(members.filter((m) => g.gone('order_batch_purchases', m)).map((m) => m.batch_id));
        if (!touched.size) return;
        const lines = groupBy(g.rows('purchase_lines').filter((l) => !g.gone('purchase_lines', l)), 'purchase_id');
        for (const batch of g.rows('order_batches')) {
          if (!touched.has(batch.id) || g.gone('order_batches', batch)) continue;
          const keys = new Set(
            members
              .filter((m) => m.batch_id === batch.id && !g.gone('order_batch_purchases', m))
              .flatMap((m) => lines.get(m.purchase_id) || [])
              .map((l) => batchRowKey(readPurchaseLineDocument(textOf(l.document), Number(l.id)))),
          );
          const batchId = Number(batch.id),
            schedule = readBatchSchedule(textOf(batch.schedule), batchId);
          detachedPurchases.set(
            batch,
            members.filter((m) => m.batch_id === batch.id && g.gone('order_batch_purchases', m)).map((m) => Number(m.purchase_id)),
          );
          g.patch('order_batches', batch, {
            schedule: batchScheduleText(schedule.filter((e) => keys.has(e.rowKey)), '订货单 ' + batchId),
          });
        }
      },
    },
  ],
});

registerReset({
  module: '采购库存',
  order: 40,
  statements: [
    'DELETE FROM order_batch_purchases',
    'DELETE FROM order_batches',
    'DELETE FROM stock_movement_revisions',
    'DELETE FROM stock_movements',
    'DELETE FROM purchase_lines',
    'DELETE FROM stock_items',
    'DELETE FROM purchases',
    'DELETE FROM suppliers',
  ],
});
