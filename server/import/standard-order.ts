import type { Store } from '../db.js';
import { customerSchema, productSchema, orderSchema } from '../../shared/domain.js';
import { legacyCents } from '../../shared/precision.js';
import { evaluateDraft, fieldLabels, type ImportWorkspaceView } from '../../shared/order-draft.js';
import { inspectCurrency } from '../../shared/currency.js';
import { productNotices, uniqueMessages } from '../../shared/product-details.js';
import { productFieldsFromDraft } from './product-input.js';
// 将带来源的识别字段确定性投影为正式业务同名字段。没有内部ID时保留null及新增计划，不编造ID。
export function standardOrderDraft(store: Store, w: ImportWorkspaceView) {
  const d = w.draft;
  if (!d) return null;
  const m = w.mapping,
    issues: string[] = [];
  const value = (v: string | null) => v?.trim() || '';
  const currency = inspectCurrency(d.header.currency.value);
  const customerId = m?.customer.mode === 'existing' ? m.customer.id : null;
  if (customerId && !store.customer(customerId)) issues.push('关联客户不存在');
  const newCustomer =
    m?.customer.mode === 'new'
      ? customerSchema.safeParse({
          name: d.header.buyerName.value,
          contact: '',
          phone: '',
          address: '',
          notes: '',
        })
      : null;
  if (!customerId && !newCustomer?.success) issues.push('客户尚未选择或新客户名称不完整');
  const newProducts: any[] = [];
  const optionalProducts: any[] = [];
  const lines = d.lines.map((l) => {
    const f = l.fields,
      choice = m?.products[l.id];
    let priceCents = 0;
    try {
      priceCents = legacyCents(value(f.unitPrice.value));
    } catch {
      issues.push('产品单价缺失或超过四位精度：' + (f.productName.value || ''));
    }
    const productId = choice?.mode === 'existing' ? choice.id : null;
    if (!value(f.unit.value))
      issues.push('第' + (d.lines.indexOf(l) + 1) + '项数量单位缺失，请核对原文；系统不自动换算。');
    if (productId && !store.product(productId)) issues.push('关联产品不存在');
    if (choice?.mode === 'new') {
      try {
        const product = productSchema.safeParse({
          ...productFieldsFromDraft(f),
          priceCents,
          priceExact: value(f.unitPrice.value),
          customerProductCode: f.productCode.value || '',
        });
        if (product.success) {
          newProducts.push({ lineId: l.id, input: product.data });
          optionalProducts.push(product.data);
        } else
          issues.push(
            ...product.error.issues.map(
              (i) =>
                '产品“' +
                (f.productName.value || '未命名') +
                '”' +
                i.path.join('.') +
                '：' +
                i.message,
            ),
          );
      } catch (error) {
        issues.push(
          '产品“' +
            (f.productName.value || '未命名') +
            '”尺寸无效：' +
            (error instanceof Error ? error.message : '请修正数值'),
        );
      }
    } else if (!productId) issues.push('产品尚未选择：' + (f.productName.value || '未命名'));
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
      unit: value(f.unit.value),
      taxRate: value(f.taxRate.value),
      taxMode: value(f.taxMode.value),
      deliveryDate: value(f.deliveryDate.value) || undefined,
    };
  });
  const fields = {
    customerId,
    orderDate: value(d.header.orderDate.value),
    deliveryDate: value(d.header.deliveryDate.value),
    status: '已确认',
    notes: value(d.header.notes.value),
    costs: null,
    externalPurchaseOrder: value(d.header.purchaseOrderNumber.value),
    supplierName: value(d.header.supplierName.value),
    currency: currency.currency ?? d.header.currency.value,
    taxRate: value(d.header.taxRate.value),
    taxMode: value(d.header.taxMode.value) || '未明确',
    terms: value(d.header.terms.value),
    roundingPolicy: m?.roundingPolicy || 'exact-cents',
    lines,
  };
  let validatedInput = null;
  // 无内部ID时仅用临时正ID验证结构；不会保存或返回这些占位ID为正式关联。
  // 新建档案也必须在预览前完成整张订单校验，不能等执行时逐个暴露字段错误。
  const parsed = orderSchema.safeParse({
    ...fields,
    customerId: customerId || 1,
    lines: lines.map((l) => ({ ...l, productId: l.productId || 1 })),
  });
  const problems = new Map<string, string>();
  if (!parsed.success)
    for (const i of parsed.error.issues) {
      const path = i.path.join('.');
      const field = String(i.path.at(-1) || 'order');
      const label =
        (
          {
            unitPriceExact: '单价',
            externalPurchaseOrder: '客户采购订单号',
            roundingPolicy: '结算规则',
            status: '订单状态',
          } as Record<string, string>
        )[field] ||
        (fieldLabels as Record<string, string>)[field] ||
        field;
      const prefix = i.path[0] === 'lines' ? '第' + (Number(i.path[1]) + 1) + '项' : '';
      if (!problems.has(path))
        problems.set(
          path,
          prefix + label + '：' + (field === 'currency' ? currency.message : i.message),
        );
    }
  for (const i of evaluateDraft(d).issues.filter((i) => i.severity === 'error')) {
    const path = i.path
      .replace(/^header\./, '')
      .replace(
        /^lines\.([^.]+)\./,
        (_, id) => 'lines.' + d.lines.findIndex((l) => l.id === id) + '.',
      );
    if (!problems.has(path)) problems.set(path, i.message);
  }
  issues.push(...problems.values());
  if (parsed.success && customerId && lines.every((l) => l.productId)) validatedInput = parsed.data;
  return {
    fields,
    newCustomerPlan: newCustomer?.success ? newCustomer.data : null,
    newProductPlans: newProducts,
    issues: uniqueMessages(issues),
    notices: uniqueMessages([
      ...productNotices(optionalProducts),
      ...(currency.defaulted && currency.message ? [currency.message] : []),
    ]),
    validatedInput,
    writesEnabled: false as const,
  };
}
