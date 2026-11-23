// 只管：records.propose_save 新建、修改记录——生成方案时试算校验，执行时交给和人工同一个保存服务（executeSave）。
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/index.js';
import { isSuperMode } from '../../core/index.js';
import { changeOrderStatus, createBusinessService } from '../../orders/index.js';
import { reviewedAssistantGrant } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { DataManagementService } from '../../admin/index.js';
import { isLocalAdministrator } from '../../core/index.js';
import { customerSchema, productSchema, orderSchema, exactPriceSchema } from '../../../shared/core/index.js';
import { purchaseSchema, statusActionFor, stockItemSchema, supplierSchema } from '../../../shared/business/index.js';
import { flowInput, type FlowKind } from '../../../shared/business/index.js';
import { legacyCents, productPricePatch } from '../../../shared/core/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { fieldList, isFields, positive, type Fields, type ToolContext } from './context.js';
import { planTool } from './define.js';
import { rehearse } from '../../core/index.js';
import { flowKindOfModule, moduleName, stockKindOf } from '../../../shared/assistant/index.js';
import { moduleSchema, type Module, type ModuleRecord, recordRow, recordVersion } from './modules.js';

/** 一次新建几条最多 20 条 */
const ITEMS_MAX = 20;
/** 改一条传 id 和 patch；新建一条传 patch；一次新建几条同类记录传 items（几种产品的生产任务、几张送货单），出一张卡片 */
const saveSchema = z
  .strictObject({
    module: moduleSchema,
    id: positive.optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    items: z.array(z.record(z.string(), z.unknown())).min(2).max(ITEMS_MAX).optional(),
  })
  .refine((v) => (v.items ? !v.patch && !v.id : !!v.patch), '改一条或新建一条传 patch；一次新建几条传 items（不带 id、patch）');
/** 方案里存的一条保存：哪个模块、哪条（新建没有）、交给保存服务的输入、改了哪些字段、改状态的原因 */
const saveArgs = z.object({
  module: moduleSchema,
  id: positive.optional(),
  input: z.record(z.string(), z.unknown()),
  fields: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
type SaveJob = { module: Module; id?: number; input: Record<string, unknown>; fields: readonly string[]; reason?: string };

export const recordSaveTools = [
  planTool({
    name: 'records.propose_save',
    description:
      '新建或修改记录：id 空是新建，patch 只写要改的字段；一次建几条同类记录（几种产品的生产任务、几张送货单）用 items，出一张卡片，不要拆成几条。字段写法先用 records.search 带 describe:true 看；查不到档案、用户给了名称规格就直接新建，没说的选填项留空。改订单、采购状态在 patch 写 status，取消带 reason；导出订货单会自动标已订货。',
    risk: 'review',
    schema: saveSchema,
  }, {
    build: buildSave,
    commit: (ctx, plan, actor, binding) => {
      const one = (a: z.output<typeof saveArgs>) => executeSave(ctx, { ...a, fields: a.fields || [] }, actor, binding);
      return plan.args.items ? { results: z.array(saveArgs).parse(plan.args.items).map(one) } : one(saveArgs.parse(plan.args));
    },
  }),
];

/** 订单、采购单现在的状态和版本（采购单比的是基础状态） */
function currentStatus(ctx: ToolContext, module: 'orders' | 'purchases', id: number) {
  if (module === 'orders') {
    const order = ctx.store.order(id, true);
    return order && { from: order.status, version: order.version };
  }
  const purchase = ctx.flow.views.purchases(true, id)[0];
  return purchase && { from: purchase.baseStatus, version: purchase.version };
}

/**
 * 订单、采购单的状态变了：改调状态动作（server/orders/order-status.ts、server/flow/stock/stock-entries.ts 的 changePurchaseStatus），
 * 和页面详情里的“确认 / 退回 / 取消 / 恢复”同一个服务函数；同时改了别的内容的，先按原状态保存内容。
 * 状态没变返回 null，照常保存。
 */
function saveStatus(ctx: ToolContext, job: SaveJob & { id: number }, actor: Actor, binding: string) {
  const { module, id, input } = job;
  if (module !== 'orders' && module !== 'purchases') return null;
  const current = currentStatus(ctx, module, id);
  if (!current || input.status === current.from) return null;
  const { from } = current,
    to = String(input.status);
  const action = statusActionFor(module, from, to);
  if (!action)
    throw new AppError(
      moduleName(module) + '现在是“' + from + '”，不能直接改成“' + to + '”。生产中、待发货、已发货由生产和送货单据推进。',
    );
  const version = job.fields.some((k) => k !== 'status')
    ? z.object({ version: z.number() }).parse(executeSave(ctx, { ...job, input: { ...input, status: from }, fields: [] }, actor, binding)).version
    : current.version;
  const statusInput = { expectedVersion: version, requestId: randomUUID(), reason: job.reason };
  return module === 'orders'
    ? changeOrderStatus(ctx.store, id, action, statusInput, actor)
    : ctx.flow.stock.changePurchaseStatus(id, action, statusInput, actor);
}

const isWritable = (m: Module): m is 'customers' | 'products' | 'orders' => m === 'customers' || m === 'products' || m === 'orders';

/** 单据：新的完工单只走登记完工；本机管理员改已有单据走数据管理；别的交给单据流转保存 */
function saveFlow(ctx: ToolContext, kind: FlowKind, job: SaveJob, actor: Actor, binding: string): unknown {
  const { id, input } = job;
  // 新的完工单只走登记完工那一个入口（不挂任务的写 untasked），这里只改已有的完工单
  if (kind === 'production' && !id) throw new AppError('登记完工用 flow.propose_production_completion，不挂生产任务的写在 untasked 里。');
  if (id && isLocalAdministrator(actor))
    return new DataManagementService(ctx.store).execute(
      {
        requestId: randomUUID(),
        module: kind,
        action: 'update',
        items: [{ id, version: input.version }],
        patch: flowInput(kind, input),
        reason: '用户通过助手修改单据',
      },
      actor,
      binding,
      'management-assistant',
    ).results[0];
  // 生产任务保存即下达（服务端），和页面上“安排生产”一样
  return ctx.flow.save(kind, input, actor, id);
}

function executeSave(ctx: ToolContext, job: SaveJob, actor: Actor, binding: string): unknown {
  const { module, id, input } = job;
  const statusChanged = id ? saveStatus(ctx, { ...job, id }, actor, binding) : null;
  if (statusChanged) return statusChanged;
  if (isWritable(module))
    return createBusinessService(ctx.store).execute(
      id ? { entity: module, action: 'update', id, input } : { entity: module, action: 'create', input },
      {
        source: 'reviewed-assistant',
        operatorId: actor.id,
        approval: reviewedAssistantGrant(actor.id),
        superAdminMode: isSuperMode(actor),
        actor,
      },
    );
  if (module === 'suppliers') return ctx.ops.saveSupplier(input, actor, id);
  if (module === 'purchases') return ctx.flow.stock.savePurchase(input, actor, id);
  const stockKind = stockKindOf(module);
  if (stockKind)
    return ctx.flow.stock.saveItem({ ...input, kind: stockKind }, actor, id);
  const kind = flowKindOfModule(module);
  if (kind) return saveFlow(ctx, kind, job, actor, binding);
  throw new AppError('此模块不允许直接修改。', 403);
}

/**
 * 一次新建几条同类记录：逐条按新建一条的同一套校验和试算出方案，合成一张卡片；确认时逐条交给同一个保存服务
 * （和页面“安排生产”窗口一次排几种产品一样，每条一张任务），整张卡片在一个事务里，有一条不成就都不建。
 */
function buildMany(ctx: ToolContext, tool: string, asked: { module: Module; items: Record<string, unknown>[] }, actor: Actor, binding: string): ToolPlan {
  const { module, items } = asked;
  const children = items.map((patch) => buildSave(ctx, tool, { module, patch }, actor, binding));
  return {
    tool,
    args: { module, items: children.map((c) => c.args) },
    label: '新建' + moduleName(module) + ' ' + children.length + ' 条',
    highRisk: children.some((c) => c.highRisk),
    before: null,
    after: children.map((c) => c.after),
    warnings: [...new Set(children.flatMap((c) => c.warnings))],
  };
}

/** 人工表单同一份参数结构（单据走 flowInput） */
const recordSchemas: Partial<Record<Module, z.ZodType<Record<string, unknown>>>> = {
  customers: customerSchema,
  products: productSchema,
  orders: orderSchema,
  suppliers: supplierSchema,
  purchases: purchaseSchema,
  raw_inventory: stockItemSchema,
  finished_inventory: stockItemSchema,
};
function parseInput(module: Module, candidate: Record<string, unknown>): Record<string, unknown> {
  const kind = flowKindOfModule(module);
  if (kind) return flowInput(kind, candidate);
  const schema = recordSchemas[module];
  if (!schema) throw new AppError('此模块不允许直接修改。', 403);
  return schema.parse(candidate);
}
/** 系统派生的字段：模型不能直接改（订单、采购单的 status 除外，走状态动作） */
const derivedFields = [
  'id',
  'version',
  'createdAt',
  'updatedAt',
  'archived',
  'quantityUnits',
  'receivedUnits',
  'receivedQuantity', 'remainingQuantity', 'remainingUnits', 'receivedAmount',
  'shippedQuantity', 'shippingProgress', 'shippingSummary', 'shippingStatus',
  'arrivalProgress', 'arrivalSummary', 'arrivalStatus', 'businessStatus',
  'balanceUnits',
  'status',
];
const withStatus = (module: Module) => module === 'orders' || module === 'purchases';
/** 订单明细只给了精确单价的，补上旧的“分” */
const withLegacyCents = (line: unknown) =>
  isFields(line) && line.unitPriceCents == null && typeof line.unitPriceExact === 'string'
    ? { ...line, unitPriceCents: legacyCents(exactPriceSchema.parse(line.unitPriceExact.trim())) }
    : line;
/** 交给表单结构核对的样子：原记录 + 改的字段，再按模块补上价格、基础状态、明细的分、库存种类 */
function candidateFor(module: Module, patch: Record<string, unknown>, before: ModuleRecord | undefined) {
  const candidate: Record<string, unknown> = {
    ...before,
    ...patch,
    // 产品改了“分”、精确价没点名或没动：旧的精确价作废，不然它会把新改的分盖掉（精确价优先）；
    // 精确价点名清空、分没动：清空价格，存成没定价（规则见 shared/core/precision.ts 的 priceEdit）
    ...(module === 'products' ? productPricePatch(patch, before && 'priceCents' in before ? before : null) : {}),
    ...(before ? { version: recordVersion(before) } : {}),
  };
  // 到货状态由明细派生；编辑备注不能把“部分到货”误送入只接受基础状态的表单契约。
  if (module === 'purchases' && before && 'baseStatus' in before && !Object.hasOwn(patch, 'status')) candidate.status = before.baseStatus;
  // 明细原样交给订单结构核对：不是对象的行（null、文字）在那里被拒收，不在这里滤掉
  if (module === 'orders' && Array.isArray(candidate.lines)) candidate.lines = candidate.lines.map(withLegacyCents);
  const stockKind = stockKindOf(module);
  if (stockKind) candidate.kind = stockKind;
  return candidate;
}
/** 改归档的、或订单已发货（有发出的明细）的，卡片标成高风险 */
function highRiskOf(module: Module, before: Fields | undefined, input: Record<string, unknown>) {
  return (
    !!before?.archived ||
    (module === 'orders' &&
      (fieldList(before?.lines).some((l) => Number(l.shippedQuantity) > 0) || before?.status === '已发货' || input.status === '已发货'))
  );
}
function warningsOf(module: Module) {
  const kind = flowKindOfModule(module);
  if (kind === 'delivery') return ['保存后是待送货，不扣库存；导出送货单或核对出库时才扣。'];
  if (kind === 'task') return ['保存后直接下达，不动库存。'];
  return kind ? ['保存后是待入库，核对入库时才加库存。'] : [];
}

function buildSave(ctx: ToolContext, tool: string, asked: z.output<typeof saveSchema>, actor: Actor, binding: string): ToolPlan {
  if (asked.items) return buildMany(ctx, tool, { module: asked.module, items: asked.items }, actor, binding);
  const { module, id } = asked;
  if (module === 'movements') throw new AppError('库存流水不可直接编辑。');
  // 订单、采购单改状态时一起给的原因（取消必填），不是记录的字段
  const { reason: rawReason, ...patch } = asked.patch ?? {},
    statusReason = withStatus(module) && typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
  if (rawReason !== undefined && !withStatus(module)) patch.reason = rawReason;
  const before = id ? recordRow(ctx, module, actor, isSuperMode(actor), id) : undefined;
  if (id && !before) throw new AppError('记录不存在或已归档。', 404);
  const candidate = candidateFor(module, patch, before);
  if (Object.keys(patch).some((k) => derivedFields.includes(k) && !(k === 'status' && withStatus(module))))
    throw new AppError('模型不能直接修改系统派生字段。');
  const parsed = parseInput(module, candidate),
    input = { ...parsed, ...(before ? { version: recordVersion(before) } : {}) },
    fields = Object.keys(patch),
    after = rehearse(ctx.store.db, () => {
      const unknown = fields.filter((k) => !Object.hasOwn(parsed, k));
      if (unknown.length)
        throw new AppError('不支持的业务字段：' + unknown.join('、') + '。产品加工要求/备注使用requirements，不能写入不存在的字段。');
      return executeSave(ctx, { module, id, input, fields, reason: statusReason }, actor, binding);
    });
  return {
    tool,
    args: { module, id, input, fields, ...(statusReason ? { reason: statusReason } : {}) },
    label: (id ? '修改' : '新建') + moduleName(module),
    highRisk: highRiskOf(module, before, input),
    before: before ?? null,
    after,
    warnings: warningsOf(module),
  };
}
