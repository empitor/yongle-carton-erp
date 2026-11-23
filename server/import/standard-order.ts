import { sales } from '../sales/index.js';
import type { z } from 'zod';
import type { Store } from '../core/index.js';
import { FINISHED_UNIT, finishedUnit, percentFromTaxRateBp, readTaxRate, type Product, type ProductInput } from '../../shared/core/index.js';
import { customerSchema, orderSchema, plannedOrderSchema, productSchema } from '../../shared/core/index.js';
import { legacyCents, MAX_PRICE_YUAN, PRICE_DECIMALS } from '../../shared/core/index.js';
import { evaluateDraft, fieldLabels, type ImportMapping, type ImportWorkspaceView, type OrderDraft } from '../../shared/import/index.js';
import { inspectCurrency } from '../../shared/core/index.js';
import { fieldName, productNotices, uniqueMessages, userError } from '../../shared/core/index.js';
import { productFieldsFromDraft } from './product-input.js';

type DraftLine = OrderDraft['lines'][number];
type Mapping = ImportMapping | undefined;
/** 订单校验出错时栏目的中文名：订单的栏目按栏目登记表，识别表才有的栏按识别表的叫法 */
const importLabels = new Map<string, string>(Object.entries(fieldLabels));
const labelOf = (field: string) => fieldName(field) ?? importLabels.get(field) ?? field;
const value = (v: string | null) => v?.trim() || '';

function taxFromDraft(field: DraftLine['fields']['taxRate']) {
  const bp = readTaxRate(field.value);
  return {
    taxRate: bp === null ? null : percentFromTaxRateBp(bp),
    taxText: field.originalValue === undefined ? field.value : field.originalValue,
  };
}

/** 投影过程中攒的：问题、要新建的产品、这单涉及的产品（提示用） */
type Collected = {
  issues: string[];
  newProducts: { lineId: string; input: ProductInput }[];
  optionalProducts: (Product | ProductInput)[];
};

/** 单价换成分；没填、不是数、超过四位小数（不自动四舍五入）、超过上限分开说 */
function priceCentsOf(f: DraftLine['fields'], issues: string[]) {
  const price = value(f.unitPrice.value),
    priceShape = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(price),
    priceName = f.productName.value || '';
  if (!price) issues.push('产品单价缺失：' + priceName);
  else if (!priceShape) issues.push('产品单价不是有效的非负数：' + priceName);
  else if ((priceShape[2] || '').length > PRICE_DECIMALS) issues.push('产品单价超过四位小数（不自动四舍五入）：' + priceName);
  else
    try {
      return legacyCents(price);
    } catch {
      // 写法已经对了，剩下的只有超过上限
      issues.push('产品单价超过 ' + MAX_PRICE_YUAN + ' 元的上限：' + priceName);
    }
  return 0;
}

/** 要新建的产品：资料按识别结果填（已有客户直接填所属客户，新客户在导入事务建客户后写入），过不了校验的把原因列出来 */
function planNewProduct(l: DraftLine, priceCents: number, customerId: number | null, out: Collected) {
  const f = l.fields;
  try {
    const product = productSchema.safeParse({
      ...productFieldsFromDraft(f),
      priceCents,
      priceExact: value(f.unitPrice.value),
      customerProductCode: f.productCode.value || '',
      customerId,
    });
    if (product.success) {
      out.newProducts.push({ lineId: l.id, input: product.data });
      out.optionalProducts.push(product.data);
    } else
      out.issues.push(
        ...product.error.issues.map(
          // 栏目名和全站一样按 userError 说中文（不露英文字段名）
          (i) => '产品“' + (f.productName.value || '未命名') + '”' + userError(i.path.join('.') + ': ' + i.message),
        ),
      );
  } catch (error) {
    out.issues.push(
      '产品“' + (f.productName.value || '未命名') + '”尺寸无效：' + (error instanceof Error ? error.message : '请修正数值'),
    );
  }
}

/** 已有产品检查：确认存在且不属别家客户 */
function checkExistingProduct(
  store: Store,
  productId: number,
  customer: { id: number | null; name: string },
  out: Collected,
) {
  const existing = sales(store).product(productId);
  if (!existing) {
    out.issues.push('关联产品不存在');
    return;
  }
  if (existing.customerId != null && existing.customerId !== customer.id) {
    const owner = existing.customerName || sales(store).customer(existing.customerId, true)?.name || '其他客户';
    out.issues.push(`这个产品是 ${owner} 的，要给 ${customer.name || '当前客户'} 用请复制一份`);
  }
  out.optionalProducts.push(existing);
}

/** 一行明细投影成订单明细：单价、单位、产品（已有的核对还在且不属别家客户，新建的列计划） */
function projectLine(
  store: Store,
  d: OrderDraft,
  l: DraftLine,
  ctx: { m: Mapping; customer: { id: number | null; name: string }; out: Collected },
) {
  const { m, customer, out } = ctx;
  const f = l.fields,
    choice = m?.products[l.id];
  const priceCents = priceCentsOf(f, out.issues);
  const productId = choice?.mode === 'existing' ? choice.id : null;
  // 产品数量单位只有“只”：“个”、没写都按“只”；别的单位要人先换算
  if (finishedUnit(value(f.unit.value)) !== FINISHED_UNIT)
    out.issues.push('第' + (d.lines.indexOf(l) + 1) + '项数量单位是“' + value(f.unit.value) + '”，产品只按“只”算，请换算成只后再导入。');
  if (productId) checkExistingProduct(store, productId, customer, out);
  if (choice?.mode === 'new') planNewProduct(l, priceCents, customer.id, out);
  else if (!productId) out.issues.push('产品尚未选择：' + (f.productName.value || '未命名'));
  return {
    lineId: l.id,
    productId,
    productName: value(f.productName.value),
    specification: value(f.specification.value),
    notes: value(f.notes.value),
    quantity: /^\d+(?:\.0+)?$/.test(value(f.quantity.value)) ? Number(f.quantity.value) : NaN,
    unitPriceCents: priceCents,
    unitPriceExact: value(f.unitPrice.value),
    customerProductCode: value(f.productCode.value),
    unit: finishedUnit(value(f.unit.value)),
    ...taxFromDraft(f.taxRate),
    taxMode: value(f.taxMode.value),
    deliveryDate: value(f.deliveryDate.value) || undefined,
  };
}

/** 订单校验没过的和识别结果核对出的错误：按位置去重，各说一句 */
function orderProblems(
  orderIssues: z.ZodError['issues'],
  currencyMessage: ReturnType<typeof inspectCurrency>['message'],
  d: OrderDraft,
) {
  const problems = new Map<string, string>();
  for (const i of orderIssues) {
    const path = i.path.join('.');
    const field = String(i.path.at(-1) || 'order');
    const label = labelOf(field);
    const prefix = i.path[0] === 'lines' ? '第' + (Number(i.path[1]) + 1) + '项' : '';
    if (!problems.has(path))
      problems.set(path, prefix + label + '：' + (field === 'currency' ? currencyMessage : i.message));
  }
  for (const i of evaluateDraft(d).issues.filter((i) => i.severity === 'error')) {
    const path = i.path
      .replace(/^header\./, '')
      .replace(/^lines\.([^.]+)\./, (_, id) => 'lines.' + d.lines.findIndex((l) => l.id === id) + '.');
    if (!problems.has(path)) problems.set(path, i.message);
  }
  return [...problems.values()];
}

/** 整单的栏目：识别结果原样投影，币种按认出来的写 */
function headerFields(d: OrderDraft, m: Mapping, customerId: number | null, currency: ReturnType<typeof inspectCurrency>) {
  return {
    customerId,
    orderDate: value(d.header.orderDate.value),
    deliveryDate: value(d.header.deliveryDate.value),
    status: '已确认',
    notes: value(d.header.notes.value),
    costs: null,
    externalPurchaseOrder: value(d.header.purchaseOrderNumber.value),
    supplierName: value(d.header.supplierName.value),
    currency: currency.currency ?? d.header.currency.value,
    ...taxFromDraft(d.header.taxRate),
    taxMode: value(d.header.taxMode.value),
    terms: value(d.header.terms.value),
    roundingPolicy: m?.roundingPolicy || 'exact-cents',
  };
}

/** 识别结果投影成正式订单（识别结果页的“标准订单”、导入计划都用它）；还没识别的没有 */
export function standardOrderDraft(store: Store, w: ImportWorkspaceView) {
  return w.draft ? projectOrder(store, w.draft, w.mapping) : null;
}

/** 投影客户：已有的确认存在，新建的按客户结构校验 */
function projectCustomer(store: Store, d: OrderDraft, m: Mapping, out: Collected) {
  const id = m?.customer.mode === 'existing' ? m.customer.id : null;
  const existing = id ? sales(store).customer(id) : undefined;
  if (id && !existing) out.issues.push('关联客户不存在');
  const created =
    m?.customer.mode === 'new'
      ? customerSchema.safeParse({ name: d.header.buyerName.value, contact: '', phone: '', address: '', notes: '' })
      : null;
  if (!id && !created?.success) out.issues.push('客户尚未选择或新客户名称不完整');
  const name = existing?.name || (created?.success ? created.data.name : value(d.header.buyerName.value));
  return { id, name, newCustomerPlan: created?.success ? created.data : null };
}

// 将带来源的识别字段确定性投影为正式业务同名字段。没有内部ID时保留null及新增计划，不编造ID。
export function projectOrder(store: Store, d: OrderDraft, m: Mapping) {
  const out: Collected = { issues: [], newProducts: [], optionalProducts: [] };
  const currency = inspectCurrency(d.header.currency.value);
  const customer = projectCustomer(store, d, m, out);
  const lines = d.lines.map((l) => projectLine(store, d, l, { m, customer, out }));
  const fields = { ...headerFields(d, m, customer.id, currency), lines };
  // 按待建订单结构（允许新客户/新产品编号留空）完成整单校验，不编造占位编号。
  const parsed = plannedOrderSchema.safeParse(fields);
  out.issues.push(...orderProblems(parsed.success ? [] : parsed.error.issues, currency.message, d));
  return {
    fields,
    newCustomerPlan: customer.newCustomerPlan,
    newProductPlans: out.newProducts,
    issues: uniqueMessages(out.issues),
    notices: uniqueMessages([
      ...productNotices(out.optionalProducts),
      ...(currency.defaulted && currency.message ? [currency.message] : []),
    ]),
    validatedInput: parsed.success && customer.id && lines.every((l) => l.productId) ? orderSchema.parse(fields) : null,
    writesEnabled: false as const,
  };
}
