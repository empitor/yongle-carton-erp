import { isRecord } from '../core/index.js';
import { historyFieldLabel, type HistoryRefs } from './history-fields.js';
import { blank, EMPTY, labelOf, linesText, orderRefName, statusOf, unitOf, valueText, withUnit, type Ctx, type Row } from './history-text.js';
import { purchaseStatusLabel } from './labels.js';
import { flowStatusText, isFlowKind } from './physical-flow.js';
import { changeItem, contents, recordChanges, type HistoryItem } from './record-changes.js';

/**
 * “修改历史 → 查看变更内容”：把一条业务审计（business_audit）变成给人看的几行“字段：改之前 → 改之后”。
 * 字段名用数据管理那一套（dataManagementFieldName），这里只按名字的写法换说法（“客户编号”显示成单号或名称时叫“客户”，
 * “价格（分）”按元显示时叫“价格”），不另起一张名称表。认不出的字段、内部字段不显示；认不出的审计内容只说一句，
 * 不回退成原始 JSON。字段引用哪张表、哪些不显示、动作叫什么这些词表在 history-fields.ts，
 * 一个值怎么写在 history-text.ts，两份记录怎么比在 record-changes.ts。
 */

export type HistoryView = { items: HistoryItem[]; note?: string };
/** 一种审计内容认出来没有（known），认出来的几行 */
type Section = { known: boolean; items: HistoryItem[] };

/** 改之后的记录：审计里叫 after；本机管理员数据管理记的是 result（是一条记录时才算） */
const afterOf = (d: Row) =>
  isRecord(d.after) ? d.after : isRecord(d.result) && typeof d.result.id === 'number' && !('results' in d.result) ? d.result : null;
const statusActions = new Set(['confirm', 'cancel', 'reverse', 'delivered', 'archive', 'restore']);

/**
 * 更正（server/flow/correction.ts）的前后：记在原单、替代单上，到货的还记在采购单上，前后是原单和替代单。
 * 列单号、日期；到货、送货列明细，完工列合格、报废和领料。
 */
function correctionItems(ctx: Ctx, b: Row, a: Row): HistoryItem[] {
  const kind = ctx.module === 'purchases' ? 'arrival' : ctx.module,
    flow: Ctx = { ...ctx, module: kind };
  const pairs: [string, string, string][] = ['reference', 'date']
    .filter((key) => !blank(b[key]) && !blank(a[key]))
    .map((key) => [labelOf(key), String(b[key]), String(a[key])]);
  if (kind === 'production')
    pairs.push(
      ...['goodQuantity', 'scrapQuantity'].map((key): [string, string, string] => [
        labelOf(key, '', kind),
        valueText(flow, key, b[key], b, '') ?? EMPTY,
        valueText(flow, key, a[key], a, '') ?? EMPTY,
      ]),
      ['领料', linesText(flow, b.materials, 'materials'), linesText(flow, a.materials, 'materials')],
    );
  else pairs.push([kind === 'delivery' ? '送货明细' : '到货明细', linesText(flow, b.lines, 'lines'), linesText(flow, a.lines, 'lines')]);
  return pairs.filter(([, before, after]) => before !== after).map(([label, before, after]) => ({ label, value: before + ' → ' + after }));
}

export const HISTORY_UNKNOWN = '这次修改的详细内容暂时不能逐项列出。';
export const HISTORY_NO_CHANGE = '没有需要列出的内容变化。';

/** 导出采购单、送货单：文件名，导出后做了什么 */
function generateItems(d: Row): HistoryItem[] {
  const items: HistoryItem[] = [];
  if (typeof d.filename === 'string') items.push({ label: '导出文件', value: d.filename });
  if (d.markOrdered) items.push({ label: '导出后', value: '采购单标记为已订货' });
  if (d.markShipped) items.push({ label: '导出后', value: '送货单出库' });
  return items;
}

/** 导出完成：单据或采购单的状态前后 */
function downloadItems(ctx: Ctx, d: Row): HistoryItem[] {
  const text = (s: unknown) =>
    typeof s !== 'string' || !s ? EMPTY : isFlowKind(ctx.module) ? flowStatusText({ kind: ctx.module, status: s }) : purchaseStatusLabel(s);
  return d.before !== d.after ? [{ label: '状态', value: text(d.before) + ' → ' + text(d.after) }] : [];
}

/** 库存品上记的一笔出入库：余额前后、日期、关联订单、备注 */
function movementItems(ctx: Ctx, before: string, after: string, source: unknown): HistoryItem[] {
  const unit = unitOf(ctx, undefined, '');
  const items: HistoryItem[] = [{ label: '库存', value: withUnit(before, unit) + ' → ' + withUnit(after, unit) }];
  const s = isRecord(source) ? source : {};
  if (!blank(s.date)) items.push({ label: historyFieldLabel('date') || '日期', value: String(s.date) });
  if (typeof s.orderId === 'number') items.push({ label: historyFieldLabel('customerOrderId') || '订单', value: orderRefName(ctx, s.orderId) });
  if (!blank(s.notes)) items.push({ label: historyFieldLabel('notes') || '备注', value: String(s.notes) });
  return items;
}

/** 只有改之前的记录：取消写状态前后，删除写删了哪条，别的不列 */
function removedItems(ctx: Ctx, action: string, before: Row): HistoryItem[] {
  if (action === 'cancel') {
    const b = statusOf(ctx.module, before);
    return [{ label: '状态', value: (b || EMPTY) + ' → ' + (statusOf(ctx.module, { ...before, status: 'cancelled' }) || '已取消') }];
  }
  if (action !== 'delete') return [];
  const name = [before.number, before.name].find((v) => typeof v === 'string' && v.trim());
  return [{ label: '删除', value: name ? String(name) : '这条记录' }];
}

/** 记录的前后：两份都有逐字段比，只有改之后列内容，只有改之前按动作写；都没有返回 null */
function recordItems(ctx: Ctx, action: string, before: Row | null, after: Row | null) {
  if (before && after)
    return recordChanges(ctx.module, before, after, ctx.refs, { withLines: !statusActions.has(action), recordId: ctx.recordId }).map(changeItem);
  if (after) return contents(ctx, after);
  if (before) return removedItems(ctx, action, before);
  return null;
}

const archivedText = (v: unknown) => (v ? '已归档' : '正常');
/** 审计里记了归档前后、且变了的一行 */
function archiveFlip(d: Row): HistoryItem | null {
  if (typeof d.beforeArchived !== 'boolean' || typeof d.afterArchived !== 'boolean' || d.beforeArchived === d.afterArchived) return null;
  return { label: '归档', value: archivedText(d.beforeArchived) + ' → ' + archivedText(d.afterArchived) };
}

/** 顺带记的几项：去掉的明细挪到哪张送货单、删除时库存怎么办、相关单据 */
function extraItems(d: Row): HistoryItem[] {
  const items: HistoryItem[] = [];
  if (isRecord(d.movedTo) && typeof d.movedTo.number === 'string') items.push({ label: '去掉的明细挪到', value: d.movedTo.number });
  if (d.inventoryPolicy === 'recalculate' || d.inventoryPolicy === 'preserve')
    items.push({ label: '库存', value: d.inventoryPolicy === 'recalculate' ? '一起改回' : '数量不动' });
  if (typeof d.document === 'string' && d.document.trim()) items.push({ label: '相关单据', value: d.document.trim() });
  return items;
}

/** 记录的新建、修改、状态动作、归档、删除这些 */
function recordSection(ctx: Ctx, action: string, d: Row): Section {
  const before = isRecord(d.before) ? d.before : null;
  const items: HistoryItem[] = [];
  let known = action === 'edit-info';
  if (isRecord(d.from) && typeof d.from.number === 'string') {
    known = true;
    items.push({ label: '原送货单', value: d.from.number });
  }
  const main = recordItems(ctx, action, before, afterOf(d));
  if (main) {
    known = true;
    items.push(...main);
  }
  const flip = archiveFlip(d);
  if (flip) {
    known = true;
    items.push(flip);
  } else if ((action === 'archive' || action === 'restore') && before)
    items.push({ label: '归档', value: action === 'archive' ? '正常 → 已归档' : '已归档 → 正常' });
  items.push(...extraItems(d));
  return { known, items };
}

function sectionOf(ctx: Ctx, action: string, d: Row): Section {
  if (action === 'generate') return { known: true, items: generateItems(d) };
  if (action === 'download-complete') return { known: true, items: downloadItems(ctx, d) };
  if (typeof d.before === 'string' && typeof d.after === 'string' && 'deltaUnits' in d)
    return { known: true, items: movementItems(ctx, d.before, d.after, d.source) };
  if (action === 'correct')
    return { known: true, items: isRecord(d.before) && isRecord(d.after) ? correctionItems(ctx, d.before, d.after) : [] };
  return recordSection(ctx, action, d);
}

/**
 * 一条修改历史要显示的几行。entry 是关联与历史接口给的一条（module 是这条记录的模块，detail 是审计存的内容），
 * refs 是接口一起给的引用名称。认不出的内容返回 note，不返回原始数据。
 */
export function historyView(
  entry: { module: string; action: string; detail: unknown; recordId?: number },
  refs: HistoryRefs = {},
): HistoryView {
  const ctx: Ctx = { module: entry.module, refs, recordId: entry.recordId };
  const d = entry.detail;
  if (!isRecord(d)) return { items: [], note: HISTORY_UNKNOWN };
  const { known, items } = sectionOf(ctx, entry.action, d);
  const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
  if (reason) items.push({ label: '原因', value: reason });
  if (!known && !reason) return { items: [], note: HISTORY_UNKNOWN };
  return items.length ? { items } : { items, note: HISTORY_NO_CHANGE };
}
