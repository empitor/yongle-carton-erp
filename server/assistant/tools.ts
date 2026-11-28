// 只管：AssistantTools 外壳——按工具名把读取、生成方案、执行、方案绑定的版本交给工具定义里的执行函数（tool-catalog.ts 拼好的目录，
// 写法见 tools/define.ts）。
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
import { requireActor, type ReadExtra, type ToolContext, type ToolServices } from './tools/context.js';
import type { CheckedCall } from './tools/define.js';
import { recordLink, type Module } from './tools/modules.js';
import { moduleOfPageRecord, snapshotForModel } from './tools/page-record.js';
import type { dataManagementModules } from '../../shared/business/index.js';
import type { PageSnapshot } from '../../shared/assistant/index.js';
import { recordCard, withCard } from './tools/card-summary.js';
import { withInventoryPolicy } from './tools/records-lifecycle.js';
import { toolDefinitions } from './tool-catalog.js';
import { field } from './chat/result-fields.js';

const definitions = new Map(toolDefinitions.map((t) => [t.name, t]));
type Who = Actor | null | undefined;
/** 从公网域名进来时的现场（只能在服务器本机做的在生成方案时就拒绝） */
type PrepareContext = { proxy?: boolean };

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
      number = field(row, 'number');
    return recordLink(module, {
      id: typeof id === 'number' ? id : String(id),
      archived: !!field(row, 'archived'),
      name: name === undefined ? undefined : String(name),
      number: number ? String(number) : undefined,
    });
  }
  /**
   * 页面上正在看的那条记录（页面报全站记录种类和编号）：换成助手模块（tools/page-record.ts 的 moduleOfPageRecord）后按 records.get 读，
   * 预读进聊天的上下文。
   */
  pageRecord(record: (typeof dataManagementModules)[number], id: number, who: Who): unknown {
    return this.read('records.get', { module: moduleOfPageRecord(this.ctx, record, id), id }, who);
  }
  /** 交给模型的页面快照（这一轮带来的、page.observe 看到的）：当前记录的种类换成助手模块名（tools/page-record.ts） */
  pageSnapshot(snapshot: PageSnapshot): PageSnapshot {
    return snapshotForModel(this.ctx, snapshot);
  }
  /** 内部调用和直接调用（工具之间互相调、打开记录、预读上下文）：参数在这里按工具的结构校验。extra：这一轮的中止信号等，聊天里才给。 */
  read(name: string, raw: unknown, who: Who, extra?: ReadExtra): unknown {
    if (name.startsWith('finance.')) return this.finance(name, raw, who);
    this.refuseFinanceOnly(name, who);
    return this.readWith(definitions.get(name)?.check(raw), who, extra);
  }
  /** 注册表分派来的调用：参数已经校验过（tool-registry.ts 的 dispatch） */
  readChecked(name: string, call: CheckedCall, who: Who, extra?: ReadExtra): unknown {
    if (name.startsWith('finance.')) return this.finance(name, call.args, who);
    this.refuseFinanceOnly(name, who);
    return this.readWith(call, who, extra);
  }
  private finance(name: string, raw: unknown, who: Who) {
    return financeForModel(name, readFinanceTool(this.store, who, name, raw, this.ctx.services.problems));
  }
  /**
   * 出纳这类纯财务账号只能读财务和白名单里不碰业务数据的（打开页面只能开财务页、联网、使用说明、自己的出错记录）。
   * 注册表之外的内部调用（打开记录、预读聊天上下文、核验页面结果）都走这里，所以在这里统一拦，不只靠注册表。
   */
  private refuseFinanceOnly(name: string, who: Who) {
    if (financeOnlyAccount(who) && !financeOnlyToolAllowed(name)) throw new AppError('出纳账号只能查看财务数据。', 403);
  }
  /** 各领域的读取各自做身份检查；没有读取函数的先要求登录，再报没注册。 */
  private readWith(call: CheckedCall | undefined, who: Who, extra?: ReadExtra) {
    if (call?.read) return call.read(this.ctx, who, extra);
    requireActor(who);
    throw new AppError('未注册的只读工具。', 403);
  }
  /**
   * 生成方案（内部调用和直接调用，参数在这里校验）。proxy 表示从公网域名进来：只能在服务器本机做的（一键清空、识别工作区的删除）
   * 在这里就说明原因，不出执行时必然被拒的确认卡片。records.delete 从域名访问和页面同一规则：没进超级管理员模式时，
   * 删除引擎算范围前就给出和页面一样的提示。
   */
  prepare(tool: string, raw: unknown, who: Who, binding: string, context?: PrepareContext): ToolPlan {
    const actor = this.planner(tool, who, context);
    return this.planWith(definitions.get(tool)?.check(raw), actor, binding, context);
  }
  /** 注册表分派来的生成方案：参数已经校验过 */
  prepareChecked(tool: string, call: CheckedCall, who: Who, binding: string, context?: PrepareContext): ToolPlan {
    return this.planWith(call, this.planner(tool, who, context), binding, context);
  }
  /** 一键清空生成方案要先拍快照、试算一遍：从域名进来的在这之前就拒绝；生成方案要编辑权限 */
  private planner(tool: string, who: Who, context?: PrepareContext) {
    if (context?.proxy && tool === 'management.reset') throw new AppError(localOnlyMessage(tool), 403, 'proxy-deletion');
    return requirePermission(who, 'business:edit');
  }
  private planWith(call: CheckedCall | undefined, actor: Actor, binding: string, context?: PrepareContext) {
    if (!call?.build) throw new AppError('工具未注册。', 403, 'unknown-tool');
    // 卡片上给人看的内容（动的是哪条、会发生什么）由服务器写进方案，页面原样列出
    const plan = withCard(this.ctx, call.build(this.ctx, actor, binding), actor, binding);
    if (context?.proxy && localOnlyPlan(plan)) throw new AppError(localOnlyMessage(plan.tool), 403, 'proxy-deletion');
    return plan;
  }
  /** 这条命令有没有方案生成器（有的才能出业务类的确认卡片；tests/assistant-boundaries.test.ts 用它核对每条写入命令都有路可走） */
  plans(tool: string) {
    return !!definitions.get(tool)?.commit;
  }
  commit(plan: ToolPlan, who: Who, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      commit = definitions.get(plan.tool)?.commit;
    if (commit) return commit(this.ctx, plan, actor, binding);
    throw new AppError('未注册的写入工具。', 403, 'unknown-tool');
  }
  /**
   * 删除方案换一种“库存怎么处理”：删的还是原方案那几条（编号和版本都不变），由删除引擎按新选项重新预览，
   * 换上新的范围摘要和请求编号。权限照删除引擎的规则重新核对（没进超级管理员模式的照样拒绝）。
   */
  deletionWithPolicy(plan: ToolPlan, inventoryPolicy: 'preserve' | 'recalculate', who: Who): ToolPlan {
    return withInventoryPolicy(this.ctx, plan, inventoryPolicy, who);
  }
  /** 方案绑定的数据版本：命令自己有绑定的用它的，别的按相关记录的版本号取（card-stamp.ts） */
  stamp(plan: ToolPlan, actor: Actor) {
    const stamp = definitions.get(plan.tool)?.stamp;
    return stamp ? stamp(this.ctx, plan, actor) : planStamp(this.store, plan);
  }
}
