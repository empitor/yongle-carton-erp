// 助手工具：工作台概览（overview.get）、打开页面（ui.open）。财务只读工具在 tools.ts 的 read() 里直接转给财务模块。
import { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { requirePermission } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { dateSchema, today } from '../../../shared/core/index.js';
import { monthsBefore } from '../../../shared/core/index.js';
import { buildDashboard } from '../../business/index.js';
import { navigationTargets, financePageTargets, pageLink } from '../../../shared/assistant/index.js';
import { financeOnlyAccount, financeOnlyPageAllowed } from '../../../shared/core/index.js';
import { MONTHS_MAX, positive, requireActor, type ToolContext, type ToolReader } from './context.js';
import { moduleSchema } from './modules.js';
import { financeReadQuery, financeReadTools, financeToolDescriptions } from '../../../shared/finance/index.js';

/**
 * 财务读工具给模型看的参数示例：应收应付能按单位（partyId）、截至哪天（date）查（server/finance/assistant.ts），
 * 概览、资金账户按 date 查，其余按期间（period）查。只是示例，参数校验以 financeReadQuery 为准。
 */
function financeToolArguments(name: (typeof financeReadTools)[number]) {
  if (name === 'finance.receivables' || name === 'finance.payables')
    return { partyId: '可选，客户或供应商的编号（先查档案拿到）', date: '可选 YYYY-MM-DD，截至哪天，默认今天', limit: 20 };
  if (name === 'finance.summary' || name === 'finance.cash') return { date: '可选 YYYY-MM-DD，默认今天', limit: 20 };
  return { period: '可选 YYYY-MM', limit: 20 };
}
/** 每个财务查询真正用到的参数（server/finance/assistant.ts 的 readFinanceRaw），模型只看到这几项；写法照 financeReadQuery */
const financeParams: Record<(typeof financeReadTools)[number], { [K in keyof typeof financeReadQuery.shape]?: true }> = {
  'finance.summary': { date: true, limit: true },
  'finance.monthly': { period: true, date: true },
  'finance.receivables': { partyId: true, date: true, page: true, limit: true },
  'finance.payables': { partyId: true, date: true, page: true, limit: true },
  'finance.ledger': { period: true, account: true, page: true, limit: true },
  'finance.reports': { kind: true, period: true, limit: true },
  'finance.invoices': { period: true, page: true, limit: true },
  'finance.cash': { date: true, page: true, limit: true },
};
/** 概览看最近几个自然月 */
const months = z.number().int().min(1).max(MONTHS_MAX);
const openSchema = z.strictObject({
  module: z.enum(navigationTargets).optional(),
  id: positive.optional(),
  q: z.string().max(100).optional(),
});
export const overviewTools = [
  ...financeReadTools.map(name=>({name,risk:'read' as const,description:financeToolDescriptions[name],arguments:financeToolArguments(name),schema:financeReadQuery.pick(financeParams[name])})),
  {
    name: 'ui.open',
    description:
      '打开业务页面：要带人去某个页面或某条记录时用。module 加记录 id，或用 q 搜。不能打开外部网址。',
    arguments: {
      module: navigationTargets,
      id: '业务记录ID可选',
      q: '可选关键词',
    },
    risk: 'read',
    // 页面和记录类别都在 module 里（navigationTargets 包含全部页面），不再另给一个重复的 page
    schema: openSchema,
  },
  {
    name: 'overview.get',
    description:
      '查经营概况：问经营概况、今日总览时用。订单、采购、流水汇总，按 start/end 或 months 筛（默认最近两个自然月），实时库存和待处理不受日期限制。',
    arguments: {
      start: 'YYYY-MM-DD可省略',
      end: 'YYYY-MM-DD可省略',
      months: '1/2/3可省略',
      allDates: 'true查询全部日期',
    },
    risk: 'read',
    schema: z.strictObject({
      start: z.string().optional(),
      end: z.string().optional(),
      months: months.optional(),
      allDates: z.boolean().optional(),
    }),
  },
];

function openPage(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  const actor = requireActor(who);
  const v = openSchema.parse(raw);
  const target = v.module;
  if (!target) throw new AppError('请指定一个有效页面目标。');
  if (Object.hasOwn(financePageTargets, target)) {
    requirePermission(actor, 'finance:view');
    return { url: pageLink(target, v.q), page: target };
  }
  if (financeOnlyAccount(actor) && (v.id || !financeOnlyPageAllowed(target)))
    throw new AppError('出纳账号只能查看财务数据。', 403);
  if (v.id) {
    const module = moduleSchema.parse(target);
    return ctx.tools.read('records.get', { module, id: v.id }, actor);
  }
  return { url: pageLink(target, v.q), page: target };
}

function overview(ctx: ToolContext, raw: unknown, who: Actor | null | undefined) {
  requireActor(who);
  const f = z
    .strictObject({
      start: dateSchema.optional(),
      end: dateSchema.optional(),
      months: months.optional(),
      allDates: z.boolean().default(false),
    })
    .parse(raw);
  if (f.allDates && (f.start || f.end || f.months))
    throw new AppError('全部日期不能同时指定日期范围。');
  if (!f.allDates && (f.months || (!f.start && !f.end))) {
    f.start = monthsBefore(today(), f.months || 2);
    f.end = today();
  }
  if (f.start && f.end && f.start > f.end) throw new AppError('开始日期不能晚于结束日期。');
  const all = ctx.store.orders(),
    rows = all.filter((r) => (!f.start || r.orderDate >= f.start) && (!f.end || r.orderDate <= f.end));
  // AI 概览要工作台汇总，这里明确要求；全部订单已读过，直接传入，不再读一遍。
  return { ...buildDashboard(ctx.store, rows, f, today(), { allOrders: all, workbench: true }), url: '#dashboard' };
}

export const overviewReaders: Record<string, ToolReader> = {
  'ui.open': openPage,
  'overview.get': overview,
};
