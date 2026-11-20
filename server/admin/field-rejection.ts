import { dataManagementFieldName } from '../../shared/business/index.js';
import type { FieldPath } from './input-fields.js';
import { readableIssues } from './record-edit-rules.js';
// 数据管理保存时补丁里有录入结构不收的栏目（input-fields.ts 的 rejectedFields 找出来的）：怎么说清是哪一格。
// 叫法一律中文，不露字段代码；认不出的栏目只说“有系统不认识的栏目”。

/**
 * 读出来的记录才有的栏目（系统算出来的、只读的）的叫法：编辑窗里没有这些格子，所以不在数据管理的字段叫法表里
 * （放进那张表会让修改历史也显示它们）。顶层另有叫法的在 topNames。
 */
const derivedNames: Record<string, string> = {
  id: '编号',
  version: '版本号',
  createdAt: '建档时间',
  updatedAt: '修改时间',
  archived: '是否已归档',
  number: '单号',
  actorName: '经办人',
  confirmedAt: '确认时间',
  confirmedBy: '确认人',
  movements: '库存流水',
  reversal: '撤销记录',
  cancellation: '取消记录',
  correctionReason: '更正原因',
  correctedAt: '更正时间',
  replacedBy: '替代它的单据',
  correctionOfReceiptId: '更正的原到货记录',
  actualDate: '实际完成日期',
  shippedAt: '出库时间',
  shippedBy: '出库人',
  deliveredAt: '送达时间',
  deliveredBy: '确认送达的人',
  customerName: '客户名称',
  customerIds: '关联的客户',
  supplierName: '供应商名称',
  orderBatchNumber: '订货单号',
  sourceFileName: '送货单原件名',
  area: '面积（平方米）',
  amount: '金额',
  amountExact: '金额',
  purchaseId: '采购单',
  purchaseNumber: '采购单号',
  orderNumber: '订单号',
  costCents: '预估成本合计',
  shippedQuantity: '已发数量',
  remainingQuantity: '剩余数量',
  shippingStatus: '发货进度',
  shippingProgress: '发货进度',
  shippingSummary: '发货情况',
  materialProgress: '备料进度',
  totalCents: '订单金额',
  totalAmountExact: '订单金额',
  arrivalProgress: '到货进度',
  arrivalSummary: '到货情况',
  arrivalStatus: '到货进度',
  baseStatus: '采购单自己定的状态',
  businessStatus: '采购单的业务状态',
  customerOrderNumber: '关联订单号',
  customerOrders: '关联的客户订单',
  quantityUnits: '数量（系统换算）',
  receivedQuantity: '已到数量',
  receivedUnits: '已到数量（系统换算）',
  remainingUnits: '剩余数量（系统换算）',
  receivedAmount: '已到货金额',
  totalAmount: '采购金额',
  receipts: '到货记录',
  purchaseHistory: '采购记录',
  balanceUnits: '库存数量',
  availableUnits: '可用数量',
  reserved: '已占用数量',
  reservedUnits: '已占用数量（系统换算）',
  onOrder: '在途数量',
  onOrderUnits: '在途数量（系统换算）',
  usage: '用没用过',
  hasProduction: '有没有完工',
  actualStartDate: '实际开工日期',
  actualCompletionDate: '实际完工日期',
  completed: '已完工数量',
  pendingCompleted: '待入库的完工数量',
  progress: '生产进度',
};
/** 顶层另有叫法的：单据的种类、库存品的数量（库存余额）、采购单按明细汇总的关联订单（和单头的“关联订单”不是一回事） */
const topNames: Record<string, string> = { kind: '单据种类', quantity: '库存数量', orderIds: '各行关联的订单' };
/** 顶层的这几格改了要换个地方办：库存数量登记盘点，单据状态用确认、取消、撤销 */
const STOCK_QUANTITY_KEYS = new Set(['quantity', 'balanceUnits', 'availableUnits']);
const STOCK_HINT = '库存数量请登记盘点';
const STATUS_HINT = '单据状态请用确认、取消、撤销';

const own = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);
/** 读出来才有的栏目的叫法（没有返回 undefined，交给数据管理的字段叫法） */
const derivedName = (key: string, parent: string) => (!parent && own(topNames, key)) || own(derivedNames, key);
/** 这一格最后的字段名和上一层的字段名（明细行号不算） */
function keyOf(path: FieldPath) {
  const [key = '', parent = ''] = path.filter((s): s is string => typeof s === 'string').reverse();
  return { key, parent };
}
/** 这一格有没有中文叫法；没有的只说它在哪一层有不认识的栏目 */
function named(path: FieldPath, module: string) {
  const { key, parent } = keyOf(path);
  return derivedName(key, parent) !== undefined || dataManagementFieldName(key, parent, module) !== key;
}

/** 补丁里改了的、不认识的栏目，写成一句给人看的话（不露字段代码），后面按情况说该去哪办 */
export function rejectionText(module: string, rejected: { changed: FieldPath[]; unknown: FieldPath[] }) {
  const issues = [
    ...rejected.changed.map((path) => ({ path, message: '是系统算出来的，不能改' })),
    ...rejected.unknown.map((path) =>
      named(path, module) ? { path, message: '这里不收这一项' } : { path: path.slice(0, -1), message: '有系统不认识的栏目' },
    ),
  ];
  const top = [...rejected.changed, ...rejected.unknown].filter((p) => p.length === 1).map((p) => String(p[0]));
  const hints = [
    module === 'stock_items' && top.some((k) => STOCK_QUANTITY_KEYS.has(k)) ? STOCK_HINT : '',
    top.includes('status') ? STATUS_HINT : '',
  ].filter(Boolean);
  return readableIssues(issues, module, derivedName) + '。没有保存，请去掉或改回这几项再提交' + (hints.length ? '；' + hints.join('；') : '') + '。';
}
