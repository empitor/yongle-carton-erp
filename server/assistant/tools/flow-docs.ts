// 助手工具：单据流转（仓库日台账、成品批次、计划日期、改已生效单据的说明、确认送达、出入库、取消、核对、冲销、批量完工）的定义、
// 只读工具和确认后的执行。生成方案在 flow-doc-plans.ts；改数量的更正在 corrections.ts。
import { sales } from '../../sales/index.js';
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { assistantProductionCompletionSchema, dailyQuerySchema } from '../../../shared/business/index.js';
import { ProductionCompletion, WarehouseDaily, finishedStockOfProduct, stockItemBatches, updateDocumentInfo } from '../../flow/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { fail, idAndInput, positive, requireActor, type ToolContext } from './context.js';
import { planTool, readTool } from './define.js';
import {
  buildCancel,
  buildConfirmation,
  buildEditInfo,
  buildFlowSchedule,
  buildMarkDelivered,
  buildMovement,
  buildProductionCompletion,
  buildReversal,
  confirmationSchema,
  editInfoSchema,
  markDeliveredSchema,
  movementToolSchema,
  reasonSchema,
  scheduleSchema,
} from './flow-doc-plans.js';

/** 成品批次：库存品和产品二选一 */
const PICK_ONE_STOCK = '传成品库存品stockId或产品productId其中一个';
/** 核对入库的方案：单据编号、请求编号；确认时带上出卡片时的预览摘要 */
const confirmationArgs = z.object({ id: positive, requestId: z.string() });
const confirmationEngine = z.object({ previewDigest: z.string() });
/** 确认后执行：方案里存的“哪张单据 + 交给服务的输入”交给对应的服务（输入仍由服务自己核对） */
const byId =
  (run: (ctx: ToolContext, id: number, input: unknown, actor: Actor) => unknown) => (ctx: ToolContext, plan: ToolPlan, actor: Actor) => {
    const { id, input } = idAndInput.parse(plan.args);
    return run(ctx, id, input, actor);
  };

export const flowDocTools = [
  readTool(
    {
      name: 'flow.daily',
      description: '查某天的生产任务或送货、到货：当天计划、实际完成和待执行的；取消、冲销的不算待执行。',
      schema: dailyQuerySchema,
    },
    (ctx, v, who) => {
      requireActor(who);
      return new WarehouseDaily(ctx.store).get(v);
    },
  ),
  planTool(
    {
      name: 'delivery.mark_delivered',
      risk: 'review',
      description: '确认送货中的送货单已送达，只记送达日期，不动库存。先 records.get 或 flow.daily 拿 version；date 用用户说的，没说先问，不默认今天。',
      schema: markDeliveredSchema,
    },
    { build: buildMarkDelivered, commit: byId((ctx, id, input, actor) => ctx.flow.markDelivered(id, input, actor)) },
  ),
  planTool(
    {
      name: 'flow.schedule',
      risk: 'review',
      description: '改未完成生产任务或待送货送货单的计划日期，不改实际日期、不确认单据、不动库存。',
      schema: scheduleSchema,
    },
    { build: buildFlowSchedule, commit: byId((ctx, id, input, actor) => ctx.flow.schedule(id, input, actor)) },
  ),
  readTool(
    {
      name: 'inventory.batches',
      description:
        '查成品库存的批次（传 stockId 或 productId）：每批完工日期、单号、入库数、估计还剩、任务/订单/客户、用料和备注。“估计还剩”按流水推算不是实盘，unmatchedUnits 不为 0 要提醒用户核对流水。已发完的默认只给最近 20 批，allDepleted=true 给全部。原材料没有批次。',
      schema: z
        .strictObject({ stockId: positive.optional(), productId: positive.optional(), allDepleted: z.boolean().optional() })
        .refine((x) => !!x.stockId !== !!x.productId, PICK_ONE_STOCK),
    },
    (ctx, v, who) => {
      requireActor(who);
      // 结构上的检查保证二者有一个；和人工接口同一份数据（server/flow/stock-batches.ts），不另写查询
      const stockId = v.stockId ?? (v.productId ? finishedStockOfProduct(ctx.store, v.productId) : fail(PICK_ONE_STOCK));
      return stockItemBatches(ctx.store, stockId, { allDepleted: v.allDepleted });
    },
  ),
  planTool(
    {
      name: 'flow.propose_cancel',
      description: '取消待送货、待入库的单据，或没完工任务的剩余计划；已产生的库存和生产记录保留。必须写原因。',
      risk: 'review',
      schema: reasonSchema,
    },
    { build: buildCancel, commit: byId((ctx, id, input, actor) => ctx.flow.cancel(id, input, actor)) },
  ),
  planTool(
    {
      name: 'inventory.propose_movement',
      description: '盘点或手工出入库：盘点、手工出入库时用。quantity 用十进制字符串，notes 写原因；不能负库存，不换算单位。',
      risk: 'high',
      schema: movementToolSchema,
    },
    { build: buildMovement, commit: byId((ctx, id, input, actor) => ctx.flow.stock.move(id, input, actor)) },
  ),
  planTool(
    {
      name: 'flow.propose_production_completion',
      description:
        '登记完工：领料、登记完工、成品入库，可一次处理几个或全部待完工任务，不挂任务的（打样、补做）写 untasked。日期和每行良品、废品数都用用户说的，没说先问，不默认全部良品或今天。共用原料传整批实际总量或 distribution。用户说先登记、稍后核对时传 pending:true，之后用 flow.propose_confirmation 核对入库。',
      risk: 'review',
      // 助手登记完工：完工日期和每个任务的实际产量必填，不按今天、剩余任务量默认
      schema: assistantProductionCompletionSchema,
    },
    {
      build: buildProductionCompletion,
      commit: (ctx, plan, actor) =>
        new ProductionCompletion(ctx.store, { requireFacts: true }).execute(z.object({ input: z.unknown() }).parse(plan.args).input, actor),
      stamp: (ctx) => ({
        tasks: ctx.flow.list('task'),
        productions: ctx.flow.list('production'),
        items: ctx.flow.views.items(),
        products: sales(ctx.store).products(),
      }),
    },
  ),
  planTool(
    {
      name: 'flow.propose_confirmation',
      description:
        '核对入库、核对出库：待入库的到货单或完工单核对后入库，待送货的送货单不导出直接出库（变送货中）。不能确认订单，订单用 records.propose_save 改 status。',
      risk: 'high',
      schema: confirmationSchema,
    },
    {
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
  ),
  planTool(
    {
      name: 'flow.propose_reversal',
      description:
        '冲销已确认的单据，必须写原因，保留原件、生成反向流水；送货、到货发错或登记重了也用它（界面叫“撤销这次送货/到货”）。只是数量登记错了用对应的更正命令。',
      risk: 'high',
      schema: reasonSchema,
    },
    { build: buildReversal, commit: byId((ctx, id, input, actor) => ctx.flow.reverse(id, input, actor)) },
  ),
  planTool(
    {
      name: 'flow.edit_info',
      risk: 'review',
      description:
        '编辑单据说明：已生效的到货单、送货单、完工单只改备注（完工单的备注就是批次备注）、实际时间、送货地址联系人电话、操作人时用，不动库存和金额，不出替代单（数量错了用对应的更正）。id 是单据编号（批次用 inventory.batches 的 documentId）；只传要改的项，备注传改完的全文，空字符串是清空。',
      schema: editInfoSchema,
    },
    { build: buildEditInfo, commit: byId((ctx, id, input, actor) => updateDocumentInfo(ctx.store, id, input, actor)) },
  ),
];
