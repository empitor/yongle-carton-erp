// 单据流转的表在删除、初始化时怎么处理（登记接口见 server/core/deletion-rules.ts）。由本模块的 index.ts 引入。
import type { Store } from '../core/index.js';
import type { DeletionRow } from '../core/index.js';
import { registerRecordKinds, registerReset, registerTableDeletion } from '../core/index.js';
import { flowDocumentContent, flowKinds, type FlowDocument } from '../../shared/business/index.js';
import { documentOf, storedDocuments } from './documents/read.js';
import { readReturnDocument } from './documents/return-document.js';
import { FlowService } from './rules/service.js';

/** 删除引擎读到的一行单据（规划时读了编号、单号、kind、document 列）的内容 */
const rowDocument = (row: DeletionRow) =>
  documentOf({ id: Number(row.id), number: String(row.number), kind: String(row.kind), document: String(row.document) });
type Deleted = Record<'orders' | 'lines' | 'products' | 'stocks' | 'suppliers' | 'customers', Set<unknown>>;
/** 单据引用的供应商、客户、产品、库存品、订单、订单明细删了：整张单据跟着删 */
function referencesDeleted(doc: FlowDocument, d: Deleted) {
  switch (doc.kind) {
    case 'arrival':
      return d.suppliers.has(doc.supplierId);
    case 'task':
      return d.products.has(doc.productId);
    case 'production':
      return d.products.has(doc.productId) || d.stocks.has(doc.finishedStockId) || doc.materials.some((m) => d.stocks.has(m.stockId));
    case 'delivery':
      return (
        d.customers.has(doc.customerId) ||
        doc.lines.some((l) => d.orders.has(l.orderId) || d.lines.has(l.orderLineId) || d.stocks.has(l.stockId))
      );
  }
}

// 四种单据能归档、删了留墓碑：归档标记和墓碑里记成 flow_<种类>（server/core/record-kinds.ts）
registerRecordKinds('单据流转', flowKinds.map((kind) => 'flow_' + kind));

registerTableDeletion({
  module: '单据流转',
  statements: {
    flow_documents: { update: 'UPDATE flow_documents SET', remove: 'DELETE FROM flow_documents WHERE rowid=?' },
    flow_refs: { update: 'UPDATE flow_refs SET', remove: 'DELETE FROM flow_refs WHERE rowid=?' },
    flow_receipt_keys: { update: 'UPDATE flow_receipt_keys SET', remove: 'DELETE FROM flow_receipt_keys WHERE rowid=?' },
    flow_file_uses: { update: 'UPDATE flow_file_uses SET', remove: 'DELETE FROM flow_file_uses WHERE rowid=?' },
    purchase_returns: { update: 'UPDATE purchase_returns SET', remove: 'DELETE FROM purchase_returns WHERE rowid=?' },
  },
  columns: {
    flow_documents: ['document'],
    purchase_returns: ['document'],
  },
  // 单据表上这三个外键列在 document 里有同名字段（列和 document 同写，见 document-store.ts）：
  // 批次、原单、替代单删了，引擎把列置空的同一句里把 document 里的字段也清掉
  mirrors: {
    flow_documents: {
      order_batch_id: { field: 'orderBatchId', clear: 'remove' }, // 输入结构里它不能是 null，所以去掉键
      correction_of: { field: 'correctionOf', clear: 'null' },
      replaced_by: { field: 'replacedBy', clear: 'remove' }, // 原单仍是已撤销，只是不再指向被删的替代单
    },
  },
  // 影响清单里的叫法：不露内部编号（flow-1-1、#3），用到货单号、采购单号、日期给人看。
  // 表名由界面另外显示（src/records/DeletionImpact.tsx），这里不再重复
  label(table, row, g) {
    const flowNumber = (id: unknown) => {
      const number: unknown = g.byId('flow_documents').get(Number(id))?.number;
      return typeof number === 'string' ? number : undefined;
    };
    if (table === 'flow_refs') return (flowNumber(row.document_id) || '单据') + ' 的关联';
  },
  planners: [
    {
      // 单据 JSON 里的引用：引用的客户、产品、库存品、订单等删了，单据跟着删或解除引用
      phase: 'cascade',
      order: 10,
      run(g) {
        let progress = false;
        const deletedOrders = g.ids('orders'),
          deletedLines = g.ids('order_lines'),
          deletedProducts = g.ids('products'),
          deletedStocks = g.ids('stock_items'),
          deletedPurchases = g.ids('purchases'),
          deletedPurchaseLines = g.ids('purchase_lines'),
          deletedFlows = g.ids('flow_documents'),
          deletedSuppliers = g.ids('suppliers'),
          deletedCustomers = g.ids('customers');
        for (const row of g.rows('flow_documents')) {
          if (g.gone('flow_documents', row)) continue;
          const doc = rowDocument(g.changed('flow_documents', row)),
            before = JSON.stringify(doc);
          const deleted = {
            orders: deletedOrders,
            lines: deletedLines,
            products: deletedProducts,
            stocks: deletedStocks,
            suppliers: deletedSuppliers,
            customers: deletedCustomers,
          };
          if (referencesDeleted(doc, deleted)) {
            progress = g.remove('flow_documents', row) || progress;
            continue;
          }
          // 更正关系、订货批次是单据表上的外键列，由通用的外键规划置空并清掉 document 里的同名字段（上面的 mirrors）
          // 解除的是哪种关联记下来（订单、生产任务、库存品、采购明细），影响清单按它显示，不笼统写“单据内关联”
          const fields = new Set<string>();
          if (doc.kind === 'task' && doc.orderIds.some((id) => deletedOrders.has(id))) {
            doc.orderIds = doc.orderIds.filter((id) => !deletedOrders.has(id));
            fields.add('order_id');
          }
          if (doc.kind === 'production' && deletedFlows.has(doc.taskId)) {
            doc.taskId = null;
            fields.add('task_id');
          }
          if (doc.kind === 'arrival')
            for (const l of doc.lines) {
              if (deletedStocks.has(l.stockId)) {
                l.stockId = null;
                fields.add('stock_id');
              }
              if (
                (l.purchaseLineId !== null && deletedPurchaseLines.has(l.purchaseLineId)) ||
                (l.purchaseId != null && deletedPurchases.has(l.purchaseId))
              ) {
                l.purchaseLineId = null;
                l.purchaseId = null;
                l.purchaseNumber = '';
                fields.add('purchase_line_id');
              }
            }
          if (JSON.stringify(doc) !== before)
            for (const field of fields) g.patchDocument('flow_documents', row, flowDocumentContent(doc), field);
        }
        return progress;
      },
    },
    {
      // 保留下来的采购退货：被删的库存品、采购明细不能留在退货明细里（编号会被重用）
      phase: 'cascade',
      order: 40,
      run(g) {
        const deletedStocks = g.ids('stock_items'),
          deletedPurchaseLines = g.ids('purchase_lines');
        for (const row of g.rows('purchase_returns')) {
          if (g.gone('purchase_returns', row)) continue;
          const changed = g.changed('purchase_returns', row),
            doc = readReturnDocument({ id: Number(changed.id), number: String(changed.number), document: String(changed.document) }),
            before = JSON.stringify(doc);
          const fields = new Set<string>();
          for (const l of doc.lines) {
            if (deletedStocks.has(l.stockId)) {
              l.stockId = null;
              fields.add('stock_id');
            }
            if (deletedPurchaseLines.has(l.purchaseLineId)) {
              l.purchaseLineId = null;
              fields.add('purchase_line_id');
            }
          }
          if (JSON.stringify(doc) !== before) for (const field of fields) g.patchDocument('purchase_returns', row, doc, field);
        }
      },
    },
    {
      // 删除单据不强迫撤销已经发生的库存：按库存处理方式，被删单据的出入库流水一起删（库存重算），
      // 或者留着、来源改成 database-maintenance（界面叫“系统维护”流水）
      phase: 'after',
      order: 10,
      run(g) {
        const deletedFlowIds = g.ids('flow_documents'),
          returnIds = g.ids('purchase_returns');
        for (const row of g.rows('stock_movements'))
          if (!g.gone('stock_movements', row)) {
            const sourceKind: unknown = row.source_kind;
            const flowSource =
              typeof sourceKind === 'string' &&
              /^flow_(arrival|production|delivery|task|reversal)$/.test(sourceKind) &&
              deletedFlowIds.has(Number(row.source_id));
            if (
              flowSource ||
              // 到货单删除时，挂在它下面的采购退货跟着删，退货扣库存的流水同样解除来源或一起重算。
              (row.source_kind === 'purchase_return' && returnIds.has(Number(row.source_id)))
            ) {
              g.countInventoryChoice();
              if (g.policy === 'recalculate') g.remove('stock_movements', row);
              else g.patch('stock_movements', row, { source_kind: 'database-maintenance', source_id: null });
            }
          }
      },
    },
    {
      // 单据 JSON 里的流水编号也是引用，不能在删掉流水后留下失效编号
      phase: 'after',
      order: 20,
      run(g) {
        const deletedMovements = g.ids('stock_movements');
        if (!deletedMovements.size) return;
        for (const row of g.rows('flow_documents')) {
          if (g.gone('flow_documents', row)) continue;
          const doc = rowDocument(g.changed('flow_documents', row));
          if (doc.movements?.some((id) => deletedMovements.has(id))) {
            doc.movements = doc.movements.filter((id) => !deletedMovements.has(id));
            g.patchDocument('flow_documents', row, flowDocumentContent(doc), 'movements');
          }
        }
      },
    },
  ],
});

/** 删除后重算受影响订单的生产、发货进度：删掉、改过的单据挂着哪些订单（完工单要从它的生产任务找回去） */
export function recomputeAfterFlowDeletion(store: Store, changed: { row: DeletionRow }[]) {
  const taskOrderIds = (taskId: number) =>
    storedDocuments(store, [taskId]).flatMap(({ document }) => (document.kind === 'task' ? document.orderIds : []));
  const orderIds = changed.flatMap(({ row }) => {
    const d = rowDocument(row);
    return d.kind === 'task'
      ? d.orderIds
      : d.kind === 'delivery'
        ? d.lines.map((l) => l.orderId)
        : d.kind === 'production' && d.taskId
          ? taskOrderIds(d.taskId)
          : [];
  });
  new FlowService(store).recomputeAfterMaintenance(orderIds);
}

registerReset({
  module: '单据流转',
  order: 30,
  statements: [
    'DELETE FROM flow_file_uses',
    'DELETE FROM flow_receipt_keys',
    'DELETE FROM flow_refs',
    'DELETE FROM flow_sources',
    'DELETE FROM purchase_returns',
    'DELETE FROM flow_documents',
  ],
});
