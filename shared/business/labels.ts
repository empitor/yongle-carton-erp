import { flowNames } from './physical-flow.js';

/**
 * 界面上的名字全站一个说法：档案和单据叫什么、几个常用字段叫什么、几个区块叫什么。
 * 改叫法只改这里。
 */
export const recordNames: Record<string, string> = {
  customers: '客户',
  products: '产品',
  orders: '订单',
  suppliers: '供应商',
  purchases: '采购单',
  stock_items: '库存品',
  movements: '流水',
  ...flowNames,
};

export const fieldNames = {
  material: '材质 / 配纸',
  flute: '楞型',
  /** 材质和楞型合在一列时，材质在前 */
  materialFlute: '材质 / 楞型',
  specification: '规格',
  contact: '联系人',
  phone: '联系方式',
  address: '地址',
} as const;

/** 采购单、到货单下面列出每次到货（含更正）的区块 */
export const ARRIVAL_HISTORY_TITLE = '到货记录';

/**
 * 采购单状态全站一套叫法：待订货、待到货、部分到货、已到齐（另有已取消）。
 * 存的值是 待订货 / 已订货 / 部分到货 / 全部到货 / 已取消，这里只换说法，筛选仍按存的值。
 */
export const purchaseStatusOptions = [
  ['待订货', '待订货'],
  ['已订货', '待到货'],
  ['部分到货', '部分到货'],
  ['全部到货', '已到齐'],
  ['已取消', '已取消'],
] as const;
export function purchaseStatusLabel(status: string | undefined | null) {
  return purchaseStatusOptions.find(([value]) => value === status)?.[1] || status || '';
}
/** 采购单的到货进度（未到货 / 部分到货 / 全部到货）换成同一套叫法：待到货 / 部分到货 / 已到齐。 */
export function arrivalProgressText(progress: string | undefined | null) {
  return progress === '未到货' ? '待到货' : purchaseStatusLabel(progress);
}
/** 一张采购单现在的状态（叫法同上）：已取消优先，没到货的看订货状态，到了的看到货进度。 */
export function purchaseState(row: { businessStatus?: string | null; status?: string | null }) {
  if ((row.businessStatus || row.status) === '已取消') return '已取消';
  return purchaseStatusLabel(row.status || row.businessStatus);
}
