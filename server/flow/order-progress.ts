import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, many, registerOrderRules, rows, type MaterialProgress } from '../core/index.js';
import { orderScope, shippedByLine } from './shipped.js';
import { quantityUnits } from '../../shared/core/index.js';
import type { FlowDocView } from '../../shared/business/index.js';
import { rebalanceMovements } from '../operations/index.js';
import { syncReceivedUnits } from './receipt-events.js';
import type { FlowCommands } from './base.js';
import { orderEditGuard } from './order-edit-guard.js';

/*
 * 订单的生产中、待发货、已发货由有效单据派生（AGENTS.md“订单状态”）：按生产任务、完工、送货重算订单状态，
 * 管理员改了单据、档案或删了记录以后连同已到货、库存结余、订单合计一起重算。
 * 订单视图里的发货进度、订料进度也在这里算，加载时登记给基础的 Store（server/core/order-hooks.ts）。
 */

type Task = FlowDocView<'task'>;
/** 一张任务挂了几张单时顺着找关联订单，最多找这么多张（防止一圈圈连下去读太多） */
const MAX_LINKED_ORDERS = 50;
/** 每张订单的采购明细里还没到齐的、到过货的行数 */
const materialRow = z.object({ id: z.number(), open: z.number(), touched: z.number() });

/** 每张订单的订料进度：按有效采购明细的到货算 */
export function materialByOrder(db: DatabaseSync, orderIds: readonly number[] | undefined) {
  const { predicate, params } = orderScope(orderIds);
  const material = new Map<number, MaterialProgress>();
  for (const row of many(
    db,
    materialRow,
    // 张、公斤不能相加，一行超收也不能盖住另一行没到，所以按明细行数。
    // 每行算在它自己关联的订单上，没有就跟采购单头走（一张采购单可以给几张订单订料）。
    // 只看一部分订单时，先按两个外键列（都有索引）圈出相关的采购单，不扫全部明细；范围条件因此出现三次
    "SELECT * FROM (SELECT COALESCE(l.customer_order_id,p.customer_order_id) AS id,SUM(l.received_units<l.quantity_units) AS open,SUM(l.received_units>0) AS touched FROM purchases p JOIN purchase_lines l ON l.purchase_id=p.id WHERE p.status!='已取消'" +
      (predicate
        ? ' AND p.id IN (SELECT id FROM purchases WHERE customer_order_id ' +
          predicate +
          ' UNION SELECT purchase_id FROM purchase_lines WHERE customer_order_id ' +
          predicate +
          ')'
        : '') +
      ' GROUP BY 1) WHERE id IS NOT NULL' +
      (predicate ? ' AND id ' + predicate : ''),
    ...params,
    ...params,
    ...params,
  ))
    material.set(row.id, !row.open ? 'done' : row.touched ? 'partial' : 'pending');
  return material;
}
/**
 * 按有效单据重算这几张订单的状态（生产中、待发货、已发货）。onlyChanged：状态没变就不动订单。
 */
export function updateOrders(flow: FlowCommands, ids: number[], onlyChanged = false) {
  for (const id of new Set(ids)) {
    const order = flow.store.order(id, true);
    if (!order) continue;
    // 每条明细已发多少：这张单的有效送货单一次读齐
    const shipped = shippedByLine(flow.store.db, [id]),
      sent = (lineId: number | undefined) => (lineId === undefined ? 0 : shipped.get(lineId) || 0);
    // 订购数按千分整数换算，不用浮点乘 1000（带三位小数的数量乘出来会差一点点）
    const open = order.lines.filter((l) => sent(l.id) < quantityUnits(String(l.quantity))),
      any = order.lines.some((l) => sent(l.id) > 0);
    // 取消和待确认是人工决定，不被后续单据的重算覆盖；已经出过库的订单不会是这两种（送货只收待完成的订单，
    // 普通保存不让改已出库订单的状态），本机管理员改单时改成了也按送货重算回来
    if (!any && (order.status === '已取消' || order.status === '待确认')) continue;
    const tasks = confirmedTasksOf(flow, id);
    // 未发完的每个产品都要做够，才算生产完毕；只做完部分产品不能算待发货。
    const produced = open.every((l) => producedEnough(flow, order.id, l.productId, tasks));
    const status = !open.length
      ? '已发货'
      : tasks.length
        ? produced
          ? '待发货'
          : '生产中'
        : any
          ? '待发货'
          : '已确认';
    if (onlyChanged && status === order.status) continue;
    flow.store.setDerivedOrderStatus(id, status);
  }
}
function confirmedTasksOf(flow: FlowCommands, orderId: number): Task[] {
  return many(
    flow.store.db,
    rows.flow_documents.pick({ id: true }),
    "SELECT DISTINCT d.id FROM flow_documents d JOIN flow_refs r ON r.document_id=d.id WHERE r.order_id=? AND d.kind='task' AND d.status='confirmed'",
    orderId,
  ).map((r) => flow.get(r.id, 'task'));
}
/** 任务挂的订单里还没看过的：记进 orders，返回这几张 */
function addOrders(task: Task, orders: Set<number>) {
  const added: number[] = [];
  for (const other of task.orderIds || [])
    if (!orders.has(other)) {
      orders.add(other);
      added.push(other);
    }
  return added;
}
/**
 * 这个产品的任务顺着挂的订单连起来：一张任务挂了几张单，就把这几张单和它们这个产品的任务都算进来。
 * own 是这张单自己的已下达任务（已经读过）。
 */
function linkedTasks(flow: FlowCommands, orderId: number, productId: number, own: Task[]) {
  const orders = new Set<number>([orderId]),
    tasks = new Map<number, Task>();
  let pending = [orderId];
  while (pending.length && orders.size <= MAX_LINKED_ORDERS) {
    const next: number[] = [];
    for (const oid of pending)
      for (const t of oid === orderId ? own : confirmedTasksOf(flow, oid))
        if (t.productId === productId && !tasks.has(t.id)) {
          tasks.set(t.id, t);
          next.push(...addOrders(t, orders));
        }
    pending = next;
  }
  return { orders, tasks };
}
/**
 * 这张单的这个产品做够了没有。同一产品分几行的合起来算；一张任务挂了几张单，
 * 不知道各分多少，就把这几张单合起来算，总量做够才算。任务和订单明细的单位都只有“只”（数据库约束），按产品对。
 */
function producedEnough(flow: FlowCommands, orderId: number, productId: number, own: Task[]) {
  if (!own.some((t) => t.productId === productId)) return false;
  const { orders, tasks } = linkedTasks(flow, orderId, productId, own);
  let need = 0;
  for (const oid of orders) {
    const o = flow.store.order(oid, true);
    if (!o || o.status === '已取消') continue;
    for (const l of o.lines)
      if (l.productId === productId) need += quantityUnits(String(l.quantity));
  }
  const made = [...tasks.values()].reduce((n, t) => n + quantityUnits(t.completed || '0'), 0);
  return made >= need;
}
/** 管理员直接改了单据、档案或删了记录以后：库存流水的前后结余、订单合计、订单状态全部重算。 */
export function recomputeAfterMaintenance(flow: FlowCommands, affectedOrders?: number[]) {
  syncReceivedUnits(flow.store, true);
  rebalanceMovements(flow.store, (name) => {
    throw new AppError(
      '库存改回后“' +
        name +
        '”会变成负数（后面的单据已经用掉了这批库存），这次没有删。可以先处理后面的单据，或者在“库存怎么处理”里改选“库存数量不动”。',
      409,
    );
  });
  flow.store.recomputeOrderTotals();
  refreshOrderProgress(flow, affectedOrders);
}
/** onlyChanged：状态没变就不动订单（不加版本号）。 */
export function refreshOrderProgress(flow: FlowCommands, ids?: number[], onlyChanged = false) {
  updateOrders(
    flow,
    ids ||
      // 条件里排除了空的订单编号
      many(flow.store.db, z.object({ order_id: z.number() }), 'SELECT DISTINCT order_id FROM flow_refs WHERE order_id IS NOT NULL').map(
        (r) => r.order_id,
      ),
    onlyChanged,
  );
}

// 订单视图（Store.order 等）的发货、订料进度和改单核对由单据流转提供
registerOrderRules({ shipped: shippedByLine, material: materialByOrder, editGuard: orderEditGuard });
