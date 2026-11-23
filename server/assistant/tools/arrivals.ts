// 助手工具：到货记录、采购退货。登记到货是订货单的 order_batch.receive（order-batch.ts），
// 更正到货单在 corrections.ts，改已入库到货单的备注和时间是 flow.edit_info（flow-docs.ts）。
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/index.js';
import { AppError, requireSuperModeFor } from '../../core/index.js';
import { pageHref } from '../../../shared/core/index.js';
import { arrivalQuerySchema } from '../../../shared/business/index.js';
import { PurchaseReturns } from '../../flow/index.js';
import { purchaseReturnSchema, returnReversalSchema } from '../../../shared/business/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { idAndInput, uuid, positive, requireActor, type ToolContext } from './context.js';
import { planTool, readTool } from './define.js';
import { rehearse } from '../../core/index.js';

/** 撤销退货：原因的写法和页面撤销退货同一份（returnReversalSchema） */
const reversalSchema = z.strictObject({
  id: positive,
  version: positive,
  reason: returnReversalSchema.shape.reason,
});
/** 方案里存的退货输入：确认后执行和数据版本只用到它的到货单编号，其余交给退货服务核对 */
const returnArgs = z.object({ input: z.looseObject({ arrivalId: positive }) });

const returnSchema = purchaseReturnSchema.extend({ requestId: uuid.optional() });

export const arrivalTools = [
  readTool(
    {
      name: 'arrival.records',
      description: '查到货记录（已登记的正式到货单）：采购逐行累计和剩余、合格/拒收/入库、库存流水、更正链和待核对差异。',
      schema: arrivalQuerySchema,
    },
    (ctx, v, who) => {
      requireActor(who);
      return { records: ctx.flow.arrivalRecords(v), url: pageHref('warehouse', { arrivals: true }) };
    },
  ),
  readTool(
    {
      name: 'purchase_return.returnable',
      description: '查能退多少：采购退货前用，看一张到货单每行（lineIndex）还能退多少，以及已有的退货单。arrivalId 是 arrival.records 的 flowId 或 records.get arrivals 的 id。',
      schema: z.strictObject({ arrivalId: positive }),
    },
    (ctx, v, who) => {
      requireActor(who);
      return returnable(ctx, v.arrivalId);
    },
  ),
  planTool(
    {
      name: 'purchase_return.create',
      risk: 'review',
      description: '对已入库的到货单登记采购退货：扣库存、冲减采购已到货，不记金额（以供应商发票为准）。先 purchase_return.returnable 看 lineIndex 和可退数；date、reason 用用户说的，没说先问；纸板按整张。出确认卡片，回复说待确认。',
      schema: returnSchema,
    },
    {
      build: buildReturn,
      commit: (ctx, plan, actor) => new PurchaseReturns(ctx.store).create(actor, returnArgs.parse(plan.args).input),
      // 采购退货要等人点卡片：只绑定这张到货单的可退数量和这张退货单的版本，别处库存在动不让卡片失效。
      // 退货服务自己还会核对可退数量、版本和请求凭据。
      stamp: (ctx, plan) => {
        const returns = new PurchaseReturns(ctx.store),
          arrivalId = returnArgs.parse(plan.args).input.arrivalId;
        return {
          lines: returns.returnable(arrivalId).lines,
          returns: returns.list(arrivalId).map((r) => [r.id, r.status, r.version]),
        };
      },
    },
  ),
  planTool(
    {
      name: 'purchase_return.reverse',
      risk: 'review',
      description: '撤销一张采购退货：库存和采购已到货加回，退货单保留。先 purchase_return.returnable 拿退货单 id 和 version，reason 写用户说的原因。出确认卡片，回复说待确认。',
      schema: reversalSchema,
    },
    {
      build: buildReturnReversal,
      commit: (ctx, plan, actor) => {
        const { id, input } = idAndInput.parse(plan.args);
        return new PurchaseReturns(ctx.store).reverse(actor, id, input);
      },
      stamp: (ctx, plan) => {
        // 绑定这张退货单的状态和版本；退货单已经不在了是 null（和出卡片时不同，卡片按数据变了作废）
        const r = returnOrMissing(ctx, idAndInput.parse(plan.args).id);
        return r ? { id: r.id, arrivalId: r.arrivalId, status: r.status, version: r.version } : null;
      },
    },
  ),
];

function returnable(ctx: ToolContext, arrivalId: number) {
  const returns = new PurchaseReturns(ctx.store),
    r = returns.returnable(arrivalId);
  return {
    arrivalId,
    arrivalNumber: String(r.arrival.number),
    arrivalDate: String(r.arrival.date),
    supplierName: r.doc.supplierName || '',
    // 已核对入库、没撤销、没被更正替代的到货单才能退
    canReturn: r.effective,
    lines: r.lines,
    returns: returns.list(arrivalId).map((x) => ({
      id: x.id,
      number: x.number,
      date: x.date,
      status: x.status === 'reversed' ? '已撤销' : '有效',
      version: x.version,
      reason: x.reason,
      lines: x.lines,
    })),
    url: pageHref('warehouse', { arrivals: true }),
  };
}

function buildReturn(ctx: ToolContext, tool: string, args: z.output<typeof returnSchema>, actor: Actor): ToolPlan {
  // 和人工同一个服务、同一个请求凭据幂等；方案阶段只在回滚预演里试一遍
  const input = { ...args, requestId: args.requestId || randomUUID() };
  const returns = new PurchaseReturns(ctx.store),
    before = returnable(ctx, input.arrivalId),
    after = rehearse(ctx.store.db, () => returns.create(actor, input));
  return {
    tool,
    args: { input },
    label:
      '采购退货：到货单 ' +
      before.arrivalNumber +
      ' 退 ' +
      after.lines.map((l) => l.name + ' ' + l.quantity + ' ' + l.unit).join('、'),
    highRisk: true,
    before,
    after,
    warnings: ['会扣减库存、冲减采购单的已到货；金额以供应商到票或红字发票为准。'],
  };
}

function buildReturnReversal(ctx: ToolContext, tool: string, v: z.output<typeof reversalSchema>, actor: Actor): ToolPlan {
  // 和人工“撤销退货”一样要超级管理员模式；生成方案时就说明，不出必然失败的卡片。
  // 进不了这个模式的账号直接说没有权限，和页面同一句（server/flow/returns.ts 的 reverse）
  requireSuperModeFor(actor, '撤销采购退货');
  // 按主键读这张退货单（查不到 404），卡片上只列这几项
  const returns = new PurchaseReturns(ctx.store),
    found = returns.get(v.id),
    before = {
      id: found.id,
      number: found.number,
      arrivalId: found.arrivalId,
      date: found.date,
      status: found.status,
      version: found.version,
      reason: found.reason,
      lines: found.lines,
    },
    input = { version: v.version, reason: v.reason },
    after = rehearse(ctx.store.db, () => returns.reverse(actor, v.id, input));
  return {
    tool,
    args: { id: v.id, input },
    label: '撤销采购退货 ' + (before.number || v.id),
    highRisk: true,
    before,
    after,
    warnings: ['库存和采购单已到货加回，原退货单和原因保留。'],
  };
}

/** 按编号读一张退货单；不在了（找不到）是 undefined，别的错误照常往上抛 */
function returnOrMissing(ctx: ToolContext, id: number) {
  try {
    return new PurchaseReturns(ctx.store).get(id);
  } catch (e: unknown) {
    if (e instanceof AppError && e.status === 404) return undefined;
    throw e;
  }
}
