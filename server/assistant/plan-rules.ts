// 助手方案的规则：方案长什么样，哪些方案只能由人在确认卡片上确认、哪些只能在服务器本机做、哪些删除不用输密码。
// 生成方案（tools.ts、chat/workflow-cards.ts）、出卡片（chat/tool-step.ts）、执行（previews.ts）、执行接口（router.ts）、工具权限（tool-registry.ts）共用这一份。
import { z } from 'zod';
import type { Store } from '../core/index.js';
import { AppError, one, rows } from '../core/index.js';
import { flowKinds } from '../../shared/business/index.js';
import { asList, field, isRecord } from './chat/result-fields.js';

export type ToolPlan = {
  tool: string;
  /** 各命令执行时要的参数（各命令自己的结构，执行时按它校验，比如 tools/context.ts 的 idAndInput） */
  args: Record<string, unknown>;
  label: string;
  highRisk: boolean;
  /** 改之前、试执行改之后的样子（各命令不同；卡片内容由服务器写进 summary） */
  before: unknown;
  after: unknown;
  warnings: string[];
  engine?: unknown;
  /** 流程类工具的卡片（chat/workflow-cards.ts）：确认时交给流程类的执行函数，不走业务类的写入表 */
  workflow?: true;
  /** 服务器算好的、卡片上逐行给人看的内容（流程类卡片用；业务类卡片按 before、after 列改了什么） */
  summary?: { label: string; value: string }[];
};
/** 判断方案用的几样：哪条命令和它的参数（参数按各自的读法取，不要求是哪种结构） */
type PlanArgs = { tool: string; args: unknown };

/** 存下来的方案（assistant_previews.document 的 plan）：核对它是一份方案，交出去的是存的那个对象本身（摘要按它算，不能改动） */
const planShape = z.looseObject({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  label: z.string(),
  highRisk: z.boolean(),
  warnings: z.array(z.string()),
  workflow: z.literal(true).optional(),
  summary: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
});
export const storedToolPlan = z.custom<ToolPlan>((value) => planShape.safeParse(value).success, '不是助手方案');

/** 方案参数、方案里的记录：各命令不同，按列名取（chat/result-fields.ts 的 field、isRecord） */
export type Obj = Record<string, unknown>;

/** 助手的模块名 → 修改历史用的模块名（核对区按它用对字段的中文名和状态说法） */
const historyModules: Record<string, string> = {
  raw_inventory: 'stock_items',
  finished_inventory: 'stock_items',
  arrivals: 'arrival',
  production_tasks: 'task',
  production_records: 'production',
  deliveries: 'delivery',
};
/**
 * 这张卡片改的是哪个模块，随卡片交给页面，页面不猜。方案的参数里写了模块的用它；
 * 没写的（按单据办事的命令）看方案里记录本身：单据看 kind，采购单有供应商和明细，订单有客户和明细，库存品看原材料还是成品。
 */
export function planModule(plan: { args: unknown; before: unknown; after: unknown }) {
  const named = field(plan.args, 'module');
  if (typeof named === 'string' && named) return historyModules[named] || named;
  const row = [plan.after, plan.before].flatMap((v): unknown[] => (Array.isArray(v) ? v : [v])).find(isRecord);
  if (!row) return '';
  const kind = flowKinds.find((k) => k === row.kind);
  if (kind) return kind;
  if (row.supplierId != null && Array.isArray(row.lines)) return 'purchases';
  if (row.customerId != null && Array.isArray(row.lines)) return 'orders';
  if (row.kind === 'raw' || row.kind === 'finished') return 'stock_items';
  return '';
}
/**
 * 只能在服务器本机（最高管理员账号）做的操作被拒时给人看的话：从公网域名进来（localOnlyPlan），
 * 或者不是本机最高管理员会话调用本机工具（tool-registry 的权限核对），都用这一句，按工具说清是哪件事。
 * 别的数据管理命令不叫“一键清空”。
 */
export function localOnlyMessage(tool: string) {
  if (tool === 'management.reset')
    return '一键清空只能在服务器本机做（用最高管理员账号登录），请到服务器本机的维护入口处理。';
  if (tool.startsWith('management.'))
    return '数据管理命令只能在服务器本机做（用最高管理员账号登录），请到服务器本机的维护入口处理。';
  return '这项操作只能在服务器本机用最高管理员账号做。';
}
/** 识别工作区（原件、识别结果）的删除 */
export const WORKSPACE_DELETES = ['delete'];
const flowState = rows.flow_documents.pick({ kind: true, status: true });
/**
 * 删的是不是还没核对的到货、生产任务、完工、送货单（没动库存、没进账）。只用来判断要不要输密码：
 * 和人在页面上一样，这种单据有编辑权限就能删、不用密码；别的删除，本机最高管理员以外执行前都要核验本人密码
 * （在服务器本机、从域名访问都一样）。仍然只出确认卡片，由人点确认。
 * 执行时按库里的当前状态再判断一次，预览之后单据被确认了就不再算。
 */
export function unconfirmedDeletion(store: Store, plan: PlanArgs) {
  // 方案里存的是删除服务的选择：module 是单据类型（arrival/task/production/delivery），items 是要删的单据
  const module = String(field(plan.args, 'module')),
    items = asList(field(plan.args, 'items')) ?? [];
  if (plan.tool !== 'records.delete' || !flowKinds.some((k) => k === module) || !items.length) return false;
  return items.every((i) => {
    const row = one(store.db, flowState, 'SELECT kind,status FROM flow_documents WHERE id=?', Number(field(i, 'id')));
    return !!row && row.kind === module && row.status === 'draft';
  });
}
/**
 * 删除、一键清空这类不可逆操作：卡片按删除的样子画、写明后果，测试里的自动确认也不替人点。
 * 由服务器按工具和动作判断，不看模型给的标记。业务记录的删除只有 records.delete（数据管理命令不收删除）。
 */
export function destructivePlan(plan: PlanArgs) {
  if (['records.delete', 'management.reset'].includes(plan.tool)) return true;
  return plan.tool === 'management.workspaces' && WORKSPACE_DELETES.some((a) => a === field(plan.args, 'action'));
}
/**
 * 只能在服务器本机做的不可逆操作：一键清空，和识别工作区（management.workspaces）的删除。
 * 从公网域名进来时，生成方案和执行都拒绝。records.delete 不算：它从域名访问也能用，规则和人在页面上删除一样
 * （要超级管理员模式，由删除引擎核对；已核对的单据和档案执行前由聊天接口核验本人密码）。
 */
export function localOnlyPlan(plan: PlanArgs) {
  return destructivePlan(plan) && plan.tool !== 'records.delete';
}
/**
 * 删除卡片上能改“库存怎么处理”，改了换新的范围摘要（args.deletionDigest）。执行请求要带上卡片上看到的那一版摘要；
 * 对不上（另一个标签页改了选项、改选的响应丢了、没带），说明人确认的不是现在要执行的这一版，拒绝，请人看过最新的卡片再确认。
 * 只管 records.delete。executed：这份方案已经执行过了（别处确认的），不再原样返回结果，让人看最新的卡片。
 */
export function assertCardCurrent(plan: PlanArgs, seen: unknown, executed = false) {
  if (plan.tool !== 'records.delete' || (typeof seen === 'string' && seen === field(plan.args, 'deletionDigest'))) return;
  throw new AppError(
    executed ? '这份方案已经执行过了，请看最新的卡片。' : '方案已按新的库存处理方式重新核算，请看过再确认。',
    409,
    'plan-changed',
  );
}
