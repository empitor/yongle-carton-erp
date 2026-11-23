import { codeNames, purchaseStatusLabel } from '../../shared/business/index';
import { FINISHED_UNIT, RAW_UNIT, fieldTable, orderTaxModes, statuses, type FieldTable, isFlowKind } from '../../shared/core/index';
import { flowStates, pendingLabels, storedFlowStatusName } from '../../shared/business/index';
import { purchaseBusinessStatuses } from '../../shared/business/index';
import type { RecordRefs, RefOption } from './record-refs';
import type { JsonObject, ManagedRecord } from './record-types';
// 数据管理编辑窗里每个字段怎么填：哪些不显示、下拉有哪些选项、关联字段列哪些候选、为什么锁住、用什么输入框。
/**
 * 编辑窗的上下文：在改哪一类记录、改的是哪一条（列表给的 record，带只读的 usage、订货单号这类）、关联字段的候选，
 * 以及没法提交的那几格（按字段路径“上一层.字段”，如 costs.material；原因写在那一格下面并标红）
 */
export type FieldContext = {
  module: string;
  record: ManagedRecord | null;
  refs: RecordRefs | null;
  errors?: Record<string, string>;
};
export const numberFields = new Set(['length', 'width', 'height']);
/** 不给人看的键：明细自己的编号、版本、请求编号（数据还在，保存时原样带回） */
export const hiddenFields = new Set(['id', 'version', 'requestId']);
/**
 * 金额只按“元”填：产品参考单价、订单明细单价各有一个“分”和一个“元”，编辑窗只显示“元”，保存时由“元”算出“分”
 * （DataManagementEditor 的 submittedInput）。预估成本的几项库里是分，编辑窗里也按元填。
 */
export const centsTwins = new Set(['priceCents', 'unitPriceCents']);
export const yuanFields = new Set(['priceExact', 'unitPriceExact']);
export const timeFields = new Set(['plannedTime', 'actualTime']);
type RefKind = keyof RecordRefs | 'source' | 'batch';
/** 指向的表 → 编辑窗用哪一类候选（哪个栏目指向哪张表只在栏目登记表 shared/core/field-names.ts 登记） */
const refKindOfTable: Record<FieldTable, RefKind> = {
  customers: 'customers',
  suppliers: 'suppliers',
  products: 'products',
  stock_items: 'stock_items',
  orders: 'orders',
  order_lines: 'orderLines',
  purchase_lines: 'purchaseLines',
  flow_documents: 'task',
  flow_sources: 'source',
  order_batches: 'batch',
};
/** 更正的原单只由更正写，编辑窗不出选择器 */
const notPicked = new Set(['correctionOf']);
/** 关联字段：显示名称或单号的可搜索选择器，不让人填编号；不是关联字段的是 undefined */
export function refKind(key: string): RefKind | undefined {
  const table = notPicked.has(key) ? undefined : fieldTable(key);
  return table && refKindOfTable[table];
}
/** 可以不关联的（选项里有“不关联”）；其余的必须选一个 */
function optionalRef(module: string, key: string) {
  if (key === 'stockId') return module === 'arrival';
  if (key === 'customerId') return module === 'products';
  return [
    'customerOrderId',
    'parentProductId',
    'stockItemId',
    'purchaseLineId',
    'finishedStockId',
    'taskId',
    'sourceId',
  ].includes(key);
}
/** 库存品按用途筛：到货、领料、采购的是原材料，送货、入库的是成品 */
function stockFilter(module: string, key: string): string | null {
  if (key === 'finishedStockId' || module === 'delivery') return 'finished';
  if (module === 'arrival' || module === 'production' || module === 'purchases') return 'raw';
  return null;
}

// 订单状态直接用共用的清单，免得两处再分叉
const orderStatuses: string[] = [...statuses],
  purchaseStatuses: string[] = [...purchaseBusinessStatuses],
  flowStatuses = Object.keys(flowStates);
/** 单据“待核对”的叫法按单据种类查（生产任务没有）；按模块名查，不是单据的查不到 */
const pendingNames: Partial<Record<string, string>> = pendingLabels;
/** 含税口径：值就是叫法 */
const taxModeNames: Record<string, string> = Object.fromEntries(orderTaxModes.map((m) => [m, m]));
/** 存代码的字段下拉里显示的字：和修改历史同一张（shared/business/history-fields.ts 的 codeNames），另加含税口径 */
const choiceNames = (key: string): Readonly<Record<string, string>> | undefined =>
  key === 'taxMode' ? taxModeNames : Object.hasOwn(codeNames, key) ? codeNames[key] : undefined;

/** 状态下拉：订单原样，采购单用 purchaseStatusLabel，单据按单据种类叫（和页面上同一套词） */
function statusChoices(module: string): { values: string[]; label: (v: string) => string } {
  if (isFlowKind(module))
    return {
      // 生产任务没有待核对（安排即下达，建表也拦）
      values: flowStatuses.filter((s) => s !== 'draft' || pendingNames[module]),
      label: (v) => storedFlowStatusName(module, v),
    };
  if (module === 'orders') return { values: orderStatuses, label: (v) => v };
  const values =
    module === 'purchases' ? purchaseStatuses : [...orderStatuses, ...purchaseStatuses.filter((s) => !orderStatuses.includes(s))];
  return { values, label: (v) => (purchaseStatuses.includes(v) ? purchaseStatusLabel(v) : v) };
}

/**
 * 数据管理下拉的选项：[存的值, 显示的字]。值保持原来的代码，显示一律中文。
 * 当前值不在清单里也列出来（含税口径这类库里已有的别的写法也照原样列出），免得一打开就被悄悄改掉；
 * 保存时由录入校验拦下、要人改选。没有下拉的字段返回 null。
 */
export function fieldChoices(key: string, current: unknown, module = ''): [string, string][] | null {
  const names = choiceNames(key);
  const { values, label } =
    key === 'status'
      ? statusChoices(module)
      : names
        ? { values: Object.keys(names), label: (v: string) => names[v] || '原来写的“' + v + '”（请改选）' }
        : { values: null, label: null };
  if (!values || !label) return null;
  const now = current == null ? '' : String(current);
  const list = now && !values.includes(now) ? [...values, now] : values;
  return list.map((v) => [v, label(v)]);
}

/**
 * 下拉里列不列“未填写”：金额结算一旦选过就不列——它是人明确确认的结算规则，清回“没选”没有业务含义，
 * 订单的录入规则也不收空值（空着交就照原值存，等于悄悄丢掉这次改动）；库里本来就空的照实显示“未填写”。
 */
const keptOnceChosen = new Set(['roundingPolicy']);
export const allowsBlank = (key: string, current: unknown) => current == null || !keptOnceChosen.has(key);

/** 这个字段那一类的候选（读来的那份，不改它）：订单明细按同一行选的订单列，库存品按用途筛 */
function candidates(key: string, ctx: FieldContext, line: JsonObject | null): readonly RefOption[] {
  const kind = refKind(key),
    refs: RecordRefs = ctx.refs ?? {};
  if (kind === 'orderLines') return refs.orderLines?.[String(line?.orderId ?? '')] || [];
  if (kind === 'stock_items') {
    const wanted = stockFilter(ctx.module, key);
    return (refs.stock_items || []).filter((s) => !wanted || s.kind === wanted);
  }
  if (!kind || kind === 'source' || kind === 'batch') return [];
  return refs[kind] || [];
}

/**
 * 关联字段的候选：按字段找到那一类，库存品按用途筛，更正的原单、附属的产品不列自己。
 * 当前值在候选里找不到（记录已经删掉）时补一项“原来关联的记录（已找不到）”，不显示编号，也不悄悄改掉；
 * 补在这一格的选项上，不改读来的候选（同一类的别的格子不跟着多一项）。
 * line 是这一项明细（订单明细要按同一行选的订单列）。
 */
export function refOptions(key: string, current: unknown, ctx: FieldContext, line: JsonObject | null = null): RefOption[] {
  const self = ctx.record?.id == null ? null : String(ctx.record.id),
    list = candidates(key, ctx, line).filter(
      (o) => !(key === 'parentProductId' && ctx.module === 'products' && o.value === self),
    );
  const now = current == null ? '' : String(current);
  const options = optionalRef(ctx.module, key) ? [{ value: '', label: '不关联' }, ...list] : list;
  // 候选还在读的时候不补“找不到”，免得一闪
  if (now && ctx.refs && !options.some((o) => o.value === now))
    options.push({ value: now, label: '原来关联的记录（已找不到）' });
  return options;
}

/** 用可搜索选择器的关联字段（订货单只读、送货单原件是下拉，不算） */
export const wideRef = (key: string) => refKind(key) !== 'batch' && refKind(key) !== 'source';

function stockLockedReason(key: string, value: JsonObject, record: ManagedRecord | null): string | null {
  const used = record?.usage === 'moved' ? '已有出入库记录' : record?.usage ? '已被单据或采购明细引用' : '';
  // 服务端：用过的库存品不能改种类、不能改成品关联的产品（server/operations/service.ts 的 saveItem）
  if (key === 'kind' && used) return used + '，不能改种类';
  if (key === 'productId' && used && record?.productId != null) return used + '，不能改关联的产品';
  if (value.kind === 'finished' && productBoundStockFields.has(key)) return '按关联的产品';
  return null;
}

/** 为什么这一项改不了：返回原因（显示在输入框下面），能改返回 null。value 是这一格所在的那层内容 */
export function lockedReason(key: string, value: JsonObject, path: string, ctx: FieldContext): string | null {
  if (path) return null;
  if (ctx.module === 'products' && key === 'customerId' && ctx.record?.ordered && ctx.record?.customerId != null)
    return '这个产品已经下过单，不能更改所属客户；要给别的客户用请复制一份';
  if (ctx.module === 'stock_items') return stockLockedReason(key, value, ctx.record);
  return null;
}
export const longText = ['notes', 'requirements', 'terms', 'specification', 'productName'];
/** 成品库存的这几项一律取关联的产品（服务端保存时按产品填），这里只显示不让改 */
export const productBoundStockFields = new Set([
  'name',
  'length',
  'width',
  'height',
  'dimensionUnit',
  'material',
  'flute',
  'specification',
]);
/** 数量单位是定死的：原材料（纸板）只有“张”，产品、成品只有“只”，别的单位服务端拒收；只显示，跟着种类走 */
export function unitNote(module: string, path: string) {
  if (module === 'stock_items' && !path)
    return '按种类：原材料“' + RAW_UNIT + '”，成品“' + FINISHED_UNIT + '”';
  return module === 'purchases' || module === 'arrival'
    ? '纸板只有“' + RAW_UNIT + '”'
    : '产品只有“' + FINISHED_UNIT + '”';
}

/** 选择器的占位文字：按这一类能搜到的写（搜索也查名称后面的小字），产品没有单号就不写单号 */
export const refPlaceholders: Partial<Record<keyof RecordRefs, string>> = {
  customers: '输入客户名称、联系人或电话搜索',
  suppliers: '输入供应商名称、联系人或电话搜索',
  products: '输入产品名称、尺寸或料号搜索',
  stock_items: '输入库存品名称或规格搜索',
  orders: '输入订单号或客户搜索',
  task: '输入任务单号或产品搜索',
  purchaseLines: '输入采购单号或纸板名称搜索',
  orderLines: '输入产品名称搜索',
};
