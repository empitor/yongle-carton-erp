// 只管：记录的去留——单条、批量归档和恢复，删除（records.delete，一次一条或几条），以及删除方案换“库存怎么处理”。
import {
  DELETION_MAX_RECORDS,
  deletionHeadline,
  deletionModuleTable,
  deletionSelection,
  impactRowSchema,
  type DeletionImpactRow,
  type RecordEntity,
} from '../../../shared/business/index.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../core/index.js';
import { many, requirePermission } from '../../core/index.js';
import { archivedOrConflict, changeLifecycle } from '../../business/index.js';
import { archiveFlowDocuments } from '../../flow/index.js';
import { AppError } from '../../core/index.js';
import { DatabaseMaintenanceService } from '../../business/index.js';
import { recordEntities } from '../../../shared/business/index.js';
import type { ToolPlan } from '../plan-rules.js';
import { positive, type ToolContext, type ToolWriter } from './context.js';
import { inSavepoint, rehearse } from '../../core/index.js';
import { assistantModules, flowMap, moduleNames, moduleSchema, recordRow, recordVersion } from './modules.js';

/** 一次批量归档、恢复最多几条 */
const BATCH_MAX = 100;
const lifecycleAction = z.enum(['archive', 'restore']);
/** 方案里存的归档、恢复参数（确认后执行时按它取；版本是出卡片时那条记录的） */
const lifecycleArgs = z.object({ module: moduleSchema, id: positive, action: lifecycleAction, version: z.number().optional() });
/** 删除方案里存的选择：哪种记录、哪几条（编号和版本） */
const deletionArgs = z.looseObject({
  module: z.string(),
  items: z.array(z.object({ id: positive, version: z.number().optional() })),
  inventoryPolicy: z.enum(['preserve', 'recalculate']).optional(),
});
const isRecordEntity = (e: string): e is RecordEntity => (recordEntities as readonly string[]).includes(e);
/**
 * records.delete 收的参数：删一条给 id，一次删几条给 ids（同一种记录，上限和页面批量删除同一个），两样只给一样。
 * 一次几条和页面批量删除一样：一次删除预览、一张卡片、一次确认，交给删除引擎一次删。
 */
const deleteInput = z
  .strictObject({
    module: moduleSchema,
    id: positive.optional(),
    ids: z.array(positive).min(1).max(DELETION_MAX_RECORDS).optional(),
    inventoryPolicy: z.enum(['preserve', 'recalculate']).optional(),
  })
  .refine((v) => (v.id === undefined) !== (v.ids === undefined), {
    message: '删一条给 id，一次删几条给 ids，两样只给一样。',
    path: ['ids'],
  });

export const recordLifecycleTools = [
  {
    name: 'records.delete',
    description:
      '删除记录：物理删除一条或几条时用（用户说“永久删除”也是它），不是归档、取消或冲销，归档用 records.propose_lifecycle。删一条给 id，几条给 ids（同一种记录，最多 ' +
      DELETION_MAX_RECORDS +
      ' 条）。关联在事务里级联或解除，删前自动留快照；已有到货的采购单也能删，到货单和库存流水保留。服务器出一张“确认执行”卡片，人在卡片上确认后才删，回复说待确认，不要说已删除。',
    arguments: {
      module: assistantModules.filter((m) => m !== 'movements'),
      id: '删一条时给',
      ids: ['一次删几条时给'],
      inventoryPolicy: 'preserve/recalculate',
    },
    risk: 'review',
    schema: deleteInput,
  },
  {
    name: 'records.propose_batch_lifecycle',
    description:
      '批量归档或恢复（最多 100 条），全部成功或全部回滚；流水不能归档。',
    arguments: {
      module: assistantModules.filter((m) => m !== 'movements'),
      ids: ['正整数'],
      action: ['archive', 'restore'],
    },
    risk: 'high',
    schema: z.strictObject({
      module: moduleSchema,
      ids: z.array(positive).min(1).max(BATCH_MAX),
      action: lifecycleAction,
    }),
  },
  {
    name: 'records.propose_lifecycle',
    description:
      '归档或恢复一条记录，不是删除，历史引用保留；归档要满足对应的完成条件。',
    arguments: { module: assistantModules, id: '正整数', action: ['archive', 'restore'] },
    risk: 'review',
    schema: z.strictObject({
      module: moduleSchema,
      id: positive,
      action: z.enum(['archive', 'restore']),
    }),
  },
];

function buildDelete(ctx: ToolContext, tool: string, raw: unknown, actor: Actor): ToolPlan {
  const v = deleteInput.parse(raw);
  // 能删什么和人工一样由删除服务判断：草稿有编辑权限就能删，其余要超级管理员模式
  const before = (v.ids ?? (v.id === undefined ? [] : [v.id])).map((id) => {
    const row = recordRow(ctx, v.module, actor, true, id);
    if (!row) throw new AppError('记录不存在：编号 ' + id + '。', 404);
    return row;
  });
  const module =
    flowMap[v.module] || (v.module.includes('inventory') ? 'stock_items' : v.module);
  const selection = {
    module,
    items: before.map((row) => ({ id: row.id, version: recordVersion(row) })),
    inventoryPolicy: v.inventoryPolicy,
  };
  const after = new DatabaseMaintenanceService(ctx.store).preview(selection, actor);
  return {
    tool,
    args: { ...selection, deletionDigest: after.digest, requestId: randomUUID() },
    label: deletionLabel(module, before, after.impact),
    highRisk: true,
    before,
    after,
    warnings: [after.inventoryEffect],
  };
}

function buildLifecycle(ctx: ToolContext, tool: string, raw: unknown, actor: Actor, binding: string): ToolPlan {
  const v = z
      .strictObject({
        module: moduleSchema,
        id: positive,
        action: z.enum(['archive', 'restore']),
      })
      .parse(raw),
    before = recordRow(ctx, v.module, actor, v.action === 'restore', v.id);
  if (!before) throw new AppError('记录不存在。', 404);
  const plan: ToolPlan = {
    tool,
    args: { ...v, version: recordVersion(before) },
    label: (v.action === 'archive' ? '归档' : '恢复') + moduleNames[v.module],
    highRisk: false,
    before,
    after: null,
    warnings: [],
  };
  plan.after = rehearse(ctx.store.db, () => ctx.tools.commit(plan, actor, binding));
  return plan;
}

function buildBatchLifecycle(ctx: ToolContext, tool: string, raw: unknown, actor: Actor, binding: string): ToolPlan {
  const v = z
    .strictObject({
      module: moduleSchema,
      ids: z.array(positive).min(1).max(BATCH_MAX),
      action: lifecycleAction,
    })
    .parse(raw);
  if (new Set(v.ids).size !== v.ids.length || v.module === 'movements')
    throw new AppError('记录重复或模块不支持批量归档。');
  const children = v.ids.map((id) =>
    ctx.tools.prepare(
      'records.propose_lifecycle',
      { module: v.module, id, action: v.action },
      actor,
      binding,
    ),
  );
  return {
    tool,
    args: { module: v.module, children },
    label: `批量${v.action === 'restore' ? '恢复' : '归档'}${moduleNames[v.module]}`,
    highRisk: true,
    before: children.map((p) => p.before),
    after: children.map((p) => p.after),
    warnings: [v.action === 'restore' ? '要么全部恢复，要么一条都不动。' : '要么全部归档，要么一条都不动；历史记录照常保留。'],
  };
}

/** 删除方案里存的要删的那几条记录（改之前的样子），标题按它们说 */
const shownRows = z.array(z.looseObject({}));
/**
 * 删除卡片的标题：和页面删除窗口、核对区按钮同一句（shared 的 deletionHeadline），数字是这份删除预览列出的条数；
 * 删一条时带上它的单号或名字（“删除供应商 虚构纸业和它的 2 张采购单、1 张到货单”），几条时说几条（“删除 3 个客户”）。
 */
function deletionLabel(module: string, before: unknown, impact: DeletionImpactRow[]) {
  const rows = shownRows.parse(before),
    only = rows.length === 1 ? rows[0] : undefined,
    named = (v: unknown) => (typeof v === 'string' ? v : '');
  return deletionHeadline(module, rows, impact, only ? named(only.number) || named(only.name) || undefined : undefined).title;
}

/** 删除卡片核对用的：哪种记录、每条的编号和出卡片时的版本、库存怎么处理（方案里另有的摘要、请求编号不看） */
const stampArgs = z.object(deletionSelection.shape);
const versionRow = z.object({ id: z.number(), version: z.number() });
const previewRows = z.object({ impact: z.array(impactRowSchema) });
/** 删除预览里选中的那几条的叫法（单号或名称）：卡片作废时说出是哪一条变了 */
function selectedNames(after: unknown, module: string) {
  const table = deletionModuleTable(module);
  const own = previewRows
    .parse(after)
    .impact.filter((r) => r.table === table && r.action === 'delete' && (table !== 'flow_documents' || r.kind === module));
  return new Map(own.map((r) => [Number(r.id), r.name]));
}
/**
 * 删除卡片的数据核对（previews.ts 出卡片时记下，确认时再算一遍比对）：先按删除引擎同一个判断核对谁能删；
 * 再看选中的每条现在的版本号，都和出卡片时一样才按删除预览算范围摘要。有一条不在了或版本变了就不算摘要
 * （删除引擎也会拒），和出卡片时记的对不上，整张卡片按“数据变了”作废，说出是哪几条（stale-card.ts）——
 * 和页面批量删除一样，有一条对不上整批都不删。
 */
function deletionStamp(ctx: ToolContext, plan: ToolPlan, actor: Actor) {
  const selection = stampArgs.parse(plan.args),
    service = new DatabaseMaintenanceService(ctx.store);
  service.deletionAccess(actor, selection);
  const ids = selection.items.map((i) => i.id);
  const sql = 'SELECT id,version FROM ' + deletionModuleTable(selection.module) + ' WHERE id IN (' + ids.map(() => '?').join(',') + ')';
  const now = new Map(many(ctx.store.db, versionRow, sql, ...ids).map((r) => [r.id, r.version]));
  const names = selectedNames(plan.after, selection.module);
  const records = selection.items.map((i) => ({ id: i.id, name: names.get(i.id), version: now.get(i.id) ?? null }));
  if (selection.items.some((i) => now.get(i.id) !== i.version)) return { records };
  return { records, digest: service.preview(selection, actor).digest };
}

/** 删除方案换一种“库存怎么处理”（说明见 tools.ts 的 deletionWithPolicy）。 */
export function withInventoryPolicy(
  ctx: ToolContext,
  plan: ToolPlan,
  inventoryPolicy: 'preserve' | 'recalculate',
  who: Actor | null | undefined,
): ToolPlan {
  const actor = requirePermission(who, 'business:edit');
  if (plan.tool !== 'records.delete') throw new AppError('只有删除方案能选库存怎么处理。');
  const { module, items } = deletionArgs.parse(plan.args),
    selection = { module, items, inventoryPolicy };
  const after = new DatabaseMaintenanceService(ctx.store).preview(selection, actor);
  return {
    ...plan,
    args: { ...selection, deletionDigest: after.digest, requestId: randomUUID() },
    label: deletionLabel(selection.module, plan.before, after.impact),
    after,
    warnings: [after.inventoryEffect],
  };
}

/** 归档、恢复一条：档案和单据都是 server/core/archive.ts 那一份做法，各模块只给“什么时候不能归档” */
function commitLifecycle(ctx: ToolContext, a: z.output<typeof lifecycleArgs>, actor: Actor) {
  const body = { action: a.action, acknowledged: true, items: [{ id: a.id, version: a.version }] };
  const entity = a.module.includes('inventory') ? 'stock_items' : a.module;
  if (flowMap[a.module]) return archivedOrConflict(archiveFlowDocuments(ctx.flow, body, actor));
  if (isRecordEntity(entity)) return archivedOrConflict(changeLifecycle(ctx.store, entity, body, actor));
  throw new AppError('不支持归档此模块。');
}

export const recordLifecycleWriters: Record<string, ToolWriter> = {
  'records.delete': {
    build: buildDelete,
    // 一次几条也是交给删除引擎一次删（和页面批量删除同一个服务函数）：先拍快照、逐条记审计、同一请求编号只删一次
    commit: (ctx, plan, actor, binding) => new DatabaseMaintenanceService(ctx.store).delete(plan.args, actor, binding),
    stamp: deletionStamp,
  },
  'records.propose_lifecycle': {
    build: buildLifecycle,
    commit: (ctx, plan, actor) => commitLifecycle(ctx, lifecycleArgs.parse(plan.args), actor),
  },
  'records.propose_batch_lifecycle': {
    build: buildBatchLifecycle,
    // 逐条按单条归档、恢复的同一个执行函数办，整批在一个事务里
    commit: (ctx, plan, actor) => {
      const { children } = z.object({ children: z.array(z.object({ args: lifecycleArgs })) }).parse(plan.args);
      return inSavepoint(ctx.store.db, () => children.map((child) => commitLifecycle(ctx, child.args, actor)));
    },
  },
};
