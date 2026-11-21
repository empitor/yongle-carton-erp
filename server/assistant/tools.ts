// 只管：AssistantTools 外壳——按工具名把读取、生成方案、执行、方案绑定的版本分派到 tools/ 下各业务域；工具定义在 tool-catalog.ts。
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { requirePermission } from '../core/index.js';
import { OperationsService } from '../operations/index.js';
import { FlowService } from '../flow/index.js';
import { AppError } from '../core/index.js';
import { readFinanceTool } from '../finance/index.js';
import { financeForModel } from '../../shared/finance/index.js';
import { financeOnlyAccount, financeOnlyToolAllowed } from '../../shared/core/index.js';
import { localOnlyMessage, localOnlyPlan, type ToolPlan } from './plan-rules.js';
import { planStamp } from './card-stamp.js';
import { requireActor, type ReadExtra, type ToolContext, type ToolReader, type ToolServices, type ToolWriter } from './tools/context.js';
import { recordLink, type Module } from './tools/modules.js';
import { orderBatchReaders, orderBatchWriters } from './tools/order-batch.js';
import { arrivalReaders, arrivalWriters } from './tools/arrivals.js';
import { correctionWriters } from './tools/corrections.js';
import { documentInboxReaders, documentInboxWriters } from './tools/documents-inbox.js';
import { recordCard, withCard } from './tools/card-summary.js';
import { flowDocReaders, flowDocWriters } from './tools/flow-docs.js';
import { managementReaders, managementWriters } from './tools/management.js';
import { overviewReaders } from './tools/overview.js';
import { planningReaders } from './tools/planning.js';
import { recordReaders } from './tools/records-read.js';
import { recordSaveWriters } from './tools/records-save.js';
import { recordLifecycleWriters, withInventoryPolicy } from './tools/records-lifecycle.js';
import { historyReaders } from './tools/history.js';
import { aiStatusReaders } from './tools/ai-status.js';
import { adminViewReaders } from './tools/admin-view.js';
import { jobsReaders } from './tools/jobs.js';
import { guideReaders } from './tools/guide.js';
import { diagnosticsReaders } from './tools/diagnostics.js';
import { sourceReaders } from './tools/source.js';
import { webReaders } from './tools/web.js';
import { field } from './chat/result-fields.js';

/** 各业务域的读取函数按工具名合成一张表（tools/ 下各文件，一个名字只在一个文件里）。 */
const toolReaders: Record<string, ToolReader> = {
  ...documentInboxReaders,
  ...flowDocReaders,
  ...planningReaders,
  ...orderBatchReaders,
  ...arrivalReaders,
  ...managementReaders,
  ...overviewReaders,
  ...recordReaders,
  ...historyReaders,
  ...aiStatusReaders,
  ...adminViewReaders,
  ...jobsReaders,
  ...guideReaders,
  ...diagnosticsReaders,
  ...sourceReaders,
  ...webReaders,
};
/** 各业务域的写入（生成方案、执行、方案绑定的数据版本）按工具名合成一张表。 */
const toolWriters: Record<string, ToolWriter> = {
  ...arrivalWriters,
  ...correctionWriters,
  ...orderBatchWriters,
  ...documentInboxWriters,
  ...flowDocWriters,
  ...recordSaveWriters,
  ...recordLifecycleWriters,
  ...managementWriters,
};
export class AssistantTools {
  readonly ops: OperationsService;
  readonly flow: FlowService;
  /** 各业务域读写函数拿到的东西（tools/context.ts 的 ToolContext） */
  private readonly ctx: ToolContext;
  /** services：排查问题、看设置要读的服务和识别导入，建助手时一次给全（tools/context.ts 的 ToolServices） */
  constructor(
    readonly store: Store,
    services: ToolServices,
  ) {
    this.ops = new OperationsService(store);
    this.flow = new FlowService(store);
    this.ctx = { store, ops: this.ops, flow: this.flow, imports: services.imports, services, tools: this };
  }
  /** 流程类卡片写“动的是哪条、每行多少、库存怎么变”，和业务类卡片同一份写法（tools/card-summary.ts 的 recordCard） */
  recordCard(module: string, id: number, actor: Actor, rehearsal?: () => unknown) {
    return recordCard(this.ctx, module, id, actor, rehearsal);
  }
  /** 执行结果那条记录在页面上的链接（自动确认时给页面带上）：结果是哪条记录的视图，按页面链接要用的几列取 */
  link(module: Module, row: unknown) {
    const id = field(row, 'id'),
      name = field(row, 'name'),
      number = field(row, 'number'),
      receipt = field(row, 'receiptRecordId');
    return recordLink(module, {
      id: typeof id === 'number' ? id : String(id),
      archived: !!field(row, 'archived'),
      name: name === undefined ? undefined : String(name),
      number: number ? String(number) : undefined,
      receiptRecordId: receipt ? String(receipt) : undefined,
    });
  }
  /** extra：这一轮的中止信号等，聊天里调用时传，别的内部调用可以不传。 */
  read(name: string, raw: unknown, who: Actor | null | undefined, extra?: ReadExtra): unknown {
    if (name.startsWith('finance.'))
      return financeForModel(name, readFinanceTool(this.store, who, name, raw, this.ctx.services.problems));
    // 出纳这类纯财务账号只能读财务和白名单里不碰业务数据的（打开页面只能开财务页、联网、使用说明、自己的出错记录）。
    // 注册表之外的内部调用（打开记录、预读聊天上下文、核验页面结果）都走这里，所以在这里统一拦，不只靠注册表。
    if (financeOnlyAccount(who) && !financeOnlyToolAllowed(name))
      throw new AppError('出纳账号只能查看财务数据。', 403);
    // 各领域的读取各自做身份检查（和原来各分支一样）；名字不在表里的先要求登录，再报没注册。
    const reader = Object.hasOwn(toolReaders, name) ? toolReaders[name] : undefined;
    if (reader) return reader(this.ctx, raw, who, name, extra);
    requireActor(who);
    throw new AppError('未注册的只读工具。', 403);
  }
  /**
   * 生成方案。proxy 表示从公网域名进来：只能在服务器本机做的（一键清空、识别工作区的删除）在这里就说明原因，
   * 不出执行时必然被拒的确认卡片。records.delete 从域名访问和页面同一规则：没进超级管理员模式时，
   * 删除引擎算范围前就给出和页面一样的提示。
   */
  prepare(
    tool: string,
    raw: unknown,
    who: Actor | null | undefined,
    binding: string,
    context?: { proxy?: boolean },
  ): ToolPlan {
    // 一键清空生成方案要先拍快照、试算一遍：从域名进来的在这之前就拒绝
    if (context?.proxy && tool === 'management.reset')
      throw new AppError(localOnlyMessage(tool), 403, 'proxy-deletion');
    const plan = this.build(tool, raw, who, binding);
    if (context?.proxy && localOnlyPlan(plan))
      throw new AppError(localOnlyMessage(plan.tool), 403, 'proxy-deletion');
    return plan;
  }
  /** 这条命令有没有方案生成器（有的才能出业务类的确认卡片；tests/assistant-boundaries.test.ts 用它核对每条写入命令都有路可走） */
  plans(tool: string) {
    return Object.hasOwn(toolWriters, tool);
  }
  private build(tool: string, raw: unknown, who: Actor | null | undefined, binding: string): ToolPlan {
    const actor = requirePermission(who, 'business:edit');
    const writer = Object.hasOwn(toolWriters, tool) ? toolWriters[tool] : undefined;
    // 卡片上给人看的内容（动的是哪条、会发生什么）由服务器写进方案，页面原样列出
    if (writer) return withCard(this.ctx, writer.build(this.ctx, tool, raw, actor, binding), actor, binding);
    throw new AppError('工具未注册。', 403, 'unknown-tool');
  }
  commit(plan: ToolPlan, who: Actor | null | undefined, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      writer = Object.hasOwn(toolWriters, plan.tool) ? toolWriters[plan.tool] : undefined;
    if (writer) return writer.commit(this.ctx, plan, actor, binding);
    throw new AppError('未注册的写入工具。', 403, 'unknown-tool');
  }
  /**
   * 删除方案换一种“库存怎么处理”：删的还是原方案那几条（编号和版本都不变），由删除引擎按新选项重新预览，
   * 换上新的范围摘要和请求编号。权限照删除引擎的规则重新核对（没进超级管理员模式的照样拒绝）。
   */
  deletionWithPolicy(plan: ToolPlan, inventoryPolicy: 'preserve' | 'recalculate', who: Actor | null | undefined): ToolPlan {
    return withInventoryPolicy(this.ctx, plan, inventoryPolicy, who);
  }
  /** 方案绑定的数据版本：命令自己有绑定的用它的，别的按相关记录的版本号取（card-stamp.ts） */
  stamp(plan: ToolPlan, actor: Actor) {
    const writer = Object.hasOwn(toolWriters, plan.tool) ? toolWriters[plan.tool] : undefined;
    if (writer?.stamp) return writer.stamp(this.ctx, plan, actor);
    return planStamp(this.store, plan);
  }
}
