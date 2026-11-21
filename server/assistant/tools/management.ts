// 助手工具：本机数据管理（删除预览、记录上下文、一键清空、数据管理命令）。删除本身是 records.delete（records-lifecycle.ts）。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { manageWorkspaces, DataManagementService } from '../../admin/index.js';
import { assistantManagementSchema } from '../../../shared/assistant/index.js';
import { withDimensionConversion } from '../management-dimensions.js';
import { requireLocalAdministrator } from '../../core/index.js';
import { recordContext } from '../../business/index.js';
import { deletionSelection } from '../../../shared/business/index.js';
import { DatabaseMaintenanceService } from '../../lifecycle/index.js';
import { BusinessReset } from '../../admin/index.js';
import { businessResetSchema, workspaceCommandSchema } from '../../../shared/admin/index.js';
import { importStateLabel, type ImportWorkspaceView } from '../../../shared/import/index.js';
import { dataManagementModules, dataManagementNames } from '../../../shared/business/index.js';
import { WORKSPACE_DELETES, type ToolPlan } from '../plan-rules.js';
import { notConnected, requireLocalOrSuperAdmin, uuid, positive, type ToolContext, type ToolReader, type ToolWriter } from './context.js';
import { rehearse } from '../../core/index.js';

/** 给模型看的写法：版本可以不带（出卡片时补上当时的版本），其余和 workspaceCommandSchema 一样 */
const workspaceToolSchema = z.strictObject(workspaceCommandSchema.shape);
export const managementTools = [
  {
    name: 'management.delete_preview',
    description:
      '查删除影响：物理删除前用，看要级联删除的、要解除引用的、库存怎么处理。已确认、有库存的也能删；涉及别的独立记录时先把清单给用户看。',
    arguments: {
      module: '与management.execute相同',
      items: [{ id: 1, version: 1 }],
      inventoryPolicy: '默认recalculate：库存一起改回（删掉被删单据的出入库流水并重算，改回会变负数时删不了）；preserve：库存数量不动，只删单子，流水改成“系统维护”流水。没动过库存的单据不用传',
    },
    risk: 'read',
    schema: deletionSelection,
  },
  {
    name: 'management.workspaces',
    description:
      '管理 AI 识别的原件、任务和识别结果工作区：list 列出，open 打开，fork 复制成独立任务，archive 归档，restore 恢复归档，delete 真正删除（要删就用 delete，不用 archive 代替）。修改要新 requestId；版本可以不填，卡片按当时的版本，确认前被别人改过就拒绝。不会重新识别或收费。',
    arguments: {
      action: 'list/open/fork/delete/archive/restore',
      requestId: '修改时必填UUID',
      items: [{ id: '工作区UUID', revision: '可省略，按出卡片时的版本' }],
    },
    risk: 'workflow',
    schema: z.union([
      z.strictObject({ action: z.literal('list'), requestId: uuid.optional() }),
      workspaceToolSchema,
    ]),
  },
  {
    name: 'management.execute',
    description:
      '通用改数据：专门的工具做不了时用：一次改多条（items 列出编号和版本，patches 按编号给各自的改动）、改产品或库存品的尺寸单位（dimensionPolicy）。先 management.context 查影响；删除用 records.delete。要建几条互相引用的记录，一条建完拿到编号再建下一条。',
    arguments: {
      module: 'customers/products/orders/suppliers/purchases/stock_items/arrival/task/production/delivery',
      action: 'create/update/archive/restore/confirm/reverse/cancel',
      items: [{ id: 1, version: 1 }],
      patch: {},
      requestId: 'UUID',
      reason: '用户操作原因',
    },
    risk: 'review',
    schema: assistantManagementSchema,
  },
  {
    name: 'management.reset',
    description:
      '一键清空：用户明确要清空全部数据时用，调用一次，不要逐条删。business 清业务数据，ai-imports 清 AI 识别工作区和失败记录，all 都清；账号、审计和 AI 配置保留，不可恢复。出确认卡片，回复说待确认。',
    arguments: {
      scope: 'business/ai-imports/all，默认all',
      reason: '用户要求初始化的原因（可选）',
    },
    risk: 'review',
    schema: businessResetSchema,
  },
  {
    name: 'management.context',
    description:
      '查删改影响：删除或更正一条记录之前用，查关联单据、删除和更正怎么处理、最近修改。先用 records.search 或 records.get 定位 id。',
    arguments: { module: '与management.execute相同的模块', id: 1 },
    risk: 'read',
    schema: z.strictObject({ module: z.enum(dataManagementModules), id: positive }),
  },
];

function deletePreview(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  return new DatabaseMaintenanceService(ctx.store).preview(raw, who);
}

function managedRecord(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  const actor = requireLocalOrSuperAdmin(who),
    v = z.strictObject({ module: z.string(), id: positive }).parse(raw);
  return recordContext(ctx.store, v.module, v.id, actor);
}

export const managementReaders: Record<string, ToolReader> = {
  'management.delete_preview': deletePreview,
  'management.context': managedRecord,
};

function buildReset(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const v = businessResetSchema.parse(raw),
    reset = new BusinessReset(ctx.store);
  if (v.scope !== 'ai-imports') reset.refuseWithFinanceData();
  const before = reset.preview(v.scope, actor, { by: 'assistant' });
  return {
    tool,
    args: { scope: v.scope },
    label:
      v.scope === 'business'
        ? '一键清空业务数据'
        : v.scope === 'ai-imports'
          ? '一键清空AI识别工作区'
          : '一键清空业务数据与AI识别工作区',
    highRisk: true,
    before,
    after: before,
    warnings: ['该操作不可撤销；账号、审计、AI配置和提示词保留。'],
  };
}

/** 卡片标题上数据管理命令的动作叫法 */
const managementVerbs: Record<z.output<typeof assistantManagementSchema>['action'], string> = {
  create: '新建',
  update: '修改',
  archive: '归档',
  restore: '恢复',
  confirm: '确认',
  cancel: '取消',
  reverse: '撤销',
};

function buildManagement(ctx: ToolContext, tool: string, raw: unknown, actor: Actor, binding: string): ToolPlan {
  requireLocalAdministrator(actor);
  const command = assistantManagementSchema.parse(raw),
    service = new DataManagementService(ctx.store);
  const before = service
    .list(command.module, actor)
    .records.filter((x) => command.items.some((i) => i.id === x.record.id))
    .map((x) => x.record);
  const input = withDimensionConversion(command, before);
  const after = rehearse(ctx.store.db, () =>
    service.execute(input, actor, binding, 'management-assistant'),
  );
  return {
    tool,
    args: { input },
    // 卡片标题、执行回执都按它显示：动作用中文，不露英文值
    label:
      '数据管理：' +
      managementVerbs[input.action] +
      (dataManagementNames[input.module] || '记录') +
      (input.items.length ? ' ' + input.items.length + ' 条' : ''),
    // 数据管理命令不删东西（删除走 records.delete），都按普通修改出卡片
    highRisk: false,
    before,
    after,
    warnings: [],
  };
}

/** 方案里存的数据管理命令（确认后执行时取出来，命令仍由服务核对）；数据版本只用到它的模块 */
const managementArgs = z.object({ input: z.unknown() });
const managementModule = z.object({ input: z.object({ module: z.enum(dataManagementModules) }) });
/** 卡片上每份工作区的识别状态（叫法和 AI 导入页文件列表同一份） */
const workspaceState = (w: ImportWorkspaceView) => importStateLabel({ ...w, hasDraft: !!w.draft });
/** 卡片标题上的动作叫法 */
const workspaceVerbs: Record<string, string> = { fork: '复制', restore: '恢复', delete: '删除', archive: '归档', open: '打开' };

export const managementWriters: Record<string, ToolWriter> = {
  // 识别工作区的归档、恢复、复制、打开、删除：都出确认卡片，卡片上写文件名；删除（原件、识别结果一起删，找不回）
  // 按删除卡片画（plan-rules.ts 的 destructivePlan）
  'management.workspaces': {
    build: (ctx, tool, raw, actor) => {
      requireLocalAdministrator(actor);
      // 卡片上写文件名和识别状态，人看得出删的是哪几份；没带版本的按这时的版本，确认前被改过服务就拒绝
      const raw0 = workspaceToolSchema.parse(raw);
      const loaded = raw0.items.map((i) => ({ i, w: (ctx.imports ?? notConnected('AI 导入')).load(i.id) }));
      const v = workspaceCommandSchema.parse({ ...raw0, items: loaded.map(({ i, w }) => ({ id: i.id, revision: i.revision ?? w.revision })) });
      const files = loaded.map(({ i, w }) => ({ id: i.id, fileName: w.fileName, state: workspaceState(w) }));
      const deletes = WORKSPACE_DELETES.includes(v.action);
      return {
        tool,
        args: v,
        label: workspaceVerbs[v.action] + '识别工作区 ' + files.length + ' 份：' + files.map((f) => f.fileName).join('、'),
        highRisk: deletes,
        before: files,
        after: { count: v.items.length },
        warnings: deletes ? ['原件和识别结果一起删，删除后找不回；已正式导入的订单不受影响。'] : [],
      };
    },
    commit: (ctx, plan, actor, binding) => manageWorkspaces(ctx.store, ctx.imports ?? notConnected('AI 导入'), plan.args, actor, binding),
    stamp: () => ({}),
  },
  'management.reset': {
    build: buildReset,
    commit: (ctx, plan, actor) => new BusinessReset(ctx.store, ctx.imports).execute(plan.args, actor, { by: 'assistant' }),
  },
  'management.execute': {
    build: buildManagement,
    commit: (ctx, plan, actor, binding) => {
      requireLocalAdministrator(actor);
      return new DataManagementService(ctx.store).execute(
        managementArgs.parse(plan.args).input,
        actor,
        binding,
        'management-assistant',
      );
    },
    stamp: (ctx, plan, actor) => {
      if (plan.tool === 'management.execute')
        return {
          administrator: requireLocalAdministrator(actor).id,
          records: new DataManagementService(ctx.store).list(managementModule.parse(plan.args).input.module, actor).records,
        };
    },
  },
};
