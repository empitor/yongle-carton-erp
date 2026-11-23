// 确认卡片动的是哪几条（card-summary.ts 用）：按工具的参数认，不看模型写的说法；再按各自的读法读出它现在的样子。
import { sales } from '../../sales/index.js';
import type { Actor } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { PurchaseReturns } from '../../flow/index.js';
import { InboxService } from '../../inbox/index.js';
import { planModule, type Obj } from '../plan-rules.js';
import { type ToolContext } from './context.js';
import type { Touched } from './card-rehearsal.js';
import { aiBatch } from './order-batch.js';
import { assistantModules } from '../../../shared/assistant/index.js';
import { recordRow, type Module } from './modules.js';
import { flowKindOf, namedModule } from './card-lines.js';
import { isRecord } from '../../../shared/core/index.js';
import { asList, field } from '../chat/result-fields.js';

export type Target = { module: string; id: number; assistant?: Module };

/** 不在修改历史那套模块里的：采购退货、收件按各自模块的服务读（接口和助手看到的样子），没有按 404 报 */
const otherReaders: Record<string, (ctx: ToolContext, id: number) => Obj> = {
  purchase_return: (ctx, id) => new PurchaseReturns(ctx.store).get(id),
  inbox: (ctx, id) => new InboxService(ctx.store).get(id),
};

/** 试执行动到的记录：客户、供应商、产品、订单、采购单按助手的模块读 */
export const asTarget = (t: Touched): Target => {
  const assistant = namedModule(t.module);
  return assistant ? { ...t, assistant } : t;
};
/**
 * 读一条记录现在的样子；不在了（删掉了、试执行里新建的回滚后不在了）就是 undefined，卡片按“没有”写（新建、删除）。
 * 只有“查不到”（404）算没有；库里的数据坏了、程序出错照常报出去，不当成没有这条、出一张说错了的卡片。
 */
export function readTarget(ctx: ToolContext, t: Target, actor: Actor) {
  try {
    return readRow(ctx, t, actor);
  } catch (e: unknown) {
    if (e instanceof AppError && e.status === 404) return undefined;
    throw e;
  }
}
function readRow(ctx: ToolContext, t: Target, actor: Actor): Obj | undefined {
  if (t.module === 'order_batch') return batchRow(ctx, t.id);
  if (flowKindOf(t.module)) return flowRow(ctx, t.id);
  if (Object.hasOwn(otherReaders, t.module)) return otherReaders[t.module](ctx, t.id);
  if (t.module === 'stock_items') return ctx.flow.views.items(true, t.id)[0];
  if (!t.assistant) return undefined;
  const row: unknown = recordRow(ctx, t.assistant, actor, true, t.id);
  return isRecord(row) ? row : undefined;
}
/** 订货单按给助手看的那个样子读（每行订购、已到、到货安排），卡片按它比；没有了由 views.batch 按 404 报 */
function batchRow(ctx: ToolContext, id: number): Obj {
  const view = ctx.flow.views.batch(id),
    batch = aiBatch(view);
  return { ...batch, rows: batch.rows.map((r, i) => ({ ...r, key: view.rows[i]?.key })) };
}
/** 单据上带上客户、供应商的名称，卡片第一行写“送货单 SH-…（客户乙）” */
function flowRow(ctx: ToolContext, id: number): Obj {
  const doc = ctx.flow.get(id);
  return {
    ...doc,
    customerName: doc.kind === 'delivery' ? doc.customerName || sales(ctx.store).customer(doc.customerId, true)?.name : undefined,
    supplierName: doc.kind === 'arrival' ? doc.supplierName || ctx.ops.supplierName(doc.supplierId, true) : undefined,
  };
}

/** 方案本身、批量归档里的每一张：按这几样认动的是哪条 */
type PlanParts = { tool?: unknown; args?: unknown; before?: unknown; after?: unknown };
/** 一条目标：编号是数字的才算（改字段、试执行只认数字编号） */
const target = (module: string, id: unknown, assistant?: Module): Target[] => (typeof id === 'number' ? [{ module, id, assistant }] : []);
const argId = (plan: PlanParts) => field(plan.args, 'id');
const inputOf = (plan: PlanParts) => field(plan.args, 'input');
const moduleOf = (plan: PlanParts) => planModule({ args: plan.args, before: plan.before, after: plan.after });
/** 档案按编号改、归档：动的是参数里那条 */
const recordTarget = (plan: PlanParts) =>
  argId(plan) ? target(moduleOf(plan), argId(plan), assistantModules.find((m) => m === field(plan.args, 'module'))) : [];
/** 按单据办事的命令：动的是那张单据（按它的种类） */
const documentTarget = (plan: PlanParts) => target(String(field(plan.before, 'kind') || moduleOf(plan)), argId(plan));
/** 订货单的两条命令：没有订货单的老采购单按采购单认 */
const batchTarget = (plan: PlanParts) =>
  argId(plan) ? target('order_batch', argId(plan)) : target('purchases', field(plan.args, 'purchaseId'), 'purchases');
const documentTools = [
  'flow.schedule',
  'flow.edit_info',
  'arrival.correct',
  'delivery.correct',
  'production.correct',
  'flow.propose_cancel',
  'flow.propose_confirmation',
  'flow.propose_reversal',
  'delivery.mark_delivered',
];
const targetsByTool: Record<string, (plan: PlanParts) => Target[]> = {
  'records.propose_save': recordTarget,
  'records.propose_lifecycle': recordTarget,
  'records.propose_batch_lifecycle': (plan) => (asList(field(plan.args, 'children')) ?? []).flatMap((c) => (isRecord(c) ? targets(c) : [])),
  'management.execute': (plan) => {
    const module = String(field(inputOf(plan), 'module'));
    return (asList(field(inputOf(plan), 'items')) ?? []).flatMap((i) => target(module, field(i, 'id'), namedModule(module)));
  },
  'inventory.propose_movement': (plan) => target('stock_items', argId(plan)),
  'purchase_return.create': (plan) => target('arrival', field(inputOf(plan), 'arrivalId')),
  'purchase_return.reverse': (plan) => target('purchase_return', argId(plan)),
  'order_batch.schedule': batchTarget,
  'order_batch.receive': batchTarget,
  'inbox.set_status': (plan) => target('inbox', argId(plan)),
  'flow.propose_production_completion': (plan) => (asList(field(inputOf(plan), 'taskIds')) ?? []).flatMap((id) => target('task', id)),
  ...Object.fromEntries(documentTools.map((tool) => [tool, documentTarget])),
};
/** 这张方案动的是哪几条（按工具的参数认，不看模型写的说法） */
export function targets(plan: PlanParts): Target[] {
  const pick = typeof plan.tool === 'string' && Object.hasOwn(targetsByTool, plan.tool) ? targetsByTool[plan.tool] : undefined;
  return pick ? pick(plan) : [];
}
