import { sales, assertNewProductAllowed, assertPlannedProductsUnique, describeProduct, duplicateCustomers, type DuplicateRecord } from '../sales/index.js';
import { createHash } from 'node:crypto';
import type { Store } from '../core/index.js';
import { AppError } from '../core/index.js';
import {
  evaluateDraft,
  type CustomerPlanRef,
  type ImportMapping,
  type ImportWorkspaceView,
  type OrderDraft,
  type Plan,
  type ProductPlanRef,
  type SameNameConfirmation,
} from '../../shared/import/index.js';
import {
  customerSchema,
  duplicateKey,
  linePriceExact,
  plannedOrderSchema,
  productSchema,
  uniqueMessages,
  type Order,
  type PlannedOrderInput,
  type Product,
} from '../../shared/core/index.js';
import { autoMapCustomer, autoMapProducts, productKey } from './import-automap.js';
import { projectOrder } from './standard-order.js';
import { findFileImports, findOwnImport } from './import-records.js';
import { compareKey, duplicateOrderCandidates, type CustomerRef } from './order-lookup.js';
import { resolveImportCustomer } from './customer-resolution.js';
import { blocksNewProduct, productCandidatesForLine } from '../../shared/import/index.js';

/**
 * 正式导入的计划：能不能导（导过没有、类型对不对）、客户和产品没选的按规则自动对应、
 * 和已有订单查重，最后给出要建什么。只读，不写库；执行在 import-execution.ts。
 */
// 计划、客户和产品用哪个档案、同名要确认的行，这几种类型在 shared/import/import-plan.ts（导入预览窗也按它显示）
/** 订单指纹要用的几样：新订单（导入计划里的）和已有订单都有 */
type FingerprintOrder = Pick<PlannedOrderInput, 'externalPurchaseOrder' | 'orderDate' | 'deliveryDate'> & {
  lines: Pick<PlannedOrderInput['lines'][number], 'productName' | 'specification' | 'quantity' | 'unit' | 'unitPriceExact' | 'unitPriceCents'>[];
};

/** 提示里最多列几个同名档案 */
const NAMES_SHOWN = 5;
const CUSTOMER_CHANGED = '客户已变化或已归档，请重新预览。';
const PRODUCT_CHANGED = '产品已变化或已归档，请重新预览。';
const emptyMapping = (): ImportMapping => ({ customer: { mode: 'pending' }, products: {}, roundingPolicy: 'exact-cents' });

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const price = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/** 订单内容指纹：客户、采购单号、两个日期、每行的品名规格数量单位单价（行的顺序不算） */
export function fingerprint(customer: string, order: FingerprintOrder) {
  return digest([
    compareKey(customer),
    order.externalPurchaseOrder ? compareKey(order.externalPurchaseOrder) : '',
    order.orderDate,
    order.deliveryDate,
    order.lines
      .map((l) => [
        compareKey(l.productName || ''),
        compareKey(l.specification),
        l.quantity,
        l.unit,
        // 只有分的按分换成元（BigInt，不经过浮点除法）；price 去掉尾零，所以和原来 String(分 / 100) 的键一样
        price(linePriceExact(l)),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
const customerRef = (c: CustomerPlanRef): CustomerRef =>
  c.mode === 'existing' ? { mode: 'existing', id: c.id } : { mode: 'new', name: c.name };
/** 同一客户、同一采购单号（比较键相同） */
function samePurchaseOrder(customer: CustomerPlanRef, order: FingerprintOrder, o: Order) {
  return (
    !!order.externalPurchaseOrder &&
    (customer.mode === 'existing' ? o.customerId === customer.id : compareKey(o.customerName) === compareKey(customer.name)) &&
    compareKey(o.externalPurchaseOrder || '') === compareKey(order.externalPurchaseOrder)
  );
}
/** 已有订单里和这张重复的第一张（含归档）：同一采购单号，或者内容指纹相同 */
function duplicateOrder(store: Store, customer: CustomerPlanRef, order: PlannedOrderInput, signature: string) {
  return duplicateOrderCandidates(store, customerRef(customer), order).find(
    (o) =>
      samePurchaseOrder(customer, order, o) ||
      fingerprint(customer.mode === 'existing' ? 'customer:' + o.customerId : o.customerName, o) === signature,
  );
}
/** 执行时再查一次：同一客户、同一采购单号的已有订单 */
export function purchaseOrderTaken(store: Store, customer: CustomerPlanRef, order: PlannedOrderInput) {
  return (
    !!order.externalPurchaseOrder &&
    duplicateOrderCandidates(store, customerRef(customer), order).some((o) => samePurchaseOrder(customer, order, o))
  );
}

/**
 * 这份工作区现在能不能导：归档没有、类型、本工作区导过没有、同一原件有没有还在的订单。
 * 页面、助手的确认卡片、数据管理导入都经过这里（预览和执行各查一次），别处不另判断。
 * 正在识别、正在提交的由 withImportSource 挡。
 */
function assertImportable(store: Store, w: ImportWorkspaceView) {
  if (w.archived) throw new AppError('这份识别文件已归档，先恢复再导入。', 409);
  if (w.mode !== 'order')
    throw new AppError('到货单只能通过收货确认进入原材料库存，不能导入为客户订单。', 409);
  if (findOwnImport(store, w.id))
    throw new AppError(
      '本工作区已导入正式订单，不能重复创建；如需再次导入同一原件，请重新上传建立新的导入任务。',
      409,
      'duplicate',
    );
  const history = findFileImports(store, w.fileHash).filter((r) => r.sourceId !== w.id);
  const active = history.find((r) => !r.permanentlyDeleted && !r.archived);
  if (active)
    throw new AppError(
      '同一文件此前已导入有效订单 ' +
        active.orderNumber +
        '，请到订单管理核对；如确需重新创建，请先归档或永久删除原订单，再重新导入。',
      409,
      'duplicate',
    );
  const archived = history.find((r) => !r.permanentlyDeleted && r.archived);
  if (archived)
    throw new AppError(
      '同一文件此前的订单 ' +
        archived.orderNumber +
        ' 已归档，请先在订单管理恢复原订单；如确认不需要该订单，可永久删除后再导入同一原件。',
      409,
      'duplicate',
    );
}

const names = (rows: DuplicateRecord[]) =>
  rows
    .slice(0, NAMES_SHOWN)
    .map((r) => r.name + (r.archived ? '（已归档）' : ''))
    .join('、');
/**
 * 预览前和执行前都核一次：选的档案还在、版本没变；要新建的客户没有同名的已有档案；
 * 要新建的产品过客户产品订单模块的 assertNewProductAllowed（料号相同、同名同尺寸材质的拦下，连已归档的一起比）。
 * 返回每行已有的同名不同尺寸材质的产品，要人确认是另一个产品。
 */
export function checkReferences(store: Store, customer: CustomerPlanRef, products: ProductPlanRef[]) {
  const sameName = new Map<number, string[]>();
  if (customer.mode === 'existing') {
    const c = sales(store).customer(customer.id);
    if (!c || c.version !== customer.version) throw new AppError(CUSTOMER_CHANGED, 409);
  } else {
    const same = duplicateCustomers(store, customer.name);
    if (same.length)
      throw new AppError('已有同名客户（' + names(same) + '），请选择已有档案或先恢复，不能再新建一份。', 409);
  }
  const customerId = customer.mode === 'existing' ? customer.id : null;
  const plannedNew: { key: string; line: number; input: Product['customerId'] extends never ? never : (ProductPlanRef & { mode: 'new' })['input'] }[] = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (p.mode === 'existing') {
      const found = sales(store).product(p.id);
      if (!found || found.version !== p.version) throw new AppError(PRODUCT_CHANGED, 409);
      if (found.customerId != null && found.customerId !== customerId) {
        const owner = found.customerName || sales(store).customer(found.customerId, true)?.name || '其他客户';
        throw new AppError(`这个产品是 ${owner} 的，要给 ${customer.name} 用请复制一份`, 409);
      }
    } else {
      plannedNew.push({ key: p.key, line: i + 1, input: { ...p.input, customerId } });
      if (customerId !== null) {
        // 新建的产品归当前订单客户，只在这一家客户下查重；新客户还没入库，库里不会有属于它的旧产品
        const found = assertNewProductAllowed(store, { ...p.input, customerId }, true);
        if (found.sameName.length) sameName.set(i, found.sameName.map(describeProduct));
      }
    }
  }
  // 同一张订单里多行计划新建不同产品时，彼此之间也按同一查重规则核对（料号相同或同名同尺寸材质拦下；完全相同 key 的仍合并只建一次）
  assertPlannedProductsUnique(plannedNew);
  return sameName;
}

/**
 * 要人确认的行：已有同名不同尺寸材质的产品，或者同一张订单里另一行要新建同名、资料不一样的产品（各自确认）。
 * 资料完全一样的两行合成一个产品（key 相同，执行时只建一次），不用确认。
 */
function sameNameConfirmations(refs: ProductPlanRef[], existing: Map<number, string[]>): SameNameConfirmation[] {
  const out: SameNameConfirmation[] = [];
  refs.forEach((r, i) => {
    if (r.mode !== 'new') return;
    const twins = refs.flatMap((o, j) =>
      o.mode === 'new' && j !== i && o.key !== r.key && duplicateKey(o.input.name) === duplicateKey(r.input.name)
        ? ['本单第 ' + (j + 1) + ' 行：' + describeProduct(o.input)]
        : [],
    );
    const list = [...(existing.get(i) || []), ...twins];
    if (list.length) out.push({ lineId: r.lineId, line: i + 1, name: r.name, existing: list });
  });
  return out;
}
/** 执行前：要确认的行都确认过（页面上勾了，或助手的确认卡片上点了确认） */
export function assertConfirmed(plan: Plan, confirmed: Iterable<string>) {
  const ok = new Set(confirmed);
  const missing = plan.confirmations.filter((c) => !ok.has(c.lineId));
  if (missing.length)
    throw new AppError(
      missing.map((c) => '第 ' + c.line + ' 行“' + c.name + '”已有同名产品：' + c.existing.slice(0, NAMES_SHOWN).join('；')).join('。') +
        '。尺寸或材质不一样（或没写全），确认是另一个产品才新建。',
      409,
      'same-name-product',
    );
}
/** 识别结果改过以后、人还没重新选的匹配：先说清楚哪里要重选 */
function assertMappingCurrent(w: ImportWorkspaceView, draft: OrderDraft, mapping: ImportMapping) {
  if (w.mappingInvalidated?.customer && mapping.customer.mode === 'pending')
    throw new AppError(w.mappingInvalidated.customer);
  for (const line of draft.lines) {
    const invalidated = w.mappingInvalidated?.products[line.id];
    const choice = mapping.products[line.id];
    // 识别结果里新加的行还没有选择（没有这一项）
    if (invalidated && (!Object.hasOwn(mapping.products, line.id) || choice.mode === 'pending'))
      throw new AppError('第' + (draft.lines.indexOf(line) + 1) + '项：' + invalidated);
  }
}
type Projection = ReturnType<typeof projectOrder>;
/** 客户用哪个档案：已有的带上名字，新建的带上相近的已有客户 */
function customerPlan(store: Store, mapping: ImportMapping, name: string, projection: Projection): CustomerPlanRef {
  if (mapping.customer.mode === 'existing') {
    const found = sales(store).customer(mapping.customer.id);
    if (!found) throw new AppError(CUSTOMER_CHANGED, 409);
    return { ...mapping.customer, name: found.name };
  }
  return {
    mode: 'new',
    key: compareKey(name),
    input: customerSchema.parse(projection.newCustomerPlan),
    name,
    similar: resolveImportCustomer(store, name).candidates.map((c) => c.name + (c.archived ? '（已归档）' : '')),
  };
}
/** 一行产品用哪个档案：已有的带上名字，新建的带上必须确认的相近产品 */
function productPlan(
  store: Store,
  line: OrderDraft['lines'][number],
  context: { mapping: ImportMapping; projection: Projection; products: Product[]; customerId: number | null },
): ProductPlanRef {
  const choice = context.mapping.products[line.id];
  if (choice.mode === 'existing') {
    const found = sales(store).product(choice.id);
    if (!found) throw new AppError(PRODUCT_CHANGED, 409);
    return { ...choice, name: found.name };
  }
  const planned = context.projection.newProductPlans.find((p) => p.lineId === line.id);
  if (!planned) throw new Error('导入计划里缺第 ' + line.id + ' 行要新建的产品');
  return {
    mode: 'new',
    key: productKey(planned.input),
    input: productSchema.parse({ ...planned.input, customerId: context.customerId }),
    // 新建的产品一定有名称（过了产品校验），取原件上的写法
    name: line.fields.productName.value ?? planned.input.name,
    lineId: line.id,
    similar: productCandidatesForLine(line, context.products, context.customerId)
      .filter(blocksNewProduct)
      .flatMap((c) => context.products.filter((p) => p.id === c.id).map((p) => describeProduct(p))),
  };
}
/** 生成导入计划。产品候选要和当前客户及未定客户的在用产品比相似度（按名称、尺寸打分）。 */
export function importPlan(store: Store, w: ImportWorkspaceView): Plan {
  assertImportable(store, w);
  const draft = w.draft;
  if (!draft) throw new AppError('请先识别订单。');
  const mapping = structuredClone(w.mapping || emptyMapping());
  assertMappingCurrent(w, draft, mapping);
  const name = draft.header.buyerName.value || '';
  autoMapCustomer(store, mapping, name);
  const customerId = mapping.customer.mode === 'existing' ? mapping.customer.id : null;
  const products = sales(store).products();
  autoMapProducts(draft, mapping, products, customerId);
  const projection = projectOrder(store, draft, mapping);
  if (projection.issues.length) throw new AppError(projection.issues.join('；'));
  const customer = customerPlan(store, mapping, name, projection);
  const refs = draft.lines.map((l) => productPlan(store, l, { mapping, projection, products, customerId }));
  const confirmations = sameNameConfirmations(refs, checkReferences(store, customer, refs));
  // 新客户、新产品尚未入库，编号留空（null），不填占位编号；正式编号在同一个数据库事务中先建客户、再建产品写入。
  const order = plannedOrderSchema.parse({
    ...projection.fields,
    customerId: customer.mode === 'existing' ? customer.id : null,
    lines: projection.fields.lines.map((l, i) => {
      const ref = refs[i];
      return { ...l, productId: ref.mode === 'existing' ? ref.id : null };
    }),
  });
  const signature = fingerprint(customer.mode === 'existing' ? 'customer:' + customer.id : customer.name, order);
  const duplicate = duplicateOrder(store, customer, order, signature);
  if (duplicate)
    throw new AppError(
      '检测到相同采购单号或相同订单内容：' + duplicate.number + '。请核对历史订单，本版不会自动覆盖或重复新增。',
      409,
      'duplicate',
    );
  const evaluation = evaluateDraft(draft);
  return {
    policyVersion: 'reviewed-import-v3',
    source: { id: w.id, hash: w.fileHash, fileName: w.fileName, revision: w.revision },
    customer,
    products: refs,
    order,
    fingerprint: signature,
    total: evaluation.totalAmount,
    warnings: uniqueMessages([...projection.notices, ...evaluation.issues.map((i) => i.message)]),
    confirmations,
  };
}
