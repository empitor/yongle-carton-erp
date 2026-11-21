import { dateSchema, FINISHED_UNIT, finishedUnit, inspectCurrency, lineSchema, MAX_CM_DIMENSION, MAX_PRICE_UNITS, MAX_PRICE_YUAN, normalizeDimensionUnit, orderTaxModes, parseDimension, PRICE_DECIMALS } from '../core/index.js';
import { fieldLabels, headerFields, lineFields } from './order-draft.js';
import type { DraftEvaluation, DraftField, DraftIssue, HeaderField, LineField, OrderDraft } from './order-draft.js';

/* 识别结果的核对：缺什么、哪里对不上、金额和合计按原文精确算（不用浮点）。 */
type Decimal = { value: bigint; scale: number };
function decimal(v: string): Decimal | null {
  v = v.trim();
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/.test(v)) return null;
  const [a, b = ''] = v.split('.');
  return { value: BigInt(a + b), scale: b.length };
}
function format(d: Decimal): string {
  const s = d.value.toString().padStart(d.scale + 1, '0');
  return d.scale ? s.slice(0, -d.scale) + '.' + s.slice(-d.scale) : s;
}
function sum(values: Decimal[]): Decimal {
  const scale = Math.max(0, ...values.map((v) => v.scale));
  return {
    scale,
    value: values.reduce((s, v) => s + v.value * 10n ** BigInt(scale - v.scale), 0n),
  };
}
function equal(a: Decimal, b: Decimal) {
  return sum([a]).value * 10n ** BigInt(b.scale) === b.value * 10n ** BigInt(a.scale);
}
/** 本公司名称：采购方识别成它，多半是把采购方和供应方看反了 */
const OWN_COMPANY = '宁波甬勒包装制品有限公司';
/** 原件本来就没写的选填项不算疑点 */
const optionalHeaderFields: readonly HeaderField[] = ['notes', 'terms', 'statedTotalQuantity', 'statedTotalAmount'];
const optionalLineFields: readonly LineField[] = [
  'length',
  'width',
  'height',
  'dimensionUnit',
  'material',
  'flute',
  'productCode',
  'requirements',
  'notes',
  'statedAmount',
  'taxRate',
  'taxMode',
  'deliveryDate',
];
/** 币种单独核对（按人民币保存的提示），不进“待确认”这一轮 */
const reviewedHeaderFields = headerFields.filter((k) => k !== 'currency');
/** 数量或单价改过以后，行金额和两个合计都按新值算：每一处都用这一句，合成一条给人看 */
const recalculatedNotice = '数量或单价改过，正式金额和合计按新值重算；原文金额、合计保留供对照，请核对。';
const calculatedEdit = (f: DraftField) => f.certainty === 'user-modified' && !!f.recalculated;
type Issue = (path: string, message: string, severity?: DraftIssue['severity']) => void;
type DraftLine = OrderDraft['lines'][number];

/** 标了待核对的栏目：有字的都要确认，空着的只有必填项要确认 */
function pendingReviews<K extends HeaderField | LineField>(
  fields: readonly K[],
  values: Record<K, DraftField>,
  optional: readonly K[],
  prefix: string,
  issue: Issue,
) {
  for (const k of fields) {
    const f = values[k];
    if (f.certainty === 'needs-review' && (!!f.value || !optional.includes(k)))
      issue(prefix + k, fieldLabels[k] + '待确认：' + (f.note || '请对照原件'));
  }
}
function headerDateIssues(h: OrderDraft['header'], issue: Issue) {
  for (const k of ['orderDate', 'deliveryDate'] as const)
    if (h[k].value && !dateSchema.safeParse(h[k].value).success)
      issue('header.' + k, '日期必须是明确有效的 YYYY-MM-DD。', 'error');
  if (h.orderDate.value && h.deliveryDate.value && h.deliveryDate.value < h.orderDate.value)
    issue('header.deliveryDate', '交货日期早于下单日期。', 'error');
}
function headerIssues(h: OrderDraft['header'], issue: Issue) {
  pendingReviews(reviewedHeaderFields, h, optionalHeaderFields, 'header.', issue);
  for (const k of ['buyerName', 'orderDate', 'deliveryDate'] as const)
    if (!h[k].value) issue('header.' + k, fieldLabels[k] + '缺失');
  if ((h.buyerName.value || '').replace(/\s/g, '').includes(OWN_COMPANY))
    issue('header.buyerName', '采购方被识别为本公司，请核对采购方与供应方。', 'error');
  headerDateIssues(h, issue);
  const currency = inspectCurrency(h.currency.value);
  if (currency.message) issue('header.currency', currency.message, currency.currency ? 'review' : 'error');
  else if (h.currency.certainty === 'needs-review')
    issue('header.currency', '币种按人民币（CNY）保存，请对照原件核对。');
  if (!h.taxMode.value) issue('header.taxMode', '原件未明确含税口径，不能自行推断。');
  taxModeIssue(h.taxMode.value, 'header.taxMode', issue);
}
/** 含税口径只收含税、未税、未明确：原件写的别的说法（如“不含税”）不猜着归并，要人在识别结果里改选 */
function taxModeIssue(value: string | null, path: string, issue: Issue) {
  const v = value?.trim();
  if (v && !orderTaxModes.some((m) => m === v))
    issue(path, fieldLabels.taxMode + '原件写的是“' + v + '”，请改选' + orderTaxModes.join('、') + '之一。', 'error');
}
function quantityIssues(q: Decimal | null, prefix: string, issue: Issue) {
  if (!q || q.value === 0n) issue(prefix + 'quantity', '数量缺失或不是有效正数。', 'error');
  else if (q.scale > 0 || !lineSchema.shape.quantity.safeParse(Number(q.value)).success)
    issue(prefix + 'quantity', '当前 ERP 只支持不超过 1000000 的整数数量。');
}
function priceIssues(p: Decimal | null, prefix: string, issue: Issue) {
  if (!p) issue(prefix + 'unitPrice', '单价缺失或格式无效。', 'error');
  else if (p.scale > PRICE_DECIMALS)
    issue(prefix + 'unitPrice', '原始单价超过四位小数，当前正式订单仍需人工处理；未四舍五入。');
  // 上限按精确单价比（万分之一元），和保存时 shared/core/precision.ts 的 priceUnits 同一个数；按截到分比会漏过 1000000.0001
  else if (p.value * 10n ** BigInt(PRICE_DECIMALS - p.scale) > MAX_PRICE_UNITS)
    issue(prefix + 'unitPrice', '原文单价超过 ' + MAX_PRICE_YUAN + ' 元的上限，识别出的原值已保留。');
}
/** 一个尺寸写得合不合格：不是有效正数、超出范围、厘米超过上限都不合格 */
function dimensionAllowed(value: string, unit: string | null) {
  try {
    const n = parseDimension(value);
    return !(normalizeDimensionUnit(unit) === 'cm' && n !== null && n > MAX_CM_DIMENSION);
  } catch {
    // parseDimension 认不出数、超出范围时抛错，这里只要“不合格”这个结论，原因由下面统一说
    return false;
  }
}
function dimensionIssues(line: DraftLine, issue: Issue) {
  const f = line.fields;
  for (const k of ['length', 'width', 'height'] as const) {
    const value = f[k].value;
    if (!value || dimensionAllowed(value, f.dimensionUnit.value)) continue;
    issue(
      'products.' + (f.productName.value || line.id) + '.' + k,
      '产品“' + (f.productName.value || '未命名') + '”' + fieldLabels[k] + '必须为有效正数且不超过10000mm或1000cm；未知时可留空。',
      'error',
    );
  }
}
function statedAmountIssues(f: DraftLine['fields'], computed: Decimal | null, prefix: string, issue: Issue) {
  const stated = decimal(f.statedAmount.value || '');
  if (f.statedAmount.value?.trim() && !stated)
    issue(prefix + 'statedAmount', '原文行金额不是有效数值，请核对后修正，不能忽略。', 'error');
  if (!stated || !computed || equal(stated, computed)) return;
  const recalculated =
    (calculatedEdit(f.quantity) || calculatedEdit(f.unitPrice)) && f.statedAmount.certainty !== 'user-modified';
  issue(
    prefix + 'statedAmount',
    recalculated ? recalculatedNotice : '原文行金额与数量 × 单价不一致，请核对折扣、税费或识别错误。',
    recalculated ? 'review' : 'error',
  );
}
/** 一行明细的疑点；交回有效数量和算出来的行金额，供合计用 */
function lineIssues(line: DraftLine, issue: Issue) {
  const prefix = 'lines.' + line.id + '.',
    f = line.fields;
  pendingReviews(lineFields, f, optionalLineFields, prefix, issue);
  const q = decimal(f.quantity.value || ''),
    p = decimal(f.unitPrice.value || '');
  quantityIssues(q, prefix, issue);
  priceIssues(p, prefix, issue);
  dimensionIssues(line, issue);
  if (!f.productName.value) issue(prefix + 'productName', '产品名称缺失。', 'error');
  // 产品数量单位只有“只”：原文写“个”、没写都按“只”；别的单位（箱、套……）要人先换算，不自动换算
  const unit = finishedUnit(f.unit.value);
  if (unit !== FINISHED_UNIT)
    issue(prefix + 'unit', '原文数量单位是“' + unit + '”，系统里产品只按“只”算，请把数量换算成只、单位改成只。', 'error');
  if (!f.specification.value) issue(prefix + 'specification', '产品规格未识别。');
  taxModeIssue(f.taxMode.value, prefix + 'taxMode', issue);
  const amount = q && p ? { value: q.value * p.value, scale: q.scale + p.scale } : null;
  statedAmountIssues(f, amount, prefix, issue);
  return { quantity: q && q.value !== 0n ? q : null, amount };
}
type TotalField = 'statedTotalQuantity' | 'statedTotalAmount';
function totalIssues(draft: OrderDraft, k: TotalField, computed: Decimal | null, issue: Issue) {
  const field = draft.header[k],
    stated = decimal(field.value || '');
  if (field.value?.trim() && !stated) issue('header.' + k, fieldLabels[k] + '不是有效数值，请核对后修正。', 'error');
  if (!stated || !computed || equal(stated, computed)) return;
  const recalculated =
    field.certainty !== 'user-modified' &&
    draft.lines.some(
      (l) =>
        calculatedEdit(l.fields.quantity) || (k === 'statedTotalAmount' && calculatedEdit(l.fields.unitPrice)),
    );
  issue(
    'header.' + k,
    recalculated ? recalculatedNotice : fieldLabels[k] + '与后端计算值不一致，不能把数量合计当作金额。',
    recalculated ? 'review' : 'error',
  );
}
const uniqueIssues = (issues: DraftIssue[]) =>
  issues.filter(
    (v, i, a) => a.findIndex((x) => x.path === v.path && x.message === v.message && x.severity === v.severity) === i,
  );
export function evaluateDraft(draft: OrderDraft): DraftEvaluation {
  const issues: DraftIssue[] = [],
    amounts: Decimal[] = [],
    quantities: Decimal[] = [],
    lineAmounts: Record<string, string | null> = {};
  const issue: Issue = (path, message, severity = 'review') => issues.push({ path, message, severity });
  headerIssues(draft.header, issue);
  for (const line of draft.lines) {
    const { quantity, amount } = lineIssues(line, issue);
    if (quantity) quantities.push(quantity);
    lineAmounts[line.id] = amount ? format(amount) : null;
    if (amount) amounts.push(amount);
  }
  const totalQ = quantities.length === draft.lines.length ? sum(quantities) : null,
    totalA = amounts.length === draft.lines.length ? sum(amounts) : null;
  totalIssues(draft, 'statedTotalQuantity', totalQ, issue);
  totalIssues(draft, 'statedTotalAmount', totalA, issue);
  return {
    issues: uniqueIssues(issues),
    lineAmounts,
    totalQuantity: totalQ ? format(totalQ) : null,
    totalAmount: totalA ? format(totalA) : null,
  };
}
