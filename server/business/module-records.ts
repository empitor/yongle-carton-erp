import type { Store } from '../core/index.js';
import type { TrackedOrder, FlowKind } from '../../shared/core/index.js';
import { batchNumbers } from '../operations/index.js';
import { sourceFileNames, type FlowService } from '../flow/index.js';
import { businessList, businessRecords } from '../lifecycle/index.js';
import { trackOrders } from '../orders/index.js';
import type { FlowDocView, RecordEntity } from '../../shared/business/index.js';

/*
 * 按模块读记录（数据管理的列表和助手查记录同一份）：档案、订单、采购单、库存品按删除归档按类型读的；
 * 单据按种类读，补上关联的名称。给了编号只读这几条（按主键批量读），没给读全部。
 */

export type EntityRecordOf = {
  [E in RecordEntity]: E extends 'orders' ? TrackedOrder : ReturnType<typeof businessList<E>>[number];
};
/** 档案、带进度的订单、采购单、库存品：全部或按编号 */
export function entityRecords<E extends RecordEntity>(store: Store, entity: E, includeArchived: boolean, ids?: readonly number[]): EntityRecordOf[E][];
export function entityRecords(store: Store, entity: RecordEntity, includeArchived: boolean, ids?: readonly number[]) {
  if (entity === 'orders') {
    const orders = ids ? store.ordersByIds(ids, includeArchived) : store.orders(includeArchived);
    return trackOrders(store, orders);
  }
  return ids ? businessRecords(store, entity, ids, includeArchived) : businessList(store, entity, includeArchived);
}

/** 单据上补的名称：产品名（生产任务、完工）、客户名（送货）、供应商名、订货单号和原件文件名（到货） */
type DocumentNames = { productName?: string; customerName?: string; supplierName?: string; orderBatchNumber?: string; sourceFileName?: string };
export type NamedDocument<K extends FlowKind = FlowKind> = FlowDocView<K> & DocumentNames;

/** 去重的编号（空的、没有的不算） */
const unique = <T>(list: (T | null | undefined)[]) => [...new Set(list.filter((v): v is T => v !== null && v !== undefined && v !== ''))];
const named = (records: readonly { id: number; name: string }[]) => new Map(records.map((r) => [r.id, r.name]));

/**
 * 按编号批量读出单据上要补的名称。单据上记了名字的用记的（核对、确认时写下的），没记的（待入库、待送货还没写）
 * 按现在的档案补，和页面详情同一个取法；订货单号、原件文件名给编辑窗显示单号和文件名，不露内部编号。
 */
function documentNames(flow: FlowService, docs: readonly FlowDocView[]) {
  const products = unique(docs.map((d) => (d.kind === 'task' || d.kind === 'production') && !d.productName ? d.productId : undefined)),
    customers = unique(docs.map((d) => (d.kind === 'delivery' && !d.customerName ? d.customerId : undefined))),
    suppliers = unique(docs.map((d) => (d.kind === 'arrival' && !d.supplierName ? d.supplierId : undefined))),
    batches = unique(docs.map((d) => (d.kind === 'arrival' ? d.orderBatchId : undefined))),
    sources = unique(docs.map((d) => (d.kind === 'arrival' ? d.sourceId : undefined)));
  return {
    products: named(products.length ? flow.store.products(true, products) : []),
    customers: named(customers.length ? flow.store.customers(true, customers) : []),
    suppliers: named(suppliers.length ? flow.ops.suppliers(true, suppliers) : []),
    batches: batchNumbers(flow.store, batches),
    sources: sourceFileNames(flow.store, sources),
  };
}
/** 一张单据要补的名称：记了的用记的，没记的取档案；取不到的不写 */
function namesOf(d: FlowDocView, names: ReturnType<typeof documentNames>): DocumentNames {
  const fill = (stored: string | undefined, map: Map<number, string>, id: number) => stored || map.get(id);
  const fields: DocumentNames =
    d.kind === 'task' || d.kind === 'production'
      ? { productName: fill(d.productName, names.products, d.productId) }
      : d.kind === 'delivery'
        ? { customerName: fill(d.customerName, names.customers, d.customerId) }
        : {
            supplierName: fill(d.supplierName, names.suppliers, d.supplierId),
            orderBatchNumber: d.orderBatchId != null ? names.batches.get(d.orderBatchId) : undefined,
            sourceFileName: d.sourceId ? names.sources.get(d.sourceId) : undefined,
          };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** 单据：全部或按编号，补上关联的名称 */
export function namedDocuments<K extends FlowKind>(flow: FlowService, kind: K, includeArchived: boolean, ids?: readonly number[]): NamedDocument<K>[] {
  const docs = flow.list(kind, includeArchived, undefined, ids);
  const names = documentNames(flow, docs);
  return docs.map((d) => ({ ...d, ...namesOf(d, names) }));
}
