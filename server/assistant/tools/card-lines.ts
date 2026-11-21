// 确认卡片上一行行字怎么写（card-summary.ts 用）：动的是哪条（叫法加单号或名称）、单据每行品名数量、
// 库存从多少变成多少、订货单的到货安排和登记到货、新建记录的标题和一行摘要。
import { flowDocNames, flowKinds, recordNames } from '../../../shared/business/index.js';
import { fieldLabel, fieldShort, quantityString } from '../../../shared/core/index.js';
import { type Obj, type ToolPlan } from '../plan-rules.js';
import { type ToolContext } from './context.js';
import { assistantModules, type Module } from './modules.js';
import { asList, field } from '../chat/result-fields.js';

export type Line = { label: string; value: string };

/** 卡片标题按名称或单号写、按助手的模块读（recordRow）的几种档案；叫法用全站那一份 */
const namedRecords: readonly string[] = ['customers', 'suppliers', 'products', 'orders', 'purchases'];
export const namedModule = (module: string): Module | undefined =>
  namedRecords.includes(module) ? assistantModules.find((m) => m === module) : undefined;
/** 是哪种单据（到货、生产任务、完工、送货）；不是单据就没有 */
export const flowKindOf = (module: string) => flowKinds.find((k) => k === module);

/** 收件的标题最多取正文前几个字 */
const INBOX_TITLE_CHARS = 20;
const partyOf = (row: Obj) => row.customerName || row.supplierName || '';
const inParens = (v: unknown) => (v ? '（' + v + '）' : '');
const titles: Record<string, (row: Obj) => string> = {
  purchase_return: (row) => '采购退货 ' + row.number,
  order_batch: (row) => '订货单 ' + (row.number || row.id) + inParens(row.supplierName),
  inbox: (row) => '收件 ' + (row.file_name || row.sender_name || String(row.text || '').slice(0, INBOX_TITLE_CHARS) || row.id),
  stock_items: (row) => (row.kind === 'raw' ? '原材料 ' : '成品库存 ') + row.name,
  orders: (row) => recordNames.orders + ' ' + row.number + inParens(partyOf(row)),
  purchases: (row) => recordNames.purchases + ' ' + row.number + inParens(partyOf(row)),
};
/** 动的是哪条：模块叫法加单号或名称，订单、采购单、单据带上客户或供应商 */
export function recordTitle(module: string, row: Obj | undefined) {
  if (!row) return '';
  const kind = flowKindOf(module);
  if (kind) return flowDocNames[kind] + ' ' + (row.number || row.id) + inParens(partyOf(row));
  const title = Object.hasOwn(titles, module) ? titles[module] : undefined;
  return title ? title(row) : (namedRecords.includes(module) ? recordNames[module] : '记录') + ' ' + (row.name || row.number || row.id);
}

const stockOf = (ctx: ToolContext, id: unknown) => (typeof id === 'number' ? ctx.ops.items(true, id)[0] : undefined);
/** 一行明细的品名：产品名、实物名、行上的名称，都没有就按库存品 */
const lineName = (ctx: ToolContext, l: unknown) =>
  field(l, 'productName') || field(field(l, 'item'), 'name') || field(l, 'name') || stockOf(ctx, field(l, 'stockId'))?.name || '';
/** 一行明细的单位：行上的、实物的、库存品的，都没有用单据的 */
const lineUnit = (ctx: ToolContext, l: unknown, docUnit: unknown) =>
  field(l, 'unit') || field(field(l, 'item'), 'unit') || stockOf(ctx, field(l, 'stockId'))?.unit || docUnit || '';
const lineQuantity = (l: unknown) => field(l, 'quantity') ?? field(l, 'goodQuantity') ?? '';

/** 单据每行的品名和数量 */
export function documentLines(ctx: ToolContext, doc: Obj | undefined): Line[] {
  if (!doc) return [];
  if (doc.kind === 'task') return [{ label: '产品', value: (doc.productName || '') + ' ' + doc.quantity + ' ' + (doc.unit || '') }];
  return (asList(doc.lines) ?? []).map((l, i) => ({
    label: '第 ' + (i + 1) + ' 行',
    value: [lineName(ctx, l), lineQuantity(l), lineUnit(ctx, l, doc.unit)].filter((v) => v !== '').join(' '),
  }));
}

/** 库存从多少变成多少（库存品的净变化，千分之一的单位） */
export function stockLines(ctx: ToolContext, moves: { item: number; delta: number }[]): Line[] {
  return moves
    .filter((m) => m.delta)
    .map((m) => {
      const item = ctx.ops.items(true, m.item)[0] || { name: '库存品', unit: '' },
        before = ctx.ops.balance(m.item),
        unit = item.unit ? ' ' + item.unit : '';
      return {
        label: '库存',
        value: item.name + '：' + quantityString(before) + unit + ' → ' + quantityString(before + m.delta) + unit + '（' + (m.delta > 0 ? '加 ' : '减 ') + quantityString(Math.abs(m.delta)) + unit + '）',
      };
    });
}

const scheduleText = (s: unknown) => {
  const list = (asList(s) ?? []);
  return list.length ? list.map((x) => field(x, 'quantity') + ' 在 ' + (field(x, 'dueDate') || '日期待定') + ' 前').join('；') : '日期待定';
};
/** 到货安排比前后用：每段的日期和数量 */
const schedulePlan = (s: unknown) => JSON.stringify((asList(s) ?? []).map((e) => [field(e, 'dueDate'), field(e, 'quantity')]));
/** 订货单两张卡片：每行的到货安排、已到多少前后；登记到货另写这次实到、拒收、入库、日期和供应商送货单号 */
export function batchLines(plan: ToolPlan, before: Obj | undefined, after: Obj | undefined): Line[] {
  const out: Line[] = [];
  const oldRows = (asList(before?.rows) ?? []);
  (asList(after?.rows) ?? []).forEach((row, i) => {
    const old = oldRows[i] || {},
      name = '第 ' + field(row, 'row') + ' 行（' + field(row, 'name') + '）';
    if (schedulePlan(field(old, 'schedule')) !== schedulePlan(field(row, 'schedule')))
      out.push({ label: name + ' 到货安排', value: scheduleText(field(old, 'schedule')) + ' → ' + scheduleText(field(row, 'schedule')) });
    if (field(old, 'received') !== field(row, 'received'))
      out.push({ label: name + ' 已到', value: field(old, 'received') + ' → ' + field(row, 'received') + ' ' + (field(row, 'unit') || '') });
  });
  const input = plan.tool === 'order_batch.receive' ? field(plan.args, 'input') : null;
  if (input) out.push(...receivedLines(input, oldRows));
  return out;
}
/** 登记到货这一次：每行实到、拒收、入库（按行键或行号对回订货单的行），到货日期和供应商送货单号 */
function receivedLines(input: unknown, oldRows: unknown[]): Line[] {
  const out: Line[] = [];
  for (const r of (asList(field(input, 'rows')) ?? [])) {
    const key = field(r, 'key') ?? field(r, 'rowKey');
    const row = oldRows.find((x) => field(x, 'key') === key) ?? oldRows[Number(field(r, 'row')) - 1];
    const unit = field(row, 'unit') ? ' ' + field(row, 'unit') : '';
    const stocked = field(r, 'stockedQuantity');
    out.push({
      label: '本次到货' + (row ? '（' + field(row, 'name') + '）' : ''),
      value:
        '实到 ' + field(r, 'quantity') + unit +
        '，' + fieldShort('rejectedQuantity') + ' ' + (field(r, 'rejectedQuantity') ?? '0') + unit +
        (stocked != null ? '，' + fieldShort('stockedQuantity') + ' ' + stocked + unit : ''),
    });
  }
  if (field(input, 'date')) out.push({ label: fieldLabel('date', { record: 'arrival' }), value: String(field(input, 'date')) });
  if (field(input, 'reference')) out.push({ label: fieldLabel('reference'), value: String(field(input, 'reference')) });
  return out;
}

/** 连带新建的单据一行里每行的摘要：品名、数量，到货另写拒收、入库 */
function lineBrief(ctx: ToolContext, l: unknown, docUnit: unknown) {
  const unit = lineUnit(ctx, l, docUnit),
    u = unit ? ' ' + unit : '';
  const name = lineName(ctx, l);
  const quantity = field(l, 'quantity'),
    rejected = field(l, 'rejectedQuantity'),
    stocked = field(l, 'stockedQuantity');
  const extra = [
    rejected != null && Number(rejected) ? fieldShort('rejectedQuantity') + ' ' + rejected + u : '',
    stocked != null && stocked !== quantity ? '入库 ' + stocked + u : '',
  ].filter(Boolean);
  return name + ' ' + (quantity ?? field(l, 'goodQuantity') ?? '') + u + (extra.length ? '（' + extra.join('，') + '）' : '');
}
/** 连带新建的记录一行摘要：单据写每行品名和数量（到货另写拒收、入库），订货单写每行订了多少；档案只写名称 */
export function briefOf(ctx: ToolContext, module: string, row: Obj) {
  if (module === 'order_batch')
    return (asList(row.rows) ?? [])
      .map((r) => field(r, 'name') + ' ' + field(r, 'ordered') + (field(r, 'unit') ? ' ' + field(r, 'unit') : ''))
      .join('；');
  if (!flowKindOf(module)) return '';
  if (row.kind === 'task') return (row.productName || '') + ' ' + row.quantity + ' ' + (row.unit || '');
  return (asList(row.lines) ?? [])
    .map((l) => lineBrief(ctx, l, row.unit))
    .join('；');
}

/**
 * 新建的记录还没占号：出卡片时试执行拿到的“下一个号”不占住，同一轮出的两张新建卡片会撞号，确认时也可能换号。
 * 卡片上不写单号：单据写种类、客户或供应商和每行摘要，订单、采购单写客户或供应商；单号等建出来以后由助手在回复里报。
 */
export function newTitle(ctx: ToolContext, module: string, row: Obj) {
  const who = inParens(partyOf(row));
  const kind = flowKindOf(module);
  if (kind) {
    const brief = briefOf(ctx, module, row);
    return flowDocNames[kind] + who + (brief ? '：' + brief : '');
  }
  if (module === 'orders' || module === 'purchases' || module === 'order_batch') return (module === 'order_batch' ? '订货单' : recordNames[module]) + who;
  if (module === 'purchase_return') return '采购退货';
  return recordTitle(module, row);
}
