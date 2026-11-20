// 助手工具：单据流转（仓库日台账、成品批次、计划日期、改已生效单据的说明、确认送达、出入库、取消、核对、冲销、批量完工）。
// 改数量的更正在 corrections.ts。
import { RAW_UNIT } from '../../../shared/core/index.js';
import { assistantProductionCompletionSchema, dailyQuerySchema, documentInfoSchema } from '../../../shared/business/index.js';
import { ProductionCompletion } from '../../flow/index.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/index.js';
import { WarehouseDaily } from '../../flow/index.js';
import { finishedStockOfProduct, stockItemBatches, updateDocumentInfo } from '../../flow/index.js';
import { AppError } from '../../core/index.js';
import { movementSchema } from '../../../shared/business/index.js';
import { flowScheduleSchema } from '../../../shared/business/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { fail, idAndInput, objectArgs, positive, requireActor, splitId, type ToolContext, type ToolReader, type ToolWriter } from './context.js';
import { rehearse } from '../../core/index.js';
import { UNDO_REASON_MAX_LENGTH, flowDocNames } from '../../../shared/business/index.js';
import { dateSchema } from '../../../shared/core/index.js';

/** 取消、冲销的原因最多几个字和页面取消、撤销同一个上限（UNDO_REASON_MAX_LENGTH） */
const reasonSchema = z.strictObject({ id: positive, reason: z.string().min(1).max(UNDO_REASON_MAX_LENGTH) });
/** 成品批次：库存品和产品二选一 */
const PICK_ONE_STOCK = '传成品库存品stockId或产品productId其中一个';
/** 冲销卡片的标题（和界面“撤销这次××”同一套叫法） */
const reversalLabels: Record<string, string> = { delivery: '撤销这次送货', arrival: '撤销这次到货', production: '撤销完工', task: '撤销生产任务' };
/** 核对入库的方案：单据编号、请求编号；确认时带上出卡片时的预览摘要 */
const confirmationArgs = z.object({ id: positive, requestId: z.string() });
const confirmationEngine = z.object({ previewDigest: z.string() });
/** 改已生效单据的说明：服务的输入去掉版本号（出方案时按当时的版本填）加单据编号 */
const editInfoSchema = documentInfoSchema.omit({ expectedVersion: true }).extend({ id: positive });

export const flowDocTools = [
  {
    name: 'flow.daily',
    risk: 'read',
    description: '查某天的生产任务或送货、到货：当天计划、实际完成和待执行的；取消、冲销的不算待执行。',
    arguments: {
      kind: 'arrival/delivery/task',
      date: 'YYYY-MM-DD',
      doc: '到货单或送货单的编号（可不给）：只看这一张的验收入库、明细进度和流水，已归档的也读，给了就不看 date',
    },
    schema: dailyQuerySchema,
  },
  {
    name: 'delivery.mark_delivered',
    risk: 'review',
    description: '确认送货中的送货单已送达，只记送达日期，不动库存。先 records.get 或 flow.daily 拿 version；date 用用户说的，没说先问，不默认今天。',
    arguments: { id: 1, version: 1, date: 'YYYY-MM-DD，用户说的送达日期' },
    // 送达日期必填：用户说的日期，说“今天”就传今天的日期，不默认
    schema: z.strictObject({ id: positive, version: positive, date: dateSchema }),
  },
  {
    name: 'flow.schedule',
    risk: 'review',
    description: '改未完成生产任务或待送货送货单的计划日期，不改实际日期、不确认单据、不动库存。',
    arguments: { id: 1, expectedVersion: 1, plannedDate: '2026-11-02', requestId: '唯一UUID' },
    schema: flowScheduleSchema.extend({ id: positive }),
  },
  {
    name: 'inventory.batches',
    risk: 'read',
    description: '查成品库存的批次（传 stockId 或 productId）：每批完工日期、单号、入库数、估计还剩、任务/订单/客户、用料和备注。“估计还剩”按流水推算不是实盘，unmatchedUnits 不为 0 要提醒用户核对流水。已发完的默认只给最近 20 批，allDepleted=true 给全部。原材料没有批次。',
    arguments: { stockId: 1, productId: '可选，和stockId二选一', allDepleted: false },
    // 成品库存的批次：传库存品 stockId 或产品 productId 其中一个（tools.ts 里核对）
    schema: z.strictObject({ stockId: positive.optional(), productId: positive.optional(), allDepleted: z.boolean().optional() }),
  },
  {
    name: 'flow.propose_cancel',
    description:
      '取消待送货、待入库的单据，或没完工任务的剩余计划；已产生的库存和生产记录保留。必须写原因。',
    arguments: { id: '单据ID', reason: '取消原因' },
    risk: 'review',
    schema: reasonSchema,
  },
  {
    name: 'inventory.propose_movement',
    description:
      '盘点或手工出入库：盘点、手工出入库时用。quantity 用十进制字符串，notes 写原因；不能负库存，不换算单位。',
    arguments: {
      id: '库存品ID',
      action: ['in', 'out', 'adjust'],
      quantity: '数量字符串',
      date: 'YYYY-MM-DD',
      notes: '用途/原因',
    },
    risk: 'high',
    schema: z.strictObject({
      id: positive,
      action: z.enum(['in', 'out', 'adjust']),
      quantity: z.string(),
      date: z.string(),
      notes: z.string(),
    }),
  },
  {
    name: 'flow.propose_production_completion',
    description:
      '登记完工：领料、登记完工、成品入库，可一次处理几个或全部待完工任务，不挂任务的（打样、补做）写 untasked。日期和每行良品、废品数都用用户说的，没说先问，不默认全部良品或今天。共用原料传整批实际总量或 distribution。用户说先登记、稍后核对时传 pending:true，之后用 flow.propose_confirmation 核对入库。',
    arguments: {
      taskIds: '任务ID数组，与allActive二选一',
      allActive: 'true全部待完工任务',
      date: 'YYYY-MM-DD，用户说的实际完工日期',
      quantities: [{ taskId: 1, goodQuantity: '1000', scrapQuantity: '0' }],
      goodRatePct: '可省略，和实际数量一致',
      materials: [
        { stockId: '可选，原料须真实唯一匹配', unit: RAW_UNIT, issued: '547', returned: '0' },
      ],
      allocation: 'shared-proportional/explicit',
      distribution: 'explicit时必填逐任务实际材料',
      notes: '可省略，批次备注（这批用的什么料、质量怎样），原样写用户说的话',
      pending: '可省略；true只登记成待入库、稍后核对入库，不动库存',
    },
    risk: 'review',
    // 助手登记完工：完工日期和每个任务的实际产量必填，不按今天、剩余任务量默认
    schema: assistantProductionCompletionSchema,
  },
  {
    name: 'flow.propose_confirmation',
    description:
      '核对入库、核对出库：待入库的到货单或完工单核对后入库，待送货的送货单不导出直接出库（变送货中）。不能确认订单，订单用 records.propose_save 改 status。',
    arguments: { id: '单据ID' },
    risk: 'high',
    schema: z.strictObject({ id: positive }),
  },
  {
    name: 'flow.propose_reversal',
    description: '冲销已确认的单据，必须写原因，保留原件、生成反向流水；送货、到货发错或登记重了也用它（界面叫“撤销这次送货/到货”）。只是数量登记错了用对应的更正命令。',
    arguments: { id: '单据ID', reason: '原因' },
    risk: 'high',
    schema: reasonSchema,
  },
  {
    name: 'flow.edit_info',
    risk: 'review',
    description:
      '编辑单据说明：已生效的到货单、送货单、完工单只改备注（完工单的备注就是批次备注）、实际时间、送货地址联系人电话、操作人时用，不动库存和金额，不出替代单（数量错了用对应的更正）。id 是单据编号（批次用 inventory.batches 的 documentId）；只传要改的项，备注传改完的全文，空字符串是清空。',
    arguments: { id: 1, notes: '用户的原话' },
    schema: editInfoSchema,
  },
];

function stockBatches(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  requireActor(who);
  const v = z
    .strictObject({ stockId: positive.optional(), productId: positive.optional(), allDepleted: z.boolean().optional() })
    .refine((x) => !!x.stockId !== !!x.productId, PICK_ONE_STOCK)
    .parse(raw ?? {});
  // 结构上的检查保证二者有一个；和人工接口同一份数据（server/flow/stock-batches.ts），不另写查询
  const stockId = v.stockId ?? (v.productId ? finishedStockOfProduct(ctx.store, v.productId) : fail(PICK_ONE_STOCK));
  return stockItemBatches(ctx.store, stockId, { allDepleted: v.allDepleted });
}

export const flowDocReaders: Record<string, ToolReader> = {
  'flow.daily': (ctx, raw, who) => { requireActor(who); return new WarehouseDaily(ctx.store).get(raw); },
  'inventory.batches': stockBatches,
};

function buildMarkDelivered(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const { id: docId, rest: input } = splitId(raw),
    before = ctx.flow.get(docId);
  if (before.kind !== 'delivery') throw new AppError('请选择送货单。');
  // 已经确认送达：服务本身幂等，直接返回原来的送达结果，不报错、不改日期
  if (before.deliveredAt)
    return {
      tool,
      args: { id: docId, input },
      label: '送货单 ' + before.number + ' 已经确认送达（' + before.deliveredAt + '），没有重复确认',
      highRisk: false,
      before,
      after: before,
      warnings: [],
    };
  // 送达日期是要人确认的业务日期：用户说了才传，不悄悄默认今天
  if (!input.date)
    throw new AppError(
      '送达日期要用用户说的日期（用户说“今天”就传今天的日期 YYYY-MM-DD）；用户没说就先问用户哪天送到的，不要默认今天。',
    );
  const after = rehearse(ctx.store.db, () => ctx.flow.markDelivered(docId, input, actor));
  return {
    tool,
    args: { id: docId, input },
    label: '确认送货单 ' + before.number + ' 已送达（不动库存）',
    highRisk: false,
    before,
    after,
    warnings: [],
  };
}

function buildFlowSchedule(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const { id, rest } = splitId(raw);
  const input = flowScheduleSchema.parse(rest);
  const after = rehearse(ctx.store.db, () => ctx.flow.schedule(id, input, actor));
  return { tool, args: { id, input }, label: '调整计划日期', highRisk: false, before: ctx.flow.get(id), after, warnings: [] };
}

/** 卡片上逐项列改前改后（card-summary.ts 按同一个服务试一遍）；方案记下当时的版本号，确认时单据变了就拒绝，不盖掉别人刚改的 */
function buildEditInfo(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const { id, ...patch } = editInfoSchema.parse(raw),
    before = ctx.flow.get(id);
  const input = documentInfoSchema.parse({ ...patch, expectedVersion: before.version }),
    after = rehearse(ctx.store.db, () => updateDocumentInfo(ctx.store, id, input, actor));
  return {
    tool,
    args: { id, input },
    label: '编辑' + flowDocNames[before.kind] + '的说明（不动库存和金额）',
    highRisk: false,
    before,
    after,
    warnings: [],
  };
}

function buildProductionCompletion(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  // 完工日期和实际产量都必须是用户说的：缺了就让模型问用户，不按今天、剩余任务量默认
  const given = objectArgs.parse(raw);
  const input = assistantProductionCompletionSchema.parse({
    ...given,
    requestId: given.requestId || randomUUID(),
  });
  const before = { tasks: ctx.flow.list('task'), stock: ctx.ops.repo.items() };
  const after = rehearse(ctx.store.db, () =>
    new ProductionCompletion(ctx.store, { requireFacts: true }).execute(input, actor),
  );
  return {
    tool,
    args: { input },
    // 卡片出的时候还没执行：标题写要做什么，不用执行结果那句“已……”
    label: (after.pending ? '登记完工（待核对入库）：' : '登记完工并入库：') + after.results.length + ' 张完工单',
    highRisk: false,
    before,
    after,
    warnings: [after.allocationBasis],
  };
}

/** 取消、撤销一张单据：按编号读出单据，带它的版本和原因演一遍（run 是 ctx.flow 的 cancel 或 reverse） */
function rehearseUndo<T>(ctx: ToolContext, raw: unknown, run: (id: number, input: object) => T) {
  const v = z
      .strictObject({ id: positive, reason: z.string().trim().min(1).max(UNDO_REASON_MAX_LENGTH) })
      .parse(raw),
    before = ctx.flow.get(v.id),
    input = { version: before.version, reason: v.reason, acknowledged: true },
    after = rehearse(ctx.store.db, () => run(v.id, input));
  return { before, after, args: { id: v.id, input } };
}

function buildCancel(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const { before, after, args } = rehearseUndo(ctx, raw, (id, input) => ctx.flow.cancel(id, input, actor));
  return {
    tool,
    args,
    label: before.kind === 'task' ? '取消生产任务的剩余计划' : '取消' + flowDocNames[before.kind as keyof typeof flowDocNames],
    highRisk: false,
    before,
    after,
    warnings: ['已确认的库存和生产历史保留。'],
  };
}

function buildConfirmation(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const { id } = z.strictObject({ id: positive }).parse(raw),
    before = ctx.flow.get(id);
  const highRisk = before.kind !== 'task';
  const engine = ctx.flow.preview(id, actor);
  return {
    tool,
    args: { id, requestId: randomUUID() },
    // 和界面按钮同一个名字（界面规范的词表）：送货单是“不导出直接出库”，到货、完工是“核对入库”
    label: before.kind === 'delivery' ? '不导出直接出库' : before.kind === 'task' ? '下达生产任务' : '核对入库',
    highRisk,
    before,
    after: engine,
    warnings: engine.warnings,
    engine: { previewDigest: engine.previewDigest },
  };
}

function buildMovement(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const v = splitId(raw),
    before = ctx.ops.repo.items(false, v.id)[0];
  if (!before) throw new AppError('库存品不存在。');
  const input = movementSchema.parse({
      ...v.rest,
      expectedVersion: before.version,
      requestId: randomUUID(),
      acknowledged: true,
    }),
    after = rehearse(ctx.store.db, () => ctx.ops.move(v.id, input, actor));
  return {
    tool,
    args: { id: v.id, input },
    label: input.action === 'adjust' ? '盘点调整' : input.action === 'in' ? '手工入库' : '手工出库',
    highRisk: true,
    before,
    after,
    warnings: ['会改变实际库存，记一笔出入库流水，以后不能改；不换算单位。'],
  };
}

function buildReversal(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const { before, after, args } = rehearseUndo(ctx, raw, (id, input) => ctx.flow.reverse(id, input, actor));
  return {
    tool,
    args,
    label: reversalLabels[before.kind] ?? '撤销',
    highRisk: true,
    before,
    after,
    warnings: ['原单据和原因保留，库存按原数量反向记一笔。'],
  };
}

export const flowDocWriters: Record<string, ToolWriter> = {
  'flow.schedule': {
    build: buildFlowSchedule,
    commit: (ctx, plan, actor) => {
      const { id, input } = idAndInput.parse(plan.args);
      return ctx.flow.schedule(id, input, actor);
    },
  },
  'flow.edit_info': {
    build: buildEditInfo,
    commit: (ctx, plan, actor) => {
      const { id, input } = idAndInput.parse(plan.args);
      return updateDocumentInfo(ctx.store, id, input, actor);
    },
  },
  'delivery.mark_delivered': {
    build: buildMarkDelivered,
    commit: (ctx, plan, actor) => {
      const { id, input } = idAndInput.parse(plan.args);
      return ctx.flow.markDelivered(id, input, actor);
    },
  },
  'flow.propose_production_completion': {
    build: buildProductionCompletion,
    commit: (ctx, plan, actor) =>
      new ProductionCompletion(ctx.store, { requireFacts: true }).execute(z.object({ input: z.unknown() }).parse(plan.args).input, actor),
    stamp: (ctx) => {
      return {
        tasks: ctx.flow.list('task'),
        productions: ctx.flow.list('production'),
        items: ctx.ops.repo.items(),
        products: ctx.store.products(),
      };
    },
  },
  'inventory.propose_movement': {
    build: buildMovement,
    commit: (ctx, plan, actor) => {
      const { id, input } = idAndInput.parse(plan.args);
      return ctx.ops.move(id, input, actor);
    },
  },
  'flow.propose_cancel': {
    build: buildCancel,
    commit: (ctx, plan, actor) => {
      const { id, input } = idAndInput.parse(plan.args);
      return ctx.flow.cancel(id, input, actor);
    },
  },
  'flow.propose_confirmation': {
    build: buildConfirmation,
    commit: (ctx, plan, actor) => {
      const a = confirmationArgs.parse(plan.args);
      return ctx.flow.confirm(
        a.id,
        { previewDigest: confirmationEngine.parse(plan.engine).previewDigest, requestId: a.requestId, acknowledged: true },
        actor,
      );
    },
  },
  'flow.propose_reversal': {
    build: buildReversal,
    commit: (ctx, plan, actor) => {
      const { id, input } = idAndInput.parse(plan.args);
      return ctx.flow.reverse(id, input, actor);
    },
  },
};
