// 只管：页面上“正在看的那条记录”的叫法在页面和模型之间换算。页面（data-agent-module、聊天请求的 context.module、页面快照）
// 只报全站记录种类（stock_items、task……），模型查记录用助手模块名（raw_inventory、production_tasks……），
// 交给模型的快照换成助手模块名，模型让页面看哪条记录时换回全站种类。对照只在 shared/assistant/assistant-modules.ts。
// 只换叫法，不改别的内容。
import { AppError } from '../../core/index.js';
import { dataManagementModules } from '../../../shared/business/index.js';
import { isAssistantModule, moduleOfRecord, pageObserveSchema, recordKindOf, type PageSnapshot } from '../../../shared/assistant/index.js';
import type { Module } from './modules.js';
import type { ToolContext } from './context.js';

/** 页面报的记录种类换成助手模块：库存品按这一条是原材料还是成品分；不认识的种类、已经不在的库存品没有 */
function pageModuleOf(ctx: ToolContext, record: string, id: number): Module | undefined {
  const kind = dataManagementModules.find((k) => k === record);
  if (kind !== 'stock_items') return kind && moduleOfRecord(kind);
  const item = ctx.ops.items(true, id)[0];
  return item && moduleOfRecord(kind, item.kind);
}

const notFound = (): never => {
  throw new AppError('记录不存在或已归档。', 404);
};
/** 预读页面上正在看的那条记录用：换不成（库存品不在了）按“记录不存在”报（和 records.get 读不到同一句） */
export function moduleOfPageRecord(ctx: ToolContext, record: (typeof dataManagementModules)[number], id: number): Module {
  return pageModuleOf(ctx, record, id) ?? notFound();
}

/**
 * 交给模型的页面快照：当前记录的种类换成助手模块名，模型照着就能查。换不成的（库存品刚被删了）照页面报的留着，
 * 模型去查会得到“记录不存在”。
 */
export function snapshotForModel(ctx: ToolContext, snapshot: PageSnapshot): PageSnapshot {
  const record = snapshot.record;
  if (!record) return snapshot;
  return { ...snapshot, record: { ...record, module: pageModuleOf(ctx, record.module, record.id) ?? record.module } };
}

/** 模型让页面看某条记录（page.observe 的 record）：助手模块名换回页面上的全站记录种类，别的写法原样交给页面比对 */
export function observeForPage(raw: unknown) {
  const args = pageObserveSchema.parse(raw),
    record = args.record;
  if (!record || !isAssistantModule(record.module)) return args;
  return { ...args, record: { ...record, module: recordKindOf(record.module) } };
}
