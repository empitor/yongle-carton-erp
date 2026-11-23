import { sales, assertNewProductAllowed } from '../sales/index.js';
import { z } from 'zod';
import { customerSchema, productSchema, orderSchema, derivedOrderStatuses } from '../../shared/core/index.js';
import type { Customer, Product, TrackedOrder } from '../../shared/core/index.js';
import { Store, InputError, exists, notFound } from '../core/index.js';
import { validAssistantGrant } from '../core/index.js';
import { isLocalAdministrator } from '../core/index.js';
import { alignOrder, prepareOrderEdit } from './order-edit-cascade.js';
import { FlowService, orderEditGuard } from '../flow/index.js';
import { syncFinishedStock } from '../operations/index.js';
import { audit, inSavepoint, isSuperMode } from '../core/index.js';
import { TakenSnapshot } from '../lifecycle/index.js';
import type { Actor } from '../core/index.js';
import { trackOrders, trackedOrder } from './tracked-orders.js';

const writableEntities = ['customers', 'products', 'orders'] as const;
type WritableEntity = (typeof writableEntities)[number];
/** 每类记录保存后回的 */
type Saved = { customers: Customer; products: Product; orders: TrackedOrder };
export type BusinessCommand<E extends WritableEntity = WritableEntity> =
  | { entity: E; action: 'create'; input: unknown }
  | { entity: E; action: 'update'; id: unknown; input: unknown };

// 上下文只能由后端建立，不能从请求正文、Excel 或模型输出读取。
// 来源只有两种：页面人工（manual-ui）、人确认过的助手卡片（reviewed-assistant，要带有效的确认凭据）
type WriteContext = {
  source: 'manual-ui' | 'reviewed-assistant';
  approval?: object;
  operatorId: string | null;
  superAdminMode?: boolean;
  actor?: Actor;
};
export class BusinessAccessError extends Error {}
/** 按编号找不到订单时的说法（保存、读一张订单都用它） */
export const ORDER_NOT_FOUND = '订单不存在';
/** 读一张订单（含已归档的）：调用前已核对过存在，读不到按“订单不存在”报 */
const savedOrder = (store: Store, id: number) => trackedOrder(store, id, true) ?? notFound(ORDER_NOT_FOUND);

/** 校验过的一次保存：新建没有 id 和 version */
type SaveJob = { input: unknown; context: WriteContext } &
  ({ action: 'create'; id?: undefined; version?: undefined } | { action: 'update'; id: number; version: number });
/** 新建产品时确认了“是另一个产品”（confirmDistinct: true） */
const confirmsDistinct = (input: unknown) =>
  typeof input === 'object' && input !== null && 'confirmDistinct' in input && input.confirmDistinct === true;

/** 每类记录怎么存：按 entity 取，返回值跟着 entity 走 */
const savers: { [E in WritableEntity]: (store: Store, job: SaveJob) => Saved[E] } = {
  customers: (store, job) => {
    const customer = customerSchema.parse(job.input);
    return job.action === 'create'
      ? sales(store).createCustomer(customer)
      : sales(store).updateCustomer(customer, job.id, job.version, job.context.superAdminMode);
  },
  products: (store, { action, input, id, version, context }) => {
    const product = productSchema.parse(input);
    // 新建前查重（三个入口同一套，server/sales/duplicate-records.ts）：已有同名、尺寸或材质不同的，
    // 要在新建窗口里确认“是另一个产品”（confirmDistinct）才建
    if (action === 'create') {
      assertNewProductAllowed(store, product, confirmsDistinct(input));
      return sales(store).createProduct(product);
    }
    return inSavepoint(store.db, () => {
      const previous = sales(store).product(id, context.superAdminMode);
      if (!previous) notFound('记录不存在');
      const saved = sales(store).updateProduct(product, id, version, context.superAdminMode);
      // 产品和它的成品库存在同一个保存点内更新。
      syncFinishedStock(store, previous, saved, context.actor);
      return saved;
    });
  },
  orders: saveOrderCommand,
};

function saveOrderCommand(store: Store, { input: raw, id, version, context }: SaveJob): TrackedOrder {
  // 生产中/待发货/已发货只由任务和送货单派生（AGENTS.md“订单状态”），谁都不能手工改成这些状态，
  // 本机管理员也一样，否则会绕过实物流转
  {
    const next = orderSchema.parse(raw).status,
      previous = id ? sales(store).order(id, true)?.status : undefined;
    if (next !== previous && derivedOrderStatuses.includes(next))
      throw new InputError(
        '“' + next + '”由生产任务和送货单自动更新，不能手工设置。请通过生产或送货记录推进订单。',
      );
  }
  // 本机管理员改订单（页面、数据管理、助手都走这里）：按新明细删除或改写已确认的送货单、任务和库存流水
  const actor = context.actor;
  if (id && actor && isLocalAdministrator(actor)) {
    const before = savedOrder(store, id);
    if (before.version !== version) throw new InputError('记录版本已改变，请刷新。');
    // 会不会改写取决于明细、客户和历史关联，逐条判断容易漏，所以走这条路就先留快照；普通保存不删不改单据，不拍。
    // 快照另开只读连接拍，调用方已开 SAVEPOINT 也有效。连带删整张送货单时删除引擎凭这份不再另拍。
    const snapshot = TakenSnapshot.take(store, 'order-maintenance-edit');
    const orderId = id,
      input = orderSchema.parse(raw);
    return inSavepoint(store.db, () => {
      prepareOrderEdit(store, before, input.lines, actor, snapshot);
      const current = sales(store).order(orderId, true) ?? notFound(ORDER_NOT_FOUND);
      const updated = sales(store).saveOrder(input, orderId, current.version, true);
      alignOrder(store, before, updated, actor);
      // 全库重算到货数、库存余额和订单金额（这三步不分范围）；传空数组是因为这张订单的生产、发货进度
      // alignOrder 已经按需重算过，这里不再重算任何订单的进度
      new FlowService(store).recomputeAfterMaintenance([]);
      return savedOrder(store, orderId);
    });
  }
  return saveOrderWithProgress(store, orderSchema.parse(raw), id, version, context.superAdminMode);
}

export function createBusinessService(store: Store) {
  return {
    execute<E extends WritableEntity>(command: BusinessCommand<E>, context: WriteContext): Saved[E] {
      // 只收页面人工和带确认凭据的助手来源；别的来源（运行时传进来的任何值）一律拒绝。助手来源要带人点过确认卡片后
      // 后端发的凭据；导入不走这里，只走识别导入模块 server/import/import-execution.ts 的绑定预览与事务入口。
      const reviewed = context.source === 'reviewed-assistant' && validAssistantGrant(context.approval, context.operatorId);
      if (context.source !== 'manual-ui' && !reviewed)
        throw new BusinessAccessError('AI 与批量导入写入尚未启用，请先完成账号权限、审核与审计。');
      const entity = z.enum(writableEntities).parse(command.entity);
      const action = z.enum(['create', 'update']).parse(command.action);
      const id =
        action === 'update'
          ? z.coerce
              .number()
              .int()
              .positive()
              .parse('id' in command ? command.id : undefined)
          : undefined;
      if (
        id &&
        !(entity === 'customers'
          ? sales(store).customer(id, context.superAdminMode)
          : entity === 'products'
            ? sales(store).product(id, context.superAdminMode)
            : sales(store).order(id, context.superAdminMode))
      )
        notFound(entity === 'orders' ? ORDER_NOT_FOUND : '记录不存在');
      const input = command.input;
      const job: SaveJob = id === undefined
        ? { action: 'create', input, context }
        : { action: 'update', id, version: z.object({ version: z.number().int().positive() }).parse(input).version, input, context };
      return savers[command.entity](store, job);
    },
  };
}

/**
 * 保存订单（不是本机管理员的数据维护）：生产中、待发货、已发货由单据派生，有关联单据的订单保存后按单据重算一次，
 * 手工改成“已确认”盖不住正在做的任务和已出库的送货单。待确认、已取消是人工决定，重算不动它们。
 * 整张保存和状态动作（order-status.ts）都走这里。
 */
export function saveOrderWithProgress(
  store: Store,
  input: ReturnType<typeof orderSchema.parse>,
  id: number | undefined,
  version: number | undefined,
  includeArchived?: boolean,
) {
  return inSavepoint(store.db, () => {
    const previous = id === undefined ? undefined : sales(store).order(id, includeArchived);
    const checkEdit = previous && orderEditGuard(store.db, previous);
    const saved = sales(store).saveOrder(input, id, version, includeArchived, checkEdit);
    const linked = exists(store.db, 'SELECT 1 FROM flow_refs WHERE order_id=? LIMIT 1', saved.id);
    if (linked) new FlowService(store).refreshOrderProgress([saved.id], true);
    return linked ? savedOrder(store, saved.id) : trackOrders(store, [saved])[0];
  });
}

/**
 * 页面上手工新建、修改客户、产品、订单（原来写在 server/app.ts）：在一个保存点里办，办完写审计；
 * 本机管理员改订单前的恢复快照在 execute 里拍。actor 是登录后有编辑权限的账号，没开登录（测试）时为 null。
 */
export function manualWrite<E extends WritableEntity>(store: Store, command: BusinessCommand<E>, actor: Actor | null) {
  const elevated = isSuperMode(actor);
  const id = 'id' in command ? Number(command.id) : null,
    before = id
      ? command.entity === 'customers'
        ? sales(store).customer(id, elevated)
        : command.entity === 'products'
          ? sales(store).product(id, elevated)
          : trackedOrder(store, id, elevated)
      : null;
  return inSavepoint(store.db, () => {
    const result = createBusinessService(store).execute(command, {
      source: 'manual-ui',
      operatorId: actor?.id || null,
      superAdminMode: elevated,
      actor: actor || undefined,
    });
    if (actor)
      audit(store, actor, {
        action: command.action,
        entity: command.entity,
        id: result.id,
        document: { before, after: result, beforeArchived: id ? store.archived(command.entity, id) : false },
      });
    return result;
  });
}
