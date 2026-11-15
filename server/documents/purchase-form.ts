import type { Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import { OrderBatchService } from '../operations/index.js';
import {
  batchRows,
  defaultSchedule,
  formatStockSize,
  priceText,
  purchaseLinesOf,
  scheduleText,
  sumMoney,
  type OrderBatchView,
  type PurchaseView,
  type ScheduleEntry,
} from '../../shared/business/index.js';
import { displayAmount, quantityString, today } from '../../shared/core/index.js';
import { joinSpecification, type RawForm } from './forms.js';
// 采购订货单要印的内容（只读，不写库）：一张或几张同一家供应商的采购单合成一份。

type Row = ReturnType<typeof batchRows>[number];
/** 交货日期分几批时“预计交货日期”这一格写的话，这时另起一格写交货安排 */
const SPLIT_DUE = '分批，见交货安排';
const UNPRICED = '待核价';

/** 已经在订货批次里的采购单按整个批次导出；不在同一份订货单里的不能合在一起 */
function batchOf(batches: OrderBatchService, ids: number[]): OrderBatchView | null {
  const owners = [...new Set(ids.map((id) => batches.batchIdOf(id)))];
  if (owners.length > 1)
    throw new AppError('这些采购单不在同一份订货单里，已订货的只能按原来那份订货单重新导出。', 409);
  const owner = owners[0] ?? null;
  const batch = owner !== null ? batches.view(owner) : null;
  if (batch && ids.length > 1 && batch.purchases.length !== ids.length)
    throw new AppError('已订货的只能按原来那份订货单整份重新导出。', 409);
  return batch;
}

/** 要合的采购单（含归档的），按下单日期排；必须都在、都是同一家供应商 */
function purchasesOf(batches: OrderBatchService, memberIds: number[]): PurchaseView[] {
  const purchases = batches.repo
    .purchases(true, memberIds)
    .sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.id - b.id);
  if (purchases.length !== memberIds.length) throw new AppError('采购单不存在。', 404);
  batches.requireOneSupplier(purchases);
  return purchases;
}

/** 预计交货日期：各行只有一个日期就写它，有几个写“分批”，都没写是“日期待定” */
function dueText(rows: Row[]) {
  const dueDates = new Set(rows.flatMap((r) => r.schedule.map((x) => x.dueDate)));
  const onlyDate = dueDates.size === 1 ? [...dueDates][0] : null;
  if (onlyDate) return onlyDate;
  return [...dueDates].some(Boolean) ? SPLIT_DUE : '日期待定';
}

type FieldSource = {
  number: string;
  record: PurchaseView;
  purchases: PurchaseView[];
  batch: OrderBatchView | null;
  supplier: { contact: string; phone: string; address: string } | undefined;
  rows: Row[];
};
/** 抬头信息：单号、供应商、下单和交货日期；分批的写交货安排，几张合并的写对应采购单 */
function purchaseFields({ number, record, purchases, batch, supplier, rows }: FieldSource): [string, string][] {
  const due = dueText(rows),
    single = purchases.length === 1;
  const schedulePlan = rows.filter((r) => r.schedule.some((x) => x.dueDate)).map((r) => r.name + '：' + scheduleText(r));
  const fields: [string, string][] = [
    // 版式只认“采购单号”放在右上角；几张合并时这里是 DG- 开头的订货单号，对应的采购单写在备注里
    ['采购单号', number],
    ['供应商', record.supplierName],
    ['供应商联系信息', [supplier?.contact, supplier?.phone, supplier?.address].filter(Boolean).join(' · ')],
    ['下单日期', single ? record.orderDate : batch?.orderDate || today()],
    ['预计交货日期', due],
  ];
  if (due === SPLIT_DUE) fields.push(['交货安排', schedulePlan.join('；')]);
  if (!single) fields.push(['对应采购单', purchases.map((p) => p.number).join('、')]);
  return fields;
}

const first = (r: Row) => r.lines[0];
/** 明细：序号、品名、规格及尺寸、单位、订购数量、单价及计价单位、金额 */
function purchaseRow(r: Row, i: number) {
  const l = first(r);
  return [
    String(i + 1),
    r.name,
    joinSpecification(l.specification, formatStockSize(l), l.material === r.name ? '' : l.material, l.flute),
    r.unit,
    quantityString(r.orderedUnits),
    // 单价和计价单位和界面同一个写法（priceText：2.7600 → “2.76 元/m²”）；没写计价方式的按数量计，照原来写“元/单位”
    r.unitPrice == null ? UNPRICED : priceText(r.unitPrice, r.priceBasis === 'area' ? 'area' : 'quantity', r.unit),
    r.amount == null ? UNPRICED : displayAmount(r.amount),
  ];
}
/** 模板可选的列：材质、楞型、尺寸，备注里写明细备注和这一行的到货安排 */
function purchaseLineData(r: Row) {
  const l = first(r);
  return {
    material: l.material || '',
    flute: l.flute || '',
    dimensions: formatStockSize(l),
    notes: [r.notes, r.schedule.some((x) => x.dueDate) ? scheduleText(r) : ''].filter(Boolean).join('；'),
    productCode: '',
  };
}
const totalText = (rows: Row[]) => {
  const sum = sumMoney(rows.map((r) => r.amount));
  return sum == null ? sum : displayAmount(sum);
};

/**
 * 订货单：一张或几张同一家供应商的采购单合成一份。同一种纸板合成一行写总数，
 * 到货安排写在明细备注和单据备注里。已经在订货批次里的采购单，按整个批次导出。
 */
export function purchaseForm(store: Store, ids: number[], schedule?: ScheduleEntry[]): RawForm<'purchase'> {
  const batches = new OrderBatchService(store),
    batch = batchOf(batches, ids);
  const purchases = purchasesOf(batches, batch ? batch.purchases.map((p) => p.id) : [...new Set(ids)]);
  const record = purchases[0],
    supplier = batches.repo.suppliers(true, record.supplierId)[0];
  const lines = purchaseLinesOf(purchases.filter((p) => p.baseStatus !== '已取消'));
  // 没给到货安排时按采购单上的预计到货日期排：一行里各采购单的日期相同才写上
  const expected = new Map(purchases.map((p) => [p.id, p.expectedDate || null]));
  const entries = schedule ?? batch?.schedule ?? defaultSchedule(lines, (id) => expected.get(id));
  const rows = batchRows(lines, entries, today());
  const number = batch?.number ?? (purchases.length === 1 ? record.number : batches.nextNumber());
  // 备注格只有两行：只放采购单自己的备注，相同的只写一次，连成一段
  const purchaseNotes = [...new Set(purchases.map((p) => String(p.notes || '').trim()).filter(Boolean))];
  return {
    record: {
      ...record,
      number,
      batch,
      members: purchases.map((p) => ({
        id: p.id,
        number: p.number,
        version: p.version,
        businessStatus: p.businessStatus,
        archived: p.archived,
      })),
      schedule: entries,
    },
    form: {
      title: '采购订货单',
      number,
      draft: false,
      fields: purchaseFields({ number, record, purchases, batch, supplier, rows }),
      headers: ['序号', '产品名称', '规格及尺寸', '单位', '订购数量', '单价及计价单位', '金额（元）'],
      rows: rows.map(purchaseRow),
      lineData: rows.map(purchaseLineData),
      total: totalText(rows),
      notes: purchaseNotes.join('；'),
      signatures: ['采购方确认', '供应商确认'],
    },
  };
}
