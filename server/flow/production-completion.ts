import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { archivedAmongIn, assertPreviewCurrent, many, previewDigest, rehearse, requestDone, requirePermission, rows } from '../core/index.js';
import { completionExecuteSchema, flowEntity, productionCompletionSchema, type CompletionPreview } from '../../shared/business/index.js';
import { COMPLETION_REQUEST, ProductionCompletion } from './batch-completion.js';
import type { CompletionInput } from './completion-plan.js';
import { storedContent } from './read.js';
import { purchaseOrderLinks } from '../operations/index.js';

/** 一组编号写成 json_each 用的文字：去掉空的、去重、从小到大 */
const idList = (values: readonly (number | null | undefined)[]) =>
  JSON.stringify([...new Set(values.filter((n) => n != null))].sort((a, b) => a - b));
const inList = ' IN (SELECT value FROM json_each(?))';

/** 这次完工读到的生产任务（连内容：有的写法只改内容不换版本号）和挂在它们上面的完工登记 */
function taskScope(db: DatabaseSync, input: CompletionInput) {
  const tasks = many(
    db,
    rows.flow_documents.pick({ id: true, number: true, kind: true, status: true, version: true, document: true }),
    'SELECT id,number,kind,status,version,document FROM flow_documents WHERE ' +
      (input.allActive ? "kind='task' AND status='confirmed'" : 'id' + inList) +
      ' ORDER BY id',
    ...(input.allActive ? [] : [idList(input.taskIds || [])]),
  );
  const docs = tasks.filter((t) => t.kind === 'task').map((t) => storedContent('task', t));
  const taskIds = idList(tasks.map((t) => t.id));
  const productions = many(
    db,
    rows.flow_documents.pick({ id: true, status: true, version: true }),
    'SELECT id,status,version FROM flow_documents WHERE id IN (SELECT document_id FROM flow_refs WHERE task_id' + inList + ') ORDER BY id',
    taskIds,
  );
  return {
    tasks,
    productions,
    taskIds,
    // 不挂任务的几行（打样、补做）的产品也算进来
    productIds: idList([...docs.map((d) => d.productId), ...(input.untasked || []).map((u) => u.productId)]),
    orderIds: idList(docs.flatMap((d) => d.orderIds || [])),
  };
}

/** 关联这些订单的采购单（采购单头或明细关联）和它们的明细 */
function purchaseScope(db: DatabaseSync, orderIds: string) {
  const purchases = many(
    db,
    rows.purchases.pick({ id: true, version: true }),
    'SELECT id,version FROM purchases WHERE id IN (SELECT purchase_id FROM (' + purchaseOrderLinks + ') WHERE order_id' + inList + ') ORDER BY id',
    orderIds,
  );
  const purchaseIds = idList(purchases.map((p) => p.id));
  const lines = many(
    db,
    rows.purchase_lines.pick({ id: true, purchase_id: true, stock_item_id: true, customer_order_id: true }),
    'SELECT id,purchase_id,stock_item_id,customer_order_id FROM purchase_lines WHERE purchase_id' + inList + ' ORDER BY id',
    purchaseIds,
  );
  return { purchases, purchaseIds, lines };
}

/** 可能被选中的库存品：给的编号，加上这些产品的成品库存 */
function stockScope(db: DatabaseSync, stockIds: string, productIds: string) {
  return many(
    db,
    rows.stock_items.pick({ id: true, kind: true, unit: true, product_id: true, version: true }),
    'SELECT id,kind,unit,product_id,version FROM stock_items WHERE id IN (SELECT value FROM json_each(?) UNION' +
      " SELECT id FROM stock_items WHERE kind='finished' AND product_id" + inList + ') ORDER BY id',
    stockIds,
    productIds,
  );
}

/** 读到的生产任务、产品、订单、采购单、库存品里归档了的（按记录种类、编号排） */
function archivedScope(db: DatabaseSync, ids: { taskIds: string; productIds: string; orderIds: string; purchaseIds: string; stockIds: string }) {
  const scopes: [string, string][] = [
    [flowEntity('task'), ids.taskIds],
    ['orders', ids.orderIds],
    ['products', ids.productIds],
    ['purchases', ids.purchaseIds],
    ['stock_items', ids.stockIds],
  ];
  return scopes
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([entity, list]) => [...archivedAmongIn(db, entity, list)].map((record_id) => ({ entity, record_id })));
}

export class ManualProductionCompletion {
  constructor(readonly store: Store) {}
  /**
   * 预览摘要：预览以后、正式登记以前，这次完工会读到的数据有变化，就要重新预览。
   * 只看这次完工实际会读到的记录（ProductionCompletion.execute 读的范围），不读整张表：
   * - 生产任务：指定的任务；“全部待完工”是全部已下达的任务，新安排、取消都会让范围变；
   * - 这些任务的完工登记（已完成数量由它派生）；
   * - 任务的产品、订单；关联这些订单的采购单（采购单头或明细关联）和它们的明细（明细上的库存品、关联订单）；
   * - 可能被选中的库存品：声明的原料、逐任务分配里的原料、采购明细上的库存品，
   *   以及这些产品的成品库存（一个产品只有一个；新建、归档、恢复都算变化）；
   * - 上面生产任务、产品、订单、采购单、库存品的归档标记（列表按它过滤）。
   * 任何一条记录的版本、状态、种类、单位、产品关联、归档有变化，或者范围里多了、少了记录，摘要就对不上。
   * 别的单据、库存品、订单变了不影响这次完工的结果，不再要求重新预览。算法和比对用公共件（server/core/preview-digest.ts）。
   */
  private digest(input: CompletionInput) {
    const db = this.store.db,
      scope = taskScope(db, input);
    const products = many(
      db,
      rows.products.pick({ id: true, version: true }),
      'SELECT id,version FROM products WHERE id' + inList + ' ORDER BY id',
      scope.productIds,
    );
    const orders = many(db, rows.orders.pick({ id: true, version: true }), 'SELECT id,version FROM orders WHERE id' + inList + ' ORDER BY id', scope.orderIds);
    const { purchases, purchaseIds, lines } = purchaseScope(db, scope.orderIds);
    const stockIds = idList([
      ...input.materials.map((m) => m.stockId),
      ...(input.distribution || []).flatMap((d) => d.materials.map((m) => m.stockId)),
      ...lines.map((l) => l.stock_item_id),
    ]);
    const stockItems = stockScope(db, stockIds, scope.productIds);
    const archived = archivedScope(db, { ...scope, purchaseIds, stockIds: idList(stockItems.map((s) => s.id)) });
    // 任务连内容一起算（有的写法只改内容不换版本号），别的记录看版本号
    const related = { tasks: scope.tasks, productions: scope.productions, products, orders, purchases, lines, stockItems, archived };
    return previewDigest({ input, related });
  }
  preview(raw: unknown, who: Actor): CompletionPreview {
    const actor = requirePermission(who, 'business:edit'),
      input = productionCompletionSchema.parse(raw);
    const digest = this.digest(input);
    return rehearse(this.store.db, () => {
      const result = new ProductionCompletion(this.store).execute(input, actor);
      return {
        ...result,
        results: result.results.map(({ productionId, number, finishedStockId, ...r }) => r),
        message: '预览通过，尚未登记实际完工或变更库存。',
        verified: false,
        inventoryChanged: false,
        previewDigest: digest,
      };
    });
  }
  execute(raw: unknown, who: Actor) {
    const actor = requirePermission(who, 'business:edit'),
      v = completionExecuteSchema.parse(raw);
    // 同一请求号已经登记过的重发不比摘要（数据已被这次登记改了），由 ProductionCompletion 原样返回上次的结果。
    // 比对和登记之间没有异步步骤，中间不会插进别的写入
    if (!requestDone(this.store, COMPLETION_REQUEST, actor, v.input.requestId)) assertPreviewCurrent(v.previewDigest, this.digest(v.input));
    return new ProductionCompletion(this.store).execute(v.input, actor);
  }
}
