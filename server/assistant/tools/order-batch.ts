// 助手工具：订货单（order_batch.*）和它给模型看的样子、行号换行键。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { OrderBatchService } from '../../operations/index.js';
import { registerArrival } from '../../flow/index.js';
import { dateSchema, quantityText, quantityString } from '../../../shared/core/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { uuid, fail, idAndInput, positive, requireActor, type ToolContext } from './context.js';
import { planTool, readTool } from './define.js';
import { rehearse } from '../../core/index.js';
import { MAX_BATCH_PURCHASES, MAX_RECEIVE_ROWS, MAX_SCHEDULE_ENTRIES, NOTE_MAX_LENGTH, arrivalTimeSchema } from '../../../shared/business/index.js';
import type { batchProgress, batchRows } from '../../../shared/business/index.js';

const scheduleSchema = z.strictObject({
  id: positive,
  expectedVersion: positive,
  schedule: z.array(z.strictObject({ row: positive, quantity: quantityText, dueDate: dateSchema })).max(MAX_SCHEDULE_ENTRIES),
});
const receiveSchema = z.strictObject({
  id: positive.optional(),
  purchaseId: positive.optional(),
  expectedVersion: positive.optional(),
  requestId: uuid,
  date: dateSchema,
  actualTime: arrivalTimeSchema,
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
  // 拒收数量必须明确写（没有就是 0），不替用户猜全部合格；入库数量不写就等于合格数
  rows: z.array(z.strictObject({ row: positive, quantity: quantityText, rejectedQuantity: quantityText, stockedQuantity: quantityText.optional() })).min(1).max(MAX_RECEIVE_ROWS),
});

export const orderBatchTools = [
  readTool(
    {
      name: 'order_batch.draft',
      description: '看合并订货单：几张采购单要合成一份订货单导出前用，先看合并后的样子。传同一供应商的几张采购单 id，返回合并后的行（row 行号）、各单版本和默认到货安排；已在订货单里的返回整份。只读。',
      schema: z.strictObject({ purchaseIds: z.array(positive).min(1).max(MAX_BATCH_PURCHASES) }),
    },
    (ctx, v, who) => aiBatch(new OrderBatchService(ctx.store).draft(v.purchaseIds, requireActor(who))),
  ),
  readTool(
    {
      name: 'order_batch.list',
      description: '查待到货的订货单：每行还差多少、到货截止日期、是否逾期。',
      schema: z.strictObject({ supplierId: positive.optional(), purchaseId: positive.optional() }),
    },
    (ctx, v, who) => {
      requireActor(who);
      // 和到货页“待到货”同一个口径（views.openBatches：先在库里按供应商、采购单和还没到齐圈出来再组装，带到货单）
      return { batches: ctx.flow.views.openBatches(v).map(aiBatch), url: '#warehouse?arrivals=1' };
    },
  ),
  readTool(
    {
      name: 'order_batch.get',
      description: '查一份订货单的到货进度（传 id 或 purchaseId）：版本、每行订货/已到/还差、到货安排和已登记的到货单；没有返回 null。看订货单文件上写的内容用 documents.preview。',
      schema: z.strictObject({ id: positive.optional(), purchaseId: positive.optional() }),
    },
    (ctx, v, who) => {
      requireActor(who);
      const batches = new OrderBatchService(ctx.store);
      const id = v.id ?? (v.purchaseId ? batches.batchIdOf(v.purchaseId) : fail('请传订货单id或purchaseId。'));
      return id === null ? null : aiBatch(ctx.flow.views.batch(id));
    },
  ),
  planTool(
    {
      name: 'order_batch.schedule',
      risk: 'review',
      description: '改订货单的到货安排（每行可拆几段“多少在哪天前到”），不动采购单和库存。先 order_batch.get 拿 version 和 row；schedule 传改完的完整安排，空数组是全部日期待定；日期只用用户说的。',
      schema: scheduleSchema,
    },
    {
      build: buildBatchSchedule,
      commit: (ctx, plan, actor) => {
        const { id, input } = idAndInput.parse(plan.args);
        return ctx.flow.views.batch(new OrderBatchService(ctx.store).saveSchedule(id, input, actor).id);
      },
    },
  ),
  planTool(
    {
      name: 'order_batch.receive',
      risk: 'review',
      description: '登记到货：按一张供应商送货单登记到货并入库。先 order_batch.get 拿 version 和 row；rows 写实到 quantity 和拒收 rejectedQuantity（没有写 0，用户没说验收结果先问），部分入库另写入库数量 stockedQuantity。没有订货单的老采购单不传 id、改传 purchaseId。reference 是供应商送货单号，没给就不填。',
      schema: receiveSchema,
    },
    {
      build: buildBatchReceive,
      // 生成方案时还没有订货单的（a.id 为 null）：登记时在同一个事务里补建；同一个请求已经登记过就原样返回
      commit: (ctx, plan, actor) => {
        const a = receiveArgs.parse(plan.args);
        return registerArrival(ctx.store, a.id !== null ? { batchId: a.id } : { purchaseId: a.purchaseId }, a.input, actor);
      },
    },
  ),
];

/** aiBatch 读的那几行：订货单详情（单据流转的 views.batch、openBatches）和导出前的合并预览（draft）都有这些 */
type BatchRowView = ReturnType<typeof batchRows>[number];
/** 行键（key）在这里，但不给模型看 */
type BatchRowSource = Pick<BatchRowView, 'key' | 'name' | 'specification' | 'unit' | 'unitPrice' | 'orderedUnits' | 'receivedUnits' | 'remainingUnits'> & {
  purchaseNumbers?: string[];
  /** 每段到货安排：截止日期、数量、还差多少、状态 */
  schedule: Pick<BatchRowView['schedule'][number], 'dueDate' | 'quantityUnits' | 'remainingUnits' | 'state'>[];
};
/** aiBatch 读的那几列（合并预览没有编号、版本、进度和到货单，带着已有的那份订货单 batch） */
type BatchSource = {
  id?: number;
  number?: string;
  version?: number;
  orderDate?: string;
  batch?: unknown;
  supplierId: number;
  supplierName: string;
  purchases: unknown[];
  /** 到货进度（下一个截止日期可能没有） */
  progress?: Omit<ReturnType<typeof batchProgress>, 'nextDue'> & { nextDue: string | null };
  rows: BatchRowSource[];
  arrivals?: unknown;
};

/** 订货单给模型看的样子：行用 row 行号（从 1 开始），不暴露长的行键；数量写成文本。 */
export function aiBatch(b: BatchSource) {
  const q = (n: number) => quantityString(n);
  return {
    ...(b.id ? { id: b.id, number: b.number, version: b.version, orderDate: b.orderDate } : {}),
    ...(b.batch ? { batch: b.batch } : {}),
    supplierId: b.supplierId,
    supplierName: b.supplierName,
    purchases: b.purchases,
    ...(b.progress ? { state: b.progress.state, overdue: b.progress.overdue, nextDue: b.progress.nextDue } : {}),
    rows: b.rows.map((r, i) => ({
      row: i + 1,
      name: r.name,
      specification: r.specification,
      unit: r.unit,
      unitPrice: r.unitPrice,
      ordered: q(r.orderedUnits),
      received: q(r.receivedUnits),
      remaining: q(r.remainingUnits),
      ...(r.purchaseNumbers ? { purchaseNumbers: r.purchaseNumbers } : {}),
      schedule: (r.schedule || []).map((s) => ({
        dueDate: s.dueDate,
        quantity: q(s.quantityUnits),
        remaining: q(s.remainingUnits),
        state: s.state,
      })),
    })),
    ...(b.arrivals ? { arrivals: b.arrivals } : {}),
    url: '#warehouse?arrivals=1',
  };
}
/** 助手传的是行号：换成订货单里的行键，再交给和人工同一个服务。 */
function batchScheduleInput(batches: OrderBatchService, v: z.output<typeof scheduleSchema>) {
  const view = batches.view(v.id);
  const key = (n: number) => view.rows[n - 1]?.key ?? fail('订货单 ' + view.number + ' 没有第 ' + n + ' 行。');
  return {
    id: v.id,
    input: {
      expectedVersion: v.expectedVersion,
      schedule: v.schedule.map((s) => ({ rowKey: key(s.row), quantity: s.quantity, dueDate: s.dueDate })),
    },
  };
}
/** 登记到货按哪份订货单：传了订货单 id 就是它；只传采购单的，按它所在的那份，还没有订货单的执行时再补建 */
type BatchTarget = { existing: number; purchaseId?: undefined } | { existing: null; purchaseId: number };
function batchTarget(batches: OrderBatchService, v: { id?: number; purchaseId?: number }): BatchTarget {
  if (v.id) return { existing: v.id };
  if (!v.purchaseId) return fail('请传订货单id或purchaseId。');
  const existing = batches.batchIdOf(v.purchaseId);
  return existing === null ? { existing: null, purchaseId: v.purchaseId } : { existing };
}
/**
 * 按订货单登记到货：行号换成行键。已有订货单时必须带 expectedVersion（先 order_batch.get 读最新版本）。
 * 以前订的采购单没有订货单：这里只在回滚预演里补建（调用方放在 rehearse 里），正式补建放到执行时。
 * 返回的 id 为 null 表示执行时再补建。
 */
function batchReceiveInput(ctx: ToolContext, batches: OrderBatchService, v: z.output<typeof receiveSchema>, actor: Actor) {
  const target = batchTarget(batches, v);
  if (target.existing !== null && v.expectedVersion === undefined)
    fail('按订货单登记到货要带 expectedVersion：先用 order_batch.get 读这份订货单的最新 version。');
  // 订货单详情带按它登记的到货单（完整视图），卡片的“之前”给模型看的就是它
  const view = ctx.flow.views.batch(target.existing ?? batches.ensureFor(target.purchaseId, actor).id);
  const key = (n: number) => view.rows[n - 1]?.key ?? fail('订货单 ' + view.number + ' 没有第 ' + n + ' 行。');
  return {
    id: target.existing,
    purchaseId: target.purchaseId,
    view,
    input: {
      ...(v.expectedVersion !== undefined ? { expectedVersion: v.expectedVersion } : {}),
      requestId: v.requestId,
      date: v.date,
      ...(v.actualTime !== undefined ? { actualTime: v.actualTime } : {}),
      ...(v.reference ? { reference: v.reference } : {}),
      ...(v.notes ? { notes: v.notes } : {}),
      rows: v.rows.map((r) => ({
        key: key(r.row),
        quantity: r.quantity,
        rejectedQuantity: r.rejectedQuantity,
        ...(r.stockedQuantity !== undefined ? { stockedQuantity: r.stockedQuantity } : {}),
      })),
    },
  };
}

function buildBatchSchedule(ctx: ToolContext, tool: string, args: z.output<typeof scheduleSchema>, actor: Actor): ToolPlan {
  const batches = new OrderBatchService(ctx.store);
  const { id, input } = batchScheduleInput(batches, args);
  const before = aiBatch(ctx.flow.views.batch(id));
  const after = rehearse(ctx.store.db, () => ctx.flow.views.batch(batches.saveSchedule(id, input, actor).id));
  return {
    tool,
    args: { id, input },
    label: '改订货单 ' + before.number + ' 的到货安排（不动库存）',
    highRisk: false,
    before,
    after,
    warnings: [],
  };
}

function buildBatchReceive(ctx: ToolContext, tool: string, args: z.output<typeof receiveSchema>, actor: Actor): ToolPlan {
  const batches = new OrderBatchService(ctx.store);
  // 生成方案不写库：没有订货单时补建、登记到货都只在回滚预演里做
  const { id, purchaseId, input, before, after } = rehearse(ctx.store.db, () => {
    const prepared = batchReceiveInput(ctx, batches, args, actor);
    return {
      id: prepared.id,
      purchaseId: prepared.purchaseId,
      input: prepared.input,
      before: aiBatch(prepared.view),
      // 预演里订货单刚补建好：按它的版本登记
      after: registerArrival(
        ctx.store,
        { batchId: prepared.view.id },
        prepared.id === null ? { ...prepared.input, expectedVersion: prepared.view.version } : prepared.input,
        actor,
      ),
    };
  });
  return {
    tool,
    args: id === null ? { id: null, purchaseId, input } : { id, input },
    label: '按订货单 ' + before.number + ' 登记到货并入库',
    highRisk: false,
    before: id === null ? { ...before, id: undefined } : before,
    after,
    warnings:
      id === null
        ? ['这张采购单以前订的，还没有订货单；确认后先补建订货单，再登记到货。']
        : [],
  };
}

/** 登记到货的方案里存的：订货单 id 和输入；以前订的采购单还没有订货单时 id 是 null、带着采购单 id */
const receiveArgs = z.union([
  z.object({ id: positive, input: z.unknown() }),
  z.object({ id: z.null(), purchaseId: positive, input: z.unknown() }),
]);
