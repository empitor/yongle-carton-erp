// 只管：单据流转写工具的参数结构和生成方案（送达、计划日期、改说明、登记完工、取消、核对、出入库、冲销）。
// 定义、只读工具和确认后的执行在 flow-docs.ts；改数量的更正在 corrections.ts。
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/index.js';
import { AppError, rehearse } from '../../core/index.js';
import { dateSchema } from '../../../shared/core/index.js';
import {
  UNDO_REASON_MAX_LENGTH,
  assistantProductionCompletionSchema,
  documentInfoSchema,
  flowDocNames,
  flowScheduleSchema,
  movementSchema,
} from '../../../shared/business/index.js';
import { ProductionCompletion, updateDocumentInfo } from '../../flow/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { positive, type ToolContext } from './context.js';

/** 取消、冲销的原因最多几个字和页面取消、撤销同一个上限（UNDO_REASON_MAX_LENGTH） */
export const reasonSchema = z.strictObject({ id: positive, reason: z.string().trim().min(1).max(UNDO_REASON_MAX_LENGTH) });
/** 送达日期必填：用户说的日期，说“今天”就传今天的日期，不默认 */
export const markDeliveredSchema = z.strictObject({ id: positive, version: positive, date: dateSchema });
export const scheduleSchema = flowScheduleSchema.extend({ id: positive });
/** 改已生效单据的说明：服务的输入去掉版本号（出方案时按当时的版本填）加单据编号 */
export const editInfoSchema = documentInfoSchema.omit({ expectedVersion: true }).extend({ id: positive });
/** 盘点、手工出入库：和人工出入库同一份写法，版本、请求编号出方案时补 */
export const movementToolSchema = movementSchema.pick({ action: true, quantity: true, date: true, notes: true }).extend({ id: positive });
export const confirmationSchema = z.strictObject({ id: positive });
/** 冲销卡片的标题（和界面“撤销这次××”同一套叫法） */
const reversalLabels: Record<string, string> = { delivery: '撤销这次送货', arrival: '撤销这次到货', production: '撤销完工', task: '撤销生产任务' };

export function buildMarkDelivered(ctx: ToolContext, tool: string, args: z.output<typeof markDeliveredSchema>, actor: Actor): ToolPlan {
  const { id: docId, ...input } = args,
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

export function buildFlowSchedule(ctx: ToolContext, tool: string, { id, ...input }: z.output<typeof scheduleSchema>, actor: Actor): ToolPlan {
  const after = rehearse(ctx.store.db, () => ctx.flow.schedule(id, input, actor));
  return { tool, args: { id, input }, label: '调整计划日期', highRisk: false, before: ctx.flow.get(id), after, warnings: [] };
}

/** 卡片上逐项列改前改后（card-summary.ts 按同一个服务试一遍）；方案记下当时的版本号，确认时单据变了就拒绝，不盖掉别人刚改的 */
export function buildEditInfo(ctx: ToolContext, tool: string, { id, ...patch }: z.output<typeof editInfoSchema>, actor: Actor): ToolPlan {
  const before = ctx.flow.get(id);
  const input = { ...patch, expectedVersion: before.version },
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

export function buildProductionCompletion(
  ctx: ToolContext,
  tool: string,
  args: z.output<typeof assistantProductionCompletionSchema>,
  actor: Actor,
): ToolPlan {
  // 完工日期和实际产量都必须是用户说的（结构里必填），不按今天、剩余任务量默认；请求编号没给就补一个
  const input = { ...args, requestId: args.requestId || randomUUID() };
  const before = { tasks: ctx.flow.list('task'), stock: ctx.flow.views.items() };
  const after = rehearse(ctx.store.db, () => new ProductionCompletion(ctx.store, { requireFacts: true }).execute(input, actor));
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
function rehearseUndo<T>(ctx: ToolContext, v: z.output<typeof reasonSchema>, run: (id: number, input: object) => T) {
  const before = ctx.flow.get(v.id),
    input = { version: before.version, reason: v.reason, acknowledged: true },
    after = rehearse(ctx.store.db, () => run(v.id, input));
  return { before, after, args: { id: v.id, input } };
}

export function buildCancel(ctx: ToolContext, tool: string, v: z.output<typeof reasonSchema>, actor: Actor): ToolPlan {
  const { before, after, args } = rehearseUndo(ctx, v, (id, input) => ctx.flow.cancel(id, input, actor));
  return {
    tool,
    args,
    label: before.kind === 'task' ? '取消生产任务的剩余计划' : '取消' + flowDocNames[before.kind],
    highRisk: false,
    before,
    after,
    warnings: ['已确认的库存和生产历史保留。'],
  };
}

export function buildConfirmation(ctx: ToolContext, tool: string, { id }: z.output<typeof confirmationSchema>, actor: Actor): ToolPlan {
  const before = ctx.flow.get(id);
  const engine = ctx.flow.preview(id, actor);
  return {
    tool,
    args: { id, requestId: randomUUID() },
    // 和界面按钮同一个名字（界面规范的词表）：送货单是“不导出直接出库”，到货、完工是“核对入库”
    label: before.kind === 'delivery' ? '不导出直接出库' : before.kind === 'task' ? '下达生产任务' : '核对入库',
    highRisk: before.kind !== 'task',
    before,
    after: engine,
    warnings: engine.warnings,
    engine: { previewDigest: engine.previewDigest },
  };
}

export function buildMovement(ctx: ToolContext, tool: string, { id, ...rest }: z.output<typeof movementToolSchema>, actor: Actor): ToolPlan {
  const before = ctx.flow.views.items(false, id)[0];
  if (!before) throw new AppError('库存品不存在。');
  const input = { ...rest, expectedVersion: before.version, requestId: randomUUID(), acknowledged: true as const },
    after = rehearse(ctx.store.db, () => ctx.flow.stock.move(id, input, actor));
  return {
    tool,
    args: { id, input },
    label: input.action === 'adjust' ? '盘点调整' : input.action === 'in' ? '手工入库' : '手工出库',
    highRisk: true,
    before,
    after,
    warnings: ['会改变实际库存，记一笔出入库流水，以后不能改；不换算单位。'],
  };
}

export function buildReversal(ctx: ToolContext, tool: string, v: z.output<typeof reasonSchema>, actor: Actor): ToolPlan {
  const { before, after, args } = rehearseUndo(ctx, v, (id, input) => ctx.flow.reverse(id, input, actor));
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
