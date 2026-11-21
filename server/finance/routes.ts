// 财务的接口地址（挂在 /api/finance 下）：这里是设置、凭证账簿、业务单据进财务、概览和月度台账几页，
// 和各页共用的下载、上传写法；应收应付和资金发票在 routes-cash.ts，费用资产工资和报表结账在 routes-period.ts。
// 登录、财务权限、页面凭证和出错处理在 router.ts。
import express, { type Request, type Router } from 'express';
import { periodSchema, voucherTransitions, type FinanceApi } from '../../shared/finance/index.js';
import type { Actor, Store, route } from '../core/index.js';
import { financeError } from './core.js';
import { allPages } from './query.js';
import { financeAttachment, type ExportRow } from './export-workbook.js';
import { monthlyLedgerWorkbook, monthlyWorkbook } from './export-monthly.js';
import { FinanceAuditLog } from './audit-log.js';
import { FinanceBooks } from './books.js';
import { FinanceDerivedVouchers } from './derived-vouchers.js';
import { FinanceEventHandling } from './event-handling.js';
import { FinanceEventViews } from './event-views.js';
import { FinanceEventVouchers } from './event-voucher.js';
import { FinanceLedger } from './ledger.js';
import { FinanceMonthly } from './monthly.js';
import { FinanceOverview } from './overview.js';
import { FinanceSettings } from './settings.js';
import { FinanceTemplates } from './template.js';

/** 注册财务地址要用的：JSON 来回的走接口表（on），回文件、收原始字节的直接挂在 router 上 */
export type FinanceRoutes = {
  router: Router;
  on: ReturnType<typeof route<FinanceApi>>;
  store: Store;
  /** 这次请求的操作人（要财务查看权限） */
  actor: (req: Request) => Actor;
};

/** 下载 Excel：回文件内容，不是 JSON 来回，不进接口表。path 不带 /finance */
export function exportSheet(
  { router, actor }: FinanceRoutes,
  path: string,
  build: (a: Actor, req: Request) => { filename: string; bytes: Promise<Buffer> },
) {
  router.get(path, async (req, res) => {
    const { filename, bytes } = build(actor(req), req);
    financeAttachment(res, filename, 'xlsx', await bytes);
  });
}

/** 上传文件字节（application/octet-stream）：收的是原始字节，不是 JSON，不进接口表。path 不带 /finance */
export function upload(
  { router, actor }: FinanceRoutes,
  path: string,
  max: string,
  save: (a: Actor, req: Request, bytes: Buffer) => unknown,
) {
  router.post(path, express.raw({ type: 'application/octet-stream', limit: max }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) financeError('请上传文件字节。');
    res.json(await save(actor(req), req, req.body));
  });
}

/** 财务设置：启用、科目、期间、凭证模板 */
function settingsRoutes({ on, store, actor }: FinanceRoutes) {
  const settings = new FinanceSettings(store),
    templates = new FinanceTemplates(store);
  on('GET /finance/settings', ({ req }) => settings.get(actor(req)));
  on('PUT /finance/settings', ({ body, req }) => settings.update(actor(req), body));
  on('GET /finance/accounts', ({ req }) => settings.accounts(actor(req)));
  on('PUT /finance/accounts', ({ body, req }) => settings.saveAccount(actor(req), body));
  on('GET /finance/periods', ({ req }) => settings.periods(actor(req)));
  on('GET /finance/opening', ({ req }) => settings.opening(actor(req)));
  on('POST /finance/opening/enable', ({ body, req }) => settings.enable(actor(req), body));
  on('GET /finance/templates', ({ req }) => templates.list(actor(req)));
  on('PUT /finance/templates', ({ body, req }) => templates.save(actor(req), body));
}

/** 凭证和账簿 */
function ledgerRoutes(routes: FinanceRoutes) {
  const { router, on, store, actor } = routes;
  const ledger = new FinanceLedger(store),
    derived = new FinanceDerivedVouchers(store),
    books = new FinanceBooks(store),
    auditLog = new FinanceAuditLog(store);
  on('GET /finance/vouchers', ({ query, req }) => ledger.list(actor(req), query));
  on('POST /finance/vouchers', ({ body, req }) => ledger.create(actor(req), body), { status: 201 });
  on('GET /finance/vouchers/:id', ({ param, req }) => ledger.get(actor(req), param('id')));
  on('PUT /finance/vouchers/:id', ({ param, body, req }) => ledger.update(actor(req), param('id'), body));
  for (const action of voucherTransitions)
    on(`POST /finance/vouchers/:id/${action}`, ({ param, body, req }) => ledger.transition(actor(req), param('id'), action, body));
  on('POST /finance/vouchers/:id/reverse', ({ param, body, req }) => ledger.reverse(actor(req), param('id'), body));
  // 票据、资产处置、费用、坏账、利息、保证金生成的凭证：来源页面撤回（没记账）、红冲（已记账）
  on('POST /finance/source-vouchers/:id/withdraw', ({ param, body, req }) => derived.withdraw(actor(req), param('id'), body));
  on('POST /finance/source-vouchers/:id/reverse', ({ param, body, req }) => derived.reverse(actor(req), param('id'), body));
  on('GET /finance/books/:kind', ({ param, query, req }) => books.read(actor(req), param('kind'), query));
  router.get('/books/:kind/export', async (req, res) => {
    const { title, period, bytes } = books.export(actor(req), req.params.kind, req.query);
    financeAttachment(res, title + '-' + period, 'xlsx', await bytes);
  });
  on('GET /finance/audit', ({ query, req }) => auditLog.list(actor(req), query));
}

/** 财务待处理（业务单据进财务） */
function eventRoutes({ on, store, actor }: FinanceRoutes) {
  // 业务单据进财务由 router.ts 在每个请求前补扫，没有单独的地址
  const eventViews = new FinanceEventViews(store),
    handling = new FinanceEventHandling(store),
    eventVouchers = new FinanceEventVouchers(store);
  on('GET /finance/events', ({ query, req }) => eventViews.list(actor(req), query));
  on('GET /finance/events/:id', ({ param, req }) => eventViews.get(actor(req), param('id')));
  on('POST /finance/events/:id/resolve', ({ param, body, req }) => handling.resolve(actor(req), param('id'), body));
  on('POST /finance/events/:id/generate', ({ param, body, req }) => eventVouchers.generate(actor(req), param('id'), body));
  on('POST /finance/events/:id/correct', ({ param, body, req }) => handling.correct(actor(req), param('id'), body));
  on('POST /finance/events/:id/acknowledge', ({ param, body, req }) =>
    handling.acknowledgeStatisticalCorrection(actor(req), param('id'), body),
  );
  on('POST /finance/tax-completion/batch', ({ body, req }) => handling.resolveBatch(actor(req), body));
}

/** 概览、月度台账、经营报表 */
function overviewRoutes(routes: FinanceRoutes) {
  const { on, store, actor } = routes;
  const overview = new FinanceOverview(store),
    monthly = new FinanceMonthly(store);
  on('GET /finance/summary', ({ query, req }) => overview.summary(actor(req), query));
  on('GET /finance/related/:kind/:id', ({ param, query, req }) => overview.related(actor(req), param('kind'), param('id'), query));
  on('GET /finance/monthly-ledger', ({ query, req }) => overview.monthlyLedger(actor(req), query));
  // 台账页和概览下钻都从这里导出，条件（类型、单据月份、待补税率）照传
  exportSheet(routes, '/monthly-ledger/export', (a, r) => {
    const period = periodSchema.parse(r.query.period);
    const rows = allPages<ExportRow>((p) => monthly.detail(a, { ...r.query, ...p }));
    return { filename: '月度台账-' + period, bytes: monthlyLedgerWorkbook(period, rows) };
  });
  on('GET /finance/monthly-report', ({ query, req }) => monthly.get(actor(req), query));
  on('GET /finance/monthly-report/detail', ({ query, req }) => monthly.detail(actor(req), query));
  on('GET /finance/monthly-report/trend', ({ query, req }) => monthly.trend(actor(req), query));
  exportSheet(routes, '/monthly-report/export', (a, r) => {
    const data = monthly.get(a, r.query);
    return { filename: '月度经营报表-' + data.period, bytes: monthlyWorkbook(data) };
  });
}

/** 设置、凭证账簿、业务单据进财务、概览和月度台账 */
export function ledgerPages(routes: FinanceRoutes) {
  settingsRoutes(routes);
  ledgerRoutes(routes);
  eventRoutes(routes);
  overviewRoutes(routes);
}
