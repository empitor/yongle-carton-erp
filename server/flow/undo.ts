import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import { audit, exists, inSavepoint, requirePermission, requireSuperModeFor } from '../core/index.js';
import { today } from '../../shared/core/index.js';
import { flowUndoSchema, type FlowDocView, type FlowKind } from '../../shared/business/index.js';
import { touchOrderBatch, touchPurchases } from '../operations/index.js';
import { fail, taskOf, type FlowCommands } from './base.js';
import { sourceTotals, stockShortage } from './correction-movements.js';
import { touchFlowDocument, writeFlowDocument } from './document-store.js';
import { storedDocument } from './read.js';
import { arrivalPurchaseIds, syncReceivedUnits } from './receipt-events.js';
import { updateOrders } from './order-progress.js';
import { movement } from './confirm.js';

/*
 * 取消（还没核对的单据作废，不动库存）和撤销（已核对的单据撤回：反向流水，原单保留标已撤销）。
 * 给人看的话一律说“撤销”，“冲销”只留给财务凭证。
 */

/** 取消、撤销的输入：核对时的版本号、原因、确认看过了（规则在 shared/business/flow-requests.ts） */
type UndoInput = z.output<typeof flowUndoSchema>;

/** 这张生产任务名下有没有这个状态（draft 待入库、confirmed 已入库）的完工单 */
const hasProduction = (flow: FlowCommands, taskId: number, status: 'draft' | 'confirmed') =>
  exists(
    flow.store.db,
    "SELECT 1 FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.task_id=? AND d.kind='production' AND d.status=? LIMIT 1",
    taskId,
    status,
  );

export function cancel(flow: FlowCommands, id: number, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit'),
    v = flowUndoSchema.parse(raw);
  return inSavepoint(flow.store.db, () => {
    const doc = flow.get(id);
    // 已经取消过、原因相同就原样返回：双击、网络重试不报错
    if (doc.status === 'cancelled' && doc.cancellation?.reason === v.reason) return doc;
    const remainingTask = doc.kind === 'task' && doc.status === 'confirmed' && doc.progress < 100;
    if (remainingTask && hasProduction(flow, id, 'draft'))
      fail('这个任务还有待入库的完工单，请先核对入库或取消那张完工单，再取消剩余任务。', 409);
    if (doc.version !== v.version || (doc.status !== 'draft' && !remainingTask))
      fail('只有还没核对的单据可以取消；已经生效的单据请用“撤销”。', 409);
    // 在库里存的那份内容上加取消记录（不是把视图写回去）
    writeFlowDocument(
      flow.store,
      id,
      { ...storedDocument(flow.store, id), cancellation: { reason: v.reason, by: actor.name, at: new Date().toISOString() } },
      { status: 'cancelled', at: new Date().toISOString() },
    );
    if (remainingTask) updateOrders(flow, doc.orderIds);
    audit(flow.store, actor, {
      action: 'cancel',
      entity: 'flow_' + doc.kind,
      id,
      document: { before: doc, reason: v.reason },
    });
    return flow.get(id);
  });
}
/** 到货单上有没撤销的采购退货时，先撤销退货再撤销或更正到货，退货记录不悬空。撤销、更正都只用这一个检查、这一句话。 */
export function assertNoActiveReturns(flow: FlowCommands, arrivalId: number) {
  if (exists(flow.store.db, "SELECT 1 FROM purchase_returns WHERE arrival_id=? AND status='confirmed' LIMIT 1", arrivalId))
    fail('这张到货已有采购退货，请先撤销退货，再处理到货单。', 409);
}
/**
 * 撤销到货：关联的采购单、订货单换版本号；送货单号和原件放出来，重新登记时不当成重复收货。
 * 已到货缓存在撤销的事务末尾由 syncReceivedUnits 按有效单据重算
 */
function releaseArrival(flow: FlowCommands, doc: FlowDocView<'arrival'>) {
  // 这里只给关联采购单换版本号（解除过采购关联的行没有采购单）
  for (const l of doc.lines)
    if (l.purchaseLineId && l.purchaseId) touchPurchases(flow.store, [l.purchaseId], new Date().toISOString());
  // 订货单还差多少跟着变：换版本号，开着的登记窗口提示刷新
  if (doc.orderBatchId != null) touchOrderBatch(flow.store, doc.orderBatchId, new Date().toISOString());
  // 撤销后这张送货单号和原件都还没入过库，重新登记时不能当成重复收货
  flow.store.db.prepare('DELETE FROM flow_receipt_keys WHERE document_id=?').run(doc.id);
  flow.store.db.prepare('DELETE FROM flow_file_uses WHERE document_id=?').run(doc.id);
}

/** 能不能撤销：版本对得上、已确认；到货没有挂着的退货；生产任务没有入库的完工单 */
function checkReversible(flow: FlowCommands, doc: FlowDocView, v: UndoInput) {
  if (doc.version !== v.version || doc.status !== 'confirmed') fail('单据已变更或不是已确认状态。', 409);
  if (doc.kind === 'arrival') assertNoActiveReturns(flow, doc.id);
  if (doc.kind === 'task' && hasProduction(flow, doc.id, 'confirmed'))
    fail('这张任务已有入库的完工单，请先撤销那些完工单，再撤销任务。');
}

/** 库存不够扣回时，到货、完工另说一句：只是数量登记错了的改用更正（按净变化扣） */
const shortageHint = (kind: FlowKind) =>
  kind === 'arrival' || kind === 'production'
    ? '；只是数量登记错了的，改用“更正' + (kind === 'arrival' ? '到货单' : '完工单') + '”（按净变化扣）'
    : '';

/** 反向流水：按库存品合计各冲回一笔（更正冲回原单同一个做法，correction-movements.ts），先查够不够扣；返回流水编号 */
function reverseMovements(flow: FlowCommands, doc: FlowDocView, actor: Actor, reason: string) {
  const totals = new Map([...sourceTotals(flow, doc.kind, doc.id)].map(([stockId, total]) => [stockId, -total]));
  for (const [stockId, delta] of totals)
    if (flow.ops.repo.balance(stockId) + delta < 0) stockShortage(flow, stockId, -delta, '撤销要扣回', shortageHint(doc.kind));
  const source = { kind: doc.kind, id: doc.id, number: doc.number, date: today() },
    movements: string[] = [];
  for (const [stockId, delta] of totals)
    if (delta) movements.push(movement(flow, { stockId, delta, doc: source, actor, reason: '撤销：' + reason, sourceKind: 'flow_reversal' }));
  return movements;
}

/** 撤销以后：订单进度、采购单的已到货跟着变 */
function afterReverse(flow: FlowCommands, doc: FlowDocView) {
  if (doc.kind === 'delivery') updateOrders(flow, doc.lines.map((l) => l.orderId));
  if (doc.kind === 'task') updateOrders(flow, doc.orderIds);
  if (doc.kind === 'production' && doc.taskId) updateOrders(flow, taskOf(flow, doc.taskId).orderIds);
  if (doc.kind === 'arrival') syncReceivedUnits(flow.store, false, arrivalPurchaseIds(flow.store, [doc.id]));
}

/**
 * 撤销：生成反向库存流水，原单据保留并标已撤销。送货、到货发错或登记重了，有编辑权限的业务账号就能撤销
 * （界面叫“撤销这次送货/到货”）；生产任务、完工的撤销要超级管理员模式。只是数量登记错了的用更正（correction.ts）。
 */
export function reverse(flow: FlowCommands, id: number, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit');
  const kind = flow.get(id).kind;
  // 生产任务、完工的撤销要超级管理员模式：进不了模式的账号（业务员）直接说没有权限，不叫人去“系统维护”
  if (kind !== 'delivery' && kind !== 'arrival')
    requireSuperModeFor(actor, kind === 'task' ? '撤销生产任务' : kind === 'production' ? '撤销完工' : '撤销这张单据');
  const v = flowUndoSchema.parse(raw);
  return inSavepoint(flow.store.db, () => {
    const doc = flow.get(id);
    if (doc.status === 'reversed' && doc.reversal?.reason === v.reason) return doc;
    checkReversible(flow, doc, v);
    const movements = reverseMovements(flow, doc, actor, v.reason);
    if (doc.kind === 'arrival') releaseArrival(flow, doc);
    if (doc.kind === 'production' && doc.taskId) touchFlowDocument(flow.store, doc.taskId);
    // 在库里存的那份内容上加撤销记录（不是把视图写回去）
    writeFlowDocument(
      flow.store,
      id,
      { ...storedDocument(flow.store, id), reversal: { reason: v.reason, by: actor.name, at: new Date().toISOString(), movements } },
      { status: 'reversed', at: new Date().toISOString() },
    );
    afterReverse(flow, doc);
    audit(flow.store, actor, {
      action: 'reverse',
      entity: 'flow_' + doc.kind,
      id,
      document: { before: doc, after: flow.get(id), reason: v.reason, movements },
    });
    return flow.get(id);
  });
}
