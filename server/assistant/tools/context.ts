// 只管：各业务域工具函数共用的上下文类型（ToolContext、外壳接口 ToolShell、装配接上的服务 ToolServices、ToolReader、ToolWriter）
// 和几个小件（要求登录、要求超级管理员、试算回滚、报错、截断、正整数和 UUID 参数、分页）。tools/ 下最底层的文件，只引用别的模块的入口和 plan-rules 的类型。
import { z } from 'zod';
import type { Store } from '../../core/index.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, Deployment, ProblemLog, RunLog, SourceScope } from '../../core/index.js';
import { AppError, canEnterSuperMode, requireLocalAdministrator } from '../../core/index.js';
import type { AiSettingsManager } from '../../ai/index.js';
import type { OperationsService } from '../../operations/index.js';
import type { FlowService } from '../../flow/index.js';
import type { ImportManager } from '../../import/index.js';
import type { BotState } from '../../../shared/import/index.js';
import type { ToolPlan } from '../plan-rules.js';

export const fail = (message: string): never => {
  throw new AppError(message);
};
export const positive = z.number().int().positive();
export const uuid = z.uuid();
/** 列表工具共用的分页：默认 20 条，最多 50 条；跳过的条数最多 10 万（查记录一页的条数另定，跳过的条数也是它）。 */
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
export const OFFSET_MAX = 100_000;
/** 按“最近几个月”查（概览、查记录）最多几个月 */
export const MONTHS_MAX = 3;
/** 失败原因、出错原因最多给几个字 */
export const REASON_CHARS = 300;
/** 查记录的时间参数：写法交给基础模块核对（2026-11-13 或 2026-11-13T08:00），最短一个日期、最多 30 字 */
const TIME_MIN_CHARS = 10;
const TIME_MAX_CHARS = 30;
export const timeText = z.string().trim().min(TIME_MIN_CHARS).max(TIME_MAX_CHARS);
/** 账号名、操作叫法、章节名这类短的筛选字最多几个字 */
export const SHORT_TEXT_CHARS = 60;
export const paging = {
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  offset: z.number().int().min(0).max(OFFSET_MAX).default(0),
};
/** 方案生成器收到的参数：要是个对象，各项交给服务按它自己的结构核对 */
export const objectArgs = z.looseObject({});
const withId = z.looseObject({ id: positive });
/** 先取出记录的 id（正整数），其余原样交给服务核对 */
export function splitId(raw: unknown) {
  const { id, ...rest } = withId.parse(raw);
  return { id, rest };
}
/** 方案里存的“哪条记录 + 交给服务的输入”（确认后执行时取出来，输入仍由服务自己核对） */
export const idAndInput = z.object({ id: positive, input: z.unknown() });
/** 按字段名读的记录（各模块字段不同，没有的字段是 undefined） */
export type Fields = Readonly<Record<string, unknown>>;
export const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null;
/** 明细这类对象列表：不是列表算空的 */
export const fieldList = (v: unknown): Fields[] => (Array.isArray(v) ? v.filter(isFields) : []);
/** 给模型看的长文字截断，免得一条记录把整个回复撑爆。 */
export const clip = (text: unknown, max = 500) => {
  const s = text == null ? '' : String(text);
  return s.length > max ? s.slice(0, max) + '…（后面还有 ' + (s.length - max) + ' 字）' : s;
};

/**
 * 外壳 AssistantTools（tools.ts）对各业务域露出的三个方法。工具之间互相调用（打开页面带编号调 records.get、
 * 退货方案先读可退数量、批量归档逐条生成方案和逐条执行）都回到外壳，走同样的分派和检查。
 * 只写成接口，tools/ 下的文件就不用引用 tools.ts。
 */
export type ToolShell = {
  read(name: string, raw: unknown, who: Actor | null | undefined): unknown;
  prepare(
    tool: string,
    raw: unknown,
    who: Actor | null | undefined,
    binding: string,
    context?: { proxy?: boolean },
  ): ToolPlan;
  commit(plan: ToolPlan, who: Actor | null | undefined, binding: string): unknown;
};
/**
 * 装配时接上的只读服务（AssistantTools.connect）：AI 设置、账号、机器人设置和连接状态、部署方式、助手工具注册表，
 * 以及基础模块的出错记录、运行日志、读代码的范围、账号库（登录记录在里面）。
 * 都是别的模块现成的对象，这里只写用到的几个方法；没接上的，对应的工具说“还没接上”。
 */
export type ToolServices = {
  ai?: AiSettingsManager;
  accounts?: { listAccounts(): { id: string; name: string; level: string; disabled: boolean }[] };
  bots?: { views(): { label: string; hasSecret: boolean; enabled: boolean; status: { state: BotState } }[] };
  deployment?: Deployment | null;
  registry?: {
    view(actor?: Actor | null): {
      tools: { name: string; module: string; enabled: boolean; pluginEnabled: boolean; toolEnabled: boolean; status: string }[];
    };
  };
  problems?: ProblemLog;
  runLog?: RunLog;
  source?: SourceScope;
  accountsDb?: DatabaseSync;
};
/** 装配还没把要用的服务接上：工具照实说，不假装查过 */
export function notConnected(what: string): never {
  throw new AppError(what + '还没接上，查不了。', 503);
}
/** 各业务域读写函数拿到的东西。 */
export type ToolContext = {
  store: Store;
  ops: OperationsService;
  flow: FlowService;
  imports?: ImportManager;
  services: ToolServices;
  tools: ToolShell;
};
/** 只读工具。身份检查各自做，和原来 read() 里各分支一样（有的要登录，有的交给删除引擎或本机管理员检查）。 */
/**
 * 读取时的现场（聊天里调用时给）：这一轮的中止信号（用户点停止时取消联网这类慢的读取）；
 * allowedUrl：模型要读的网址对上了哪条用户在这个会话里给过的、或搜索返回过的网址，返回那条原样（web.read 只开这些），对不上是 null；
 * question：用户这一轮的原话（web.search 一起发给搜索接口）。
 */
export type ReadExtra = { signal?: AbortSignal; allowedUrl?: (url: string) => string | null; question?: string };
export type ToolReader = (ctx: ToolContext, raw: unknown, who: Actor | null | undefined, name: string, extra?: ReadExtra) => unknown;
/** 写工具：build 生成方案（外壳已查过 business:edit），commit 执行，stamp 是方案绑定的数据版本（没有就走外壳的兜底）。 */
export type ToolWriter = {
  build: (
    ctx: ToolContext,
    tool: string,
    raw: unknown,
    actor: Actor,
    binding: string,
  ) => ToolPlan;
  commit: (ctx: ToolContext, plan: ToolPlan, actor: Actor, binding: string) => unknown;
  stamp?: (ctx: ToolContext, plan: ToolPlan, actor: Actor) => unknown;
};

export function requireActor(actor: Actor | null | undefined) {
  if (!actor) throw new AppError('请先登录管理账号。', 401);
  return actor;
}
/** 超级管理员账号才能看（不要求进超级管理员模式）；别的账号直接说没有权限。what 是要看的东西。 */
export function requireSuperAdmin(who: Actor | null | undefined, what: string) {
  const actor = requireActor(who);
  if (!canEnterSuperMode(actor)) throw new AppError('只有超级管理员能查看' + what + '。', 403, 'permission');
  return actor;
}
/** 本机专用的只读工具：本机最高管理员，或从域名访问的超级管理员账号（用户 2026-11-13 定：只读的放开，写入仍只限本机）。 */
export function requireLocalOrSuperAdmin(who: Actor | null | undefined) {
  return who && canEnterSuperMode(who) ? who : requireLocalAdministrator(who);
}
