import { createHash } from 'node:crypto';
import type { Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import type { ImportMapping, OrderDraft } from '../../shared/import/index.js';
import { blocksNewProduct, productCandidatesForLine, productsForCustomer } from '../../shared/import/index.js';
import { MAX_CM_DIMENSION, hasCompleteProductIdentity, productIdentityParts, type Product } from '../../shared/core/index.js';
import { resolveImportCustomer } from './customer-resolution.js';
import { productFieldsFromDraft } from './product-input.js';

/*
 * 正式导入前的自动对应：客户、产品没选的按名字、尺寸对上已有档案；对不上又有必须确认的候选就停下问，
 * 什么都没有才计划新建。选了“新建”的照办，会新建哪些由导入方案列出来（import-plan.ts），人在预览或确认卡片上看过再导入。
 */

/** 产品身份键：名称、尺寸、材质、楞型、要求、料号都一样才算同一个 */
export const productKey = (p: Parameters<typeof productIdentityParts>[0]) =>
  createHash('sha256').update(JSON.stringify(productIdentityParts(p))).digest('hex');

/** 客户没选（或选了新建）时按名字自动对应：唯一对上就用已有档案；有相近的又没选就停下问 */
export function autoMapCustomer(store: Store, mapping: ImportMapping, name: string) {
  if (mapping.customer.mode === 'pending' || mapping.customer.mode === 'new') {
    const resolved = resolveImportCustomer(store, name);
    if (resolved.state === 'archived')
      throw new AppError('同名客户已归档，请先恢复原档案；不会重复新建。', 409);
    if (resolved.state === 'resolved') {
      const c = resolved.customer;
      mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    }
  }
  if (mapping.customer.mode === 'pending') {
    if (resolveImportCustomer(store, name).state === 'ambiguous')
      throw new AppError('客户匹配存在歧义，请核对候选后明确选择，再保存客户与产品选择。');
    mapping.customer = { mode: 'new' };
  }
}

/** 一行明细要新建的产品资料；尺寸写得不对就停下 */
function definitionOf(line: OrderDraft['lines'][number]) {
  const f = line.fields;
  let definition: ReturnType<typeof productFieldsFromDraft>;
  try {
    definition = productFieldsFromDraft(f);
  } catch {
    throw new AppError('产品“' + (f.productName.value || '未命名') + '”尺寸必须为有效正数，缺失时请留空。');
  }
  if (
    definition.dimensionUnit === 'cm' &&
    [definition.length, definition.width, definition.height].some((n) => n !== null && n > MAX_CM_DIMENSION)
  )
    throw new AppError('产品“' + definition.name + '”厘米尺寸超过1000cm，请修正数值或单位。');
  return definition;
}

/**
 * 产品没选的按名称、尺寸自动对应：只在该客户的产品和没定客户的通用产品里找；
 * 唯一对上用已有档案，有必须确认的候选就停下，什么都没有才计划新建。
 */
export function autoMapProducts(
  draft: OrderDraft,
  mapping: ImportMapping,
  products: Product[],
  customerId: number | null,
) {
  const eligible = productsForCustomer(products, customerId);
  for (const l of draft.lines) {
    const no = draft.lines.indexOf(l) + 1;
    const definition = definitionOf(l);
    const choice = mapping.products[l.id] ?? { mode: 'pending' };
    const exactProducts = () =>
      hasCompleteProductIdentity(definition)
        ? eligible.filter((p) => hasCompleteProductIdentity(p) && productKey(p) === productKey(definition))
        : [];
    if (choice.mode !== 'pending') continue;
    const exact = exactProducts(),
      candidates = productCandidatesForLine(l, eligible, customerId);
    // 统一按候选规则自动对应：存在单位/规格/属性冲突或无明确单位证据的候选绝不绕过自动采用
    const best = candidates.filter((c) => c.recommended);
    const same = best.length === 1 ? eligible.find((p) => p.id === best[0].id) : undefined;
    if (same) mapping.products[l.id] = { mode: 'existing', id: same.id, version: same.version };
    else if (exact.length || candidates.some(blocksNewProduct))
      throw new AppError(
        '第' + no + '项“' + definition.name + '”已找到产品候选，请确认关联或明确选择计划新建，再保存客户与产品选择。',
      );
    else mapping.products[l.id] = { mode: 'new' };
  }
}
