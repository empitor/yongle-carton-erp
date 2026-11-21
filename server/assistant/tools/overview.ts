// 助手工具：工作台概览（overview.get）、打开页面（ui.open）。财务只读工具在 tools.ts 的 read() 里直接转给财务模块。
import { z } from 'zod';
import { requirePermission, requireSuperAdminAccount } from '../../core/index.js';
import { AppError } from '../../core/index.js';
import { dateSchema, today } from '../../../shared/core/index.js';
import { monthsBefore } from '../../../shared/core/index.js';
import { buildDashboard, periodOrders } from '../../business/index.js';
import { adminSettingsLink, navigationTargets, financePageTargets, pageLink } from '../../../shared/assistant/index.js';
import { financeOnlyAccount, financeOnlyPageAllowed } from '../../../shared/core/index.js';
import { MONTHS_MAX, positive, requireActor } from './context.js';
import { readTool, toolSpec } from './define.js';
import { moduleSchema } from './modules.js';
import { financeReadQuery, financeReadTools, financeToolDescriptions } from '../../../shared/finance/index.js';

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
export const overviewTools = [
  ...financeReadTools.map((name) =>
    toolSpec({ name, risk: 'read', description: financeToolDescriptions[name], schema: financeReadQuery.pick(financeParams[name]) }),
  ),
  readTool(
    {
      name: 'ui.open',
      description: '打开业务页面：要带人去某个页面或某条记录时用。module 加记录 id，或用 q 搜。不能打开外部网址。',
      // 页面和记录类别都在 module 里（navigationTargets 包含全部页面），不再另给一个重复的 page
      schema: z.strictObject({
        module: z.enum(navigationTargets).optional(),
        id: positive.optional(),
        q: z.string().max(100).optional(),
      }),
    },
    (ctx, v, who) => {
      const actor = requireActor(who);
      const target = v.module;
      if (!target) throw new AppError('请指定一个有效页面目标。');
      if (Object.hasOwn(financePageTargets, target)) {
        requirePermission(actor, 'finance:view');
        return { url: pageLink(target, v.q), page: target };
      }
      if (financeOnlyAccount(actor) && (v.id || !financeOnlyPageAllowed(target)))
        throw new AppError('出纳账号只能查看财务数据。', 403);
      if (v.id) return ctx.tools.read('records.get', { module: moduleSchema.parse(target), id: v.id }, actor);
      const url = pageLink(target, v.q);
      // 设置里只给超级管理员账号的页签（提示词、插件与工具这些），别的账号界面上看不到，助手也不打开
      if (adminSettingsLink(url)) requireSuperAdminAccount(actor, '打开设置里的这个页签');
      return { url, page: target };
    },
  ),
  readTool(
    {
      name: 'overview.get',
      description:
        '查经营概况：问经营概况、今日总览时用。订单、采购、流水汇总，按 start/end 或 months 筛（默认最近两个自然月），实时库存和待处理不受日期限制。',
      schema: z.strictObject({
        start: dateSchema.optional(),
        end: dateSchema.optional(),
        months: months.optional(),
        allDates: z.boolean().default(false),
      }),
    },
    (ctx, f, who) => {
      requireActor(who);
      if (f.allDates && (f.start || f.end || f.months)) throw new AppError('全部日期不能同时指定日期范围。');
      const range = !f.allDates && (f.months || (!f.start && !f.end)) ? { ...f, start: monthsBefore(today(), f.months || 2), end: today() } : f;
      if (range.start && range.end && range.start > range.end) throw new AppError('开始日期不能晚于结束日期。');
      // 和经营概况页同一个口径：这段时间的统计算上这段时间里已归档的订单，实时的待办用没归档的
      const { current, archived } = periodOrders(ctx.store, range),
        rows = [...current, ...archived].filter((r) => (!range.start || r.orderDate >= range.start) && (!range.end || r.orderDate <= range.end));
      // AI 概览要工作台汇总，这里明确要求；没归档的订单已读过，直接传入，不再读一遍。
      return { ...buildDashboard(ctx.store, rows, range, today(), { allOrders: current, workbench: true }), url: '#dashboard' };
    },
  ),
];
