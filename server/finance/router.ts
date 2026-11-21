import { Router, type ErrorRequestHandler, type Request } from 'express';
import { ZodError } from 'zod';
import type { AuthManager, ProblemLog } from '../core/index.js';
import type { Store } from '../core/index.js';
import { route } from '../core/index.js';
import type { FinanceApi } from '../../shared/finance/index.js';
import { catchUp } from './catch-up.js';
import { financeActor, financeError } from './core.js';
import { ledgerPages, type FinanceRoutes } from './routes.js';
import { partyCashPages } from './routes-cash.js';
import { costPeriodPages } from './routes-period.js';

/** 财务挂在 /api 下的位置（装配 server/app.ts 挂在 /api/finance） */
const FINANCE_MOUNT = '/finance';
/** 补扫没成功时拦下财务写请求的说法 */
const SYNC_FAILED = '业务单据没能同步进财务（原因已记进出错记录），先不能改财务的数据，请联系维护人员。';

const inputLabels: Record<string, string> = {
  period: '会计期间', date: '日期', from: '起始日期', to: '截止日期', dueDate: '到期日',
  kind: '类型', status: '状态', metric: '统计项目', sourceMonth: '单据月份', missingTax: '缺税率筛选',
  account: '科目编码', accountCode: '科目编码', accountId: '资金账户', partyId: '往来单位',
  amount: '金额', bankBalance: '银行余额', debit: '借方金额', credit: '贷方金额',
  rate: '税率', mode: '含税口径', version: '记录版本', description: '摘要', reason: '原因',
};
const financeInputError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (!(error instanceof ZodError)) return next(error);
  const messages = error.issues.map((issue) => {
    if (/^\p{Script=Han}/u.test(issue.message)) return issue.message;
    const field = String(issue.path.at(-1) ?? '');
    const label = Object.hasOwn(inputLabels, field) ? inputLabels[field] : '填写内容或筛选条件';
    return label + '无效，请检查后重试。';
  });
  res.status(400).json({ message: [...new Set(messages)].join('；') });
};

/**
 * 财务的接口（接口表 shared/finance/finance-api.ts，地址按页面分在 routes.ts、routes-cash.ts、routes-period.ts，
 * 注册顺序就是匹配顺序）。每个请求先认人、要财务查看权限，不缓存，写操作要带页面凭证，再把还没记进财务的业务单据
 * 补扫进来（catch-up.ts，读不出来的单据记进出错记录 problems）；输入不合规则的转成中文说明。
 */
export function financeRouter(store: Store, auth?: AuthManager, problems?: ProblemLog) {
  const router = Router();
  // 中间件已核过财务查看权限，各地址按同一个判断取出操作人（要更高权限的由服务再查）
  const actor = (req: Request) => financeActor(auth?.actor(req));
  router.use((req, res, next) => {
    const user = actor(req),
      write = !['GET', 'HEAD'].includes(req.method);
    res.set('Cache-Control', 'no-store');
    if (write && req.headers['x-erp-auth-token'] !== auth?.csrf) financeError('页面凭证已过期，请刷新。', 403);
    // 补扫没成功时读照常回答已经进财务的数；写入要按最新的单据状态核对，先拦下（catch-up.ts“出错怎么办”）
    if (catchUp(store, user, problems).failed && write) financeError(SYNC_FAILED, 503);
    next();
  });
  const routes: FinanceRoutes = { router, on: route<FinanceApi>(router, FINANCE_MOUNT), store, actor };
  ledgerPages(routes);
  partyCashPages(routes);
  costPeriodPages(routes);
  router.use(financeInputError);
  return router;
}
