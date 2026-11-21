import { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { AppError, changeArchive, exists, many, recordArchiveTarget } from '../core/index.js';
import type { FlowKind, RecordEntity, purchaseBusinessStatuses } from '../../shared/business/index.js';
import { flowStatus } from '../../shared/business/index.js';
import { deliverableOrder, type ArchiveResult } from '../../shared/core/index.js';
import { FlowService } from '../flow/index.js';
import { businessRecord, type BusinessRecordOf } from './records.js';

const documentId = z.object({ id: z.number().int() });
/** 哪几类记录挂着单据：flow_refs 里记它的那一列（还有没核对的单据就不能归档） */
const draftReference: Partial<Record<RecordEntity, string>> = {
  stock_items: 'stock_id',
  purchases: 'purchase_id',
  orders: 'order_id',
};

/** 库存品什么时候不能归档：还有库存、成品还有没做完的生产任务、还有没到齐的采购 */
function stockItemBlocked(store: Store, id: number, row: BusinessRecordOf['stock_items']) {
  // 还有库存先把库存处理掉，不提删除：删库存品会连流水一起删，账就对不上了
  if (row.balanceUnits !== 0) return '库存还不是零，不能归档；先出库或盘点清零，再归档。';
  // 只组装这个产品已下达的任务，不读全部任务
  const task = 'task' satisfies FlowKind,
    cancelled: (typeof purchaseBusinessStatuses)[number] = '已取消';
  const taskIds =
    row.kind === 'finished' && row.productId
      ? many(
          store.db,
          documentId,
          'SELECT DISTINCT d.id FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.product_id=? AND d.kind=? AND d.status=?',
          row.productId,
          task,
          flowStatus.confirmed,
        ).map((r) => r.id)
      : [];
  if (
    taskIds.length &&
    new FlowService(store)
      .list(task, true, undefined, taskIds)
      .some((t) => t.productId === row.productId && t.status === flowStatus.confirmed && Number(t.completed || 0) < Number(t.quantity))
  )
    return '这个成品还有未完成的生产任务，不能归档';
  if (
    exists(
      store.db,
      'SELECT 1 FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE l.stock_item_id=? AND l.received_units<l.quantity_units AND p.status!=? LIMIT 1',
      id,
      cancelled,
    )
  )
    return '这个库存品还有没到齐的采购，不能归档';
  return null;
}

/** 各类记录看自己字段的拦截（挂着没核对的单据那条各类共用，在 blocked 里先查） */
const ownBlocks: { [E in RecordEntity]: (store: Store, id: number, row: BusinessRecordOf[E]) => string | null } = {
  customers: () => null,
  products: () => null,
  suppliers: () => null,
  // 还能送的（已确认、生产中、待发货）不能归档；还没确认的、发完货的、取消的可以
  orders: (_store, _id, row) => (deliverableOrder(row) ? '订单还没发完货，不能归档' : null),
  purchases: (_store, _id, row) =>
    row.baseStatus !== '已取消' && row.lines.some((l) => l.receivedUnits < l.quantityUnits) ? '这张采购单还没到齐，不能归档' : null,
  stock_items: stockItemBlocked,
};

/** 档案什么时候不能归档（客户、产品、订单、供应商、采购单、库存品）；做法和说法在 server/core/archive.ts */
function blocked<E extends RecordEntity>(store: Store, entity: E, id: number, row: BusinessRecordOf[E]): string | null {
  const reference = draftReference[entity];
  if (
    reference &&
    exists(
      store.db,
      'SELECT 1 FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.' + reference + '=? AND d.status=? LIMIT 1',
      id,
      flowStatus.draft,
    )
  )
    return '还有没核对的关联单据，不能归档';
  return ownBlocks[entity](store, id, row);
}

/** 归档、恢复客户、产品、订单、供应商、采购单、库存品：只打标记，记录仍在业务表里。 */
export function changeLifecycle<E extends RecordEntity>(store: Store, entity: E, raw: unknown, who: Actor | null | undefined) {
  return changeArchive(
    raw,
    who,
    recordArchiveTarget(store, {
      load: (id) => {
        const row = businessRecord(store, entity, id, true);
        return row ? { entity, version: row.version, row } : undefined;
      },
      blocked: (id, row) => blocked(store, entity, id, row),
    }),
  );
}

/** 一条一条归档、恢复时（数据管理、助手）：这条没办成就整个请求 409，说明照原样交回 */
export function archivedOrConflict<R extends ArchiveResult<number>>(result: R) {
  if (result.results.some((r) => !r.success)) throw new AppError(result.results.map((r) => r.message).join('；'), 409);
  return result;
}
