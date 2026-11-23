import { currencyNames, dimensionUnitNames, fieldName, fieldTables, isRecord, priceBasisNames, roundingPolicyLabels } from '../core/index.js';
import type { FieldTable } from '../core/index.js';
import { movementLabels } from './movement-filters.js';
import { stockKindNames } from './operations.js';
import { recordStatusActionNames } from './record-status.js';

/*
 * 修改历史的词表（record-history.ts 用）：字段引用哪张表、哪些是内部字段、数量和尺寸是哪几项、存代码的字段怎么叫、
 * 每种动作的叫法，以及字段中文名和审计里引用到的编号。
 */

/** 审计里引用别的记录的编号，按表批量换成名称或单号（服务端 server/business/history-refs.ts 查好一起给界面） */
type HistoryRefTable = 'customers' | 'suppliers' | 'products' | 'stock_items' | 'orders' | 'flow';
export type HistoryRefs = Partial<Record<HistoryRefTable, Record<string, { name: string; unit?: string }>>>;

/** 修改历史能查名称的几张表（单据记作 flow）；指向别的表的（订单明细、原件、订货单）是内部字段，不显示 */
const historyTables: Partial<Record<FieldTable, HistoryRefTable>> = {
  customers: 'customers',
  suppliers: 'suppliers',
  products: 'products',
  stock_items: 'stock_items',
  orders: 'orders',
  flow_documents: 'flow',
};
/** 栏目 → 修改历史按哪张表查名称：从栏目登记表的“指向哪张表”取（shared/core/field-names.ts 的 fieldTables） */
export const refTables: Record<string, HistoryRefTable> = Object.fromEntries(
  Object.entries(fieldTables).flatMap(([key, table]) => {
    const ref = historyTables[table];
    return ref ? [[key, ref]] : [];
  }),
);
/** 引用编号旁边单据里自己存的名称快照：编号查不到（删了）时先用它，再不行写“已删除的记录” */
export const snapshotNames: Record<string, string> = {
  customerId: 'customerName',
  supplierId: 'supplierName',
  productId: 'productName',
};
/** 有中文名、但只是内部编号或系统字段的，不显示 */
export const internalFields = new Set([
  'id',
  'version',
  'createdAt',
  'updatedAt',
  'sourceId',
  'orderLineId',
  'purchaseLineId',
  'orderBatchId',
  'requestId',
  'movements',
  'dimensionUnitRaw',
]);
export const quantityFields = new Set([
  'quantity',
  'goodQuantity',
  'scrapQuantity',
  'issued',
  'returned',
  'statedQuantity',
  'acceptedQuantity',
  'rejectedQuantity',
  'stockedQuantity',
]);
export const sizeFields = new Set(['length', 'width', 'height', 'dimensionUnit']);
export const lineFields = new Set(['lines', 'materials']);
/**
 * 存的是代码的几个字段：显示的字。修改历史、助手卡片、数据管理的下拉都用这一张；每种叫法写在选项的值旁边
 * （种类 operations.ts、尺寸单位 product-details.ts、计价方式 units.ts、金额结算 domain.ts、币种 currency.ts）
 */
export const codeNames: Record<string, Readonly<Record<string, string>>> = {
  kind: stockKindNames,
  dimensionUnit: dimensionUnitNames,
  priceBasis: priceBasisNames,
  roundingPolicy: roundingPolicyLabels,
  currency: currencyNames,
};

/**
 * 修改历史里每种动作的叫法。服务端写审计的动作都要在这里（tests/record-history.test.ts 逐个核对）；
 * 没登记的界面写“其他操作”，不露英文代码。
 */
export const historyActionNames: Record<string, string> = {
  create: '新建',
  update: '修改',
  archive: '归档',
  restore: '恢复',
  delete: '删除',
  confirm: '确认',
  cancel: '取消',
  // 订单、采购单的状态动作（shared/business/record-status.ts）：确认、取消和上面同名，另有退回、恢复为待确认/待订货
  revert: recordStatusActionNames.revert,
  reinstate: recordStatusActionNames.reinstate,
  reverse: '撤销',
  // 单据流转记的动作（server/flow/service.ts）。界面不说“草稿”：还没核对的单据新建、修改就叫新建、修改
  'create-draft': '新建',
  'update-draft': '修改',
  'update-confirmed-task': '修改已下达的任务',
  'issue-task': '安排生产（下达）',
  schedule: '调整计划日期',
  delivered: '确认送达',
  // 已生效的到货、送货、完工单只改说明：备注、时间、地址联系人、操作人（server/flow/document-info.ts）
  'edit-info': '编辑说明',
  // 更正已生效的到货、送货、完工单（server/flow/correction.ts）：原单、替代单各记一条，到货的采购单上也记一条
  correct: '更正',
  // 本机管理员改库存品时到货单里的纸板资料跟着改（server/flow/maintenance-cascade.ts）
  'edit-related-stock': '库存品资料同步到单据',
  // 本机管理员改订单时送货单跟着变（server/flow/rules/order-edit-cascade.ts 记的三种）
  'split-delivery': '拆分送货单',
  'remove-delivery-lines': '送货单去掉明细',
  'change-delivery-customer': '送货单换客户',
  // 库存品上记的出入库（server/operations/service.ts 的 recordMovement），叫法和库存流水一样
  in: movementLabels.in,
  out: movementLabels.out,
  adjust: movementLabels.adjust,
  purchase: movementLabels.purchase,
  // 导出采购单、送货单（server/documents/service.ts）
  generate: '导出单据',
  'download-complete': '导出完成',
  // 订货单上记的：采购单改了、或删除时从订货单里移出（server/operations/batches.ts、deletion.ts）
  detach: '移出采购单',
};
export const historyActionName = (action: string) => historyActionNames[action] || '其他操作';

/** 审计内容往下找引用编号最多找几层（内容是服务端自己写的，几层就到底；防止异常数据绕圈） */
const MAX_REF_DEPTH = 8;

/** 审计内容里引用到的编号，按表收齐，给服务端一次查名称（不逐条查） */
export function historyRefIds(details: unknown[]): Record<HistoryRefTable, number[]> {
  const found: Record<HistoryRefTable, Set<number>> = {
    customers: new Set(),
    suppliers: new Set(),
    products: new Set(),
    stock_items: new Set(),
    orders: new Set(),
    flow: new Set(),
  };
  const add = (table: HistoryRefTable, v: unknown) => {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) found[table].add(v);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > MAX_REF_DEPTH) return;
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (isRecord(v))
      for (const [k, x] of Object.entries(v)) {
        const table = refTables[k];
        if (table) Array.isArray(x) ? x.forEach((n) => add(table, n)) : add(table, x);
        else walk(x, depth + 1);
      }
  };
  for (const d of details) walk(d, 0);
  const ids = (table: HistoryRefTable) => [...found[table]];
  return {
    customers: ids('customers'),
    suppliers: ids('suppliers'),
    products: ids('products'),
    stock_items: ids('stock_items'),
    orders: ids('orders'),
    flow: ids('flow'),
  };
}

/**
 * 字段中文名：栏目登记表的叫法，不带单位（这里显示的是名称、按元写好的金额）。
 * 内部字段、没有中文名的返回 null（不显示）。
 */
export function historyFieldLabel(key: string, parent = '', module = '') {
  if (internalFields.has(key)) return null;
  return fieldName(key, { record: module, parent }) ?? null;
}
