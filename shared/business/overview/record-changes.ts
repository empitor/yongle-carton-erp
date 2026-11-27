import { isRecord, isFlowKind } from '../../core/index.js';
import { dataManagementFieldName } from '../lifecycle/data-management-modules.js';
import {
  historyFieldLabel,
  internalFields,
  lineFields,
  refTables,
  sizeFields,
  snapshotNames,
  type HistoryRefs,
} from './history-fields.js';
import { blank, EMPTY, labelOf, lineName, linesText, rowSize, statusOf, valueText, type Ctx, type Editable, type Row } from './history-text.js';

/*
 * 两份记录比出“字段：改之前 → 改之后”（修改历史、助手确认卡片），和新建时列出主要内容。
 * 字段名用数据管理那一套（dataManagementFieldName），这里只按名字的写法换说法；认不出的字段、内部字段不显示。
 */

export type HistoryItem = { label: string; value: string };
type Change = { label: string; before: string; after: string };
/** 比一个字段要用的：字段名、两份记录、合起来的记录（判断有没有某个字段）、上一层、比不比明细 */
type Field = { key: string; before: Row; after: Row; merged: Row; parent: string; withLines: boolean };

/** 这个字段要不要列（有中文名、不是内部字段、不和别的字段重复），要列返回它的中文名 */
function shownLabel(ctx: Ctx, key: string, row: Row, parent: string) {
  const label = historyFieldLabel(key, parent, ctx.module);
  if (!label || key === 'status' || sizeFields.has(key)) return null;
  if (key === 'kind' && (isFlowKind(ctx.module) || parent)) return null;
  // 库存品的数量是流水算出来的余额，不是档案里的字段
  if (key === 'quantity' && ctx.module === 'stock_items' && !parent) return null;
  // 有引用编号的，名称快照不再单列（产品名称跟着产品走）
  if (Object.entries(snapshotNames).some(([id, name]) => name === key && id in row)) return null;
  // 精确价和以分存的价都在时只列精确价
  if (key === 'priceCents' && 'priceExact' in row) return null;
  if (key === 'unitPriceCents' && 'unitPriceExact' in row) return null;
  return label;
}

/** 嵌套对象里的字段名：有“上一层.字段”专门名字的（预估成本里的几项）直接用，否则前面加上一层的名字（“纸板 名称”） */
function nestedLabel(label: string, key: string, parent: string, parentLabel: string) {
  return dataManagementFieldName(key, parent) !== dataManagementFieldName(key) ? label : parentLabel + ' ' + label;
}

const same = (b: unknown, a: unknown) => JSON.stringify(b) === JSON.stringify(a);

function statusChange(ctx: Ctx, before: Row, after: Row): Change[] {
  const b = statusOf(ctx.module, before),
    a = statusOf(ctx.module, after);
  return (b || a) && b !== a ? [{ label: '状态', before: b || EMPTY, after: a || EMPTY }] : [];
}

/** 尺寸几项合成一行；写出来一样（没填写和空值）的不算改动 */
function sizeChange(ctx: Ctx, before: Row, after: Row, parent: string): Change[] {
  const touched = [...sizeFields].some((k) => (k in before || k in after) && !same(before[k], after[k]));
  const b = rowSize(before) || EMPTY,
    a = rowSize(after) || EMPTY;
  // 卡片里单据明细原来没写尺寸、核对时补上的快照不算改动
  const filledSnapshot = !!ctx.editable && !!parent && !ctx.editable.lines.has('length') && !rowSize(before);
  return touched && b !== a && !filledSnapshot ? [{ label: '尺寸', before: b, after: a }] : [];
}

/** 不列的字段里，卡片上也不用列的：编号、版本这类内部字段（原文尺寸单位例外，人能改）、合成一行的、名称快照、被精确价盖住的 */
function quietField({ key, before, after, merged }: Field) {
  // 名称快照只在它的编号没变时列（编号变了，那一行已经写了新名称）
  const idKey = Object.entries(snapshotNames).find(([, name]) => name === key)?.[0];
  if (idKey && !same(before[idKey], after[idKey])) return true;
  if (internalFields.has(key) && key !== 'dimensionUnitRaw') return true;
  if (key === 'status' || sizeFields.has(key) || key === 'kind') return true;
  return (key === 'priceCents' && 'priceExact' in merged) || (key === 'unitPriceCents' && 'unitPriceExact' in merged);
}

/** 卡片：人能改的字段不许悄悄略过，没有中文名的照字段名写 */
function hiddenChange(ctx: Ctx, f: Field, b: unknown, a: unknown): Change[] {
  if (quietField(f)) return [];
  if (Array.isArray(b) || Array.isArray(a) ? same(b ?? [], a ?? []) : blank(b) && blank(a)) return [];
  const shown = (v: unknown) => (blank(v) ? EMPTY : valueText(ctx, f.key, v, f.merged, f.parent) ?? String(v));
  return [{ label: labelOf(f.key, f.parent, ctx.module), before: shown(b), after: shown(a) }];
}

/** 一个能写成文字的字段 */
function valueChange(ctx: Ctx, f: Field, label: string, editable: boolean): Change[] {
  const b = f.before[f.key],
    a = f.after[f.key];
  const bt = valueText(ctx, f.key, b, f.before, f.parent),
    at = valueText(ctx, f.key, a, f.after, f.parent);
  if (bt === at) {
    // 卡片：人能改的字段变了，写法认不出（代码不在词表里）或写出来一样时，照原值列，不略过；
    // 仅解除历史引用（编号置空、快照名称没变，如删厂区后的历史送货单）不算收货厂区内容变化
    if (!editable || (blank(b) && blank(a))) return [];
    if (refTables[f.key]) return blank(a) && snapshotNames[f.key] ? [] : [{ label, before: bt ?? EMPTY, after: at ?? EMPTY }];
    return [{ label, before: bt ?? (blank(b) ? EMPTY : String(b)), after: String(a) }];
  }
  const shownLabelText = f.parent ? nestedLabel(label, f.key, f.parent, historyFieldLabel(f.parent, '', ctx.module) || '') : label;
  return [{ label: shownLabelText, before: bt ?? EMPTY, after: at ?? EMPTY }];
}

/** 确认卡片上人能改的字段：最外层看 top，明细里看 lines */
const editableField = ({ editable }: Ctx, key: string, parent: string) =>
  !!editable && (parent ? lineFields.has(parent) && editable.lines.has(key) : editable.top.has(key));

function fieldChanges(ctx: Ctx, f: Field): Change[] {
  const { key, parent } = f,
    b = f.before[key],
    a = f.after[key],
    snap = snapshotNames[key];
  if (same(b, a) && (!snap || same(f.before[snap], f.after[snap]))) return [];
  const editable = editableField(ctx, key, parent);
  // 明细里只在一边有的字段是确认时补进来的快照（产品名称、单价……），不是改动
  if (lineFields.has(parent) && (b === undefined || a === undefined) && !editable) return [];
  if (lineFields.has(key)) return f.withLines && !parent ? lineChanges(ctx, key, b, a) : [];
  const label = shownLabel(ctx, key, f.merged, parent);
  if (!label) return editable ? hiddenChange(ctx, f, b, a) : [];
  if (isRecord(b) || isRecord(a))
    // 预估成本、到货明细里的纸板（item）：按里面的字段比
    return diff(ctx, isRecord(b) ? b : {}, isRecord(a) ? a : {}, key, f.withLines).map((c) => ({
      ...c,
      label: c.label === '尺寸' ? label + ' 尺寸' : c.label,
    }));
  if ((Array.isArray(b) || Array.isArray(a)) && !refTables[key]) return [];
  return valueChange(ctx, f, label, editable);
}

function diff(ctx: Ctx, before: Row, after: Row, parent: string, withLines: boolean): Change[] {
  const merged = { ...before, ...after };
  return [
    ...(parent ? [] : statusChange(ctx, before, after)),
    ...sizeChange(ctx, before, after, parent),
    ...[...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      fieldChanges(ctx, { key, before, after, merged, parent, withLines }),
    ),
  ];
}

/** 明细：行数一样逐行比（“第 2 行（名称）数量：100 只 → 120 只”），行数变了整体写改之前、改之后 */
function lineChanges(ctx: Ctx, key: string, before: unknown, after: unknown): Change[] {
  const label = historyFieldLabel(key) || '明细';
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length)
    return before.flatMap((b: unknown, i): Change[] => {
      const a: unknown = after[i];
      if (!isRecord(b) || !isRecord(a)) return [];
      return diff(ctx, b, a, key, false).map((c) => ({
        label,
        before: '第 ' + String(i + 1) + ' 行（' + lineName(ctx, a) + '）' + c.label.replace(label + ' ', '') + '：' + c.before,
        after: c.after,
      }));
    });
  const b = linesText(ctx, before, key),
    a = linesText(ctx, after, key);
  return b === a ? [] : [{ label, before: b, after: a }];
}

/**
 * 两份记录比对，只列变了的项：字段中文名、改之前、改之后。
 * withLines=false 时明细不比（确认、撤销这类动作只看状态）。
 */
export function recordChanges(
  module: string,
  before: Row,
  after: Row,
  refs: HistoryRefs = {},
  options: { withLines?: boolean; recordId?: number } = {},
): Change[] {
  return diff({ module, refs, recordId: options.recordId }, before, after, '', options.withLines !== false);
}

/** 嵌套对象（预估成本、纸板）里有中文名、有值的几项 */
function nestedItems(ctx: Ctx, key: string, label: string, value: Row): HistoryItem[] {
  return Object.entries(value).flatMap(([k, v]) => {
    const childLabel = historyFieldLabel(k, key);
    const text = childLabel && !blank(v) ? valueText(ctx, k, v, value, key) : null;
    return childLabel && text ? [{ label: nestedLabel(childLabel, k, key, label), value: text }] : [];
  });
}

/** 一个字段在新建内容里的几行 */
function contentItems(ctx: Ctx, row: Row, key: string, value: unknown): HistoryItem[] {
  const snap = snapshotNames[key];
  if ((blank(value) && !(snap && !blank(row[snap]))) || value === false || (Array.isArray(value) && !value.length)) return [];
  if (lineFields.has(key)) return [{ label: historyFieldLabel(key) || '明细', value: linesText(ctx, value, key) }];
  const label = shownLabel(ctx, key, row, '');
  // 数量已经带着单位写了，单位不再单列（库存品没有数量这一项，单位照列）
  if (!label || (key === 'unit' && ctx.module !== 'stock_items')) return [];
  if (isRecord(value)) return nestedItems(ctx, key, label, value);
  if (Array.isArray(value) && !refTables[key]) return [];
  const text = valueText(ctx, key, value, row, '');
  return text && text !== EMPTY ? [{ label, value: text }] : [];
}

/** 新建的记录列主要内容：有中文名、有值的字段 */
export function contents(ctx: Ctx, row: Row): HistoryItem[] {
  const items: HistoryItem[] = [];
  const status = statusOf(ctx.module, row);
  if (status) items.push({ label: '状态', value: status });
  if ([...sizeFields].some((k) => !blank(row[k]))) items.push({ label: '尺寸', value: rowSize(row) || EMPTY });
  for (const [key, value] of Object.entries(row)) items.push(...contentItems(ctx, row, key, value));
  return items;
}

export const changeItem = (c: Change): HistoryItem => ({ label: c.label, value: c.before + ' → ' + c.after });
/**
 * 确认卡片上“改了什么”：整份逐字段比，editable 里的字段（参数结构里人能改的）变了就一定有一行；
 * 没有中文名的照字段名写出来，不悄悄略过（tests/assistant-card-lines.test.ts 拦着，补叫法）。
 */
export function cardChanges(module: string, before: Row, after: Row, refs: HistoryRefs, editable: Editable): HistoryItem[] {
  return diff({ module, refs, editable }, before, after, '', true).map(changeItem);
}
/** 新建：列出主要内容（和修改历史的新建同一个写法） */
export function cardContents(module: string, row: Row, refs: HistoryRefs): HistoryItem[] {
  return contents({ module, refs }, row);
}
