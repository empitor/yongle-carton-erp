// 财务的接口地址：费用资产工资、报表结账两页（费用和员工借款、固定资产和折旧、工资，成本毛利、正式报表、预算、结账和归档）。
// 页面怎么分、共用的写法见 routes.ts。
import { periodSchema } from '../../shared/finance/index.js';
import { allPages } from './base/query.js';
import { financeAttachment, type ExportRow } from './base/export-workbook.js';
import { depreciationWorkbook } from './reports/exports.js';
import { reportKind, reportNames, reportWorkbook } from './reports/export-reports.js';
import { exportSheet, upload, type FinanceRoutes } from './routes.js';
import { FinanceAssets } from './expenses/assets.js';
import { FinanceClosing } from './reports/closing.js';
import { FinanceArchive } from './reports/closing-archive.js';
import { FinanceCosting } from './costing/costing.js';
import { FinanceExpenses } from './expenses/expenses.js';
import { FinanceMargin } from './costing/margin.js';
import { FinancePayroll } from './expenses/payroll.js';
import { FinanceReports } from './reports/reports.js';

/** 费用、固定资产、工资 */
function costRoutes(routes: FinanceRoutes) {
  const { on, store, actor } = routes;
  const expenses = new FinanceExpenses(store),
    assets = new FinanceAssets(store),
    payroll = new FinancePayroll(store);
  on('GET /finance/expenses', ({ query, req }) => expenses.list(actor(req), query));
  on('PUT /finance/expenses', ({ body, req }) => expenses.save(actor(req), body));
  on('POST /finance/expenses/:id/transition', ({ param, body, req }) => expenses.transition(actor(req), param('id'), body));
  on('POST /finance/employee-advances', ({ body, req }) => expenses.advance(actor(req), body));
  on('GET /finance/assets', ({ query, req }) => assets.list(actor(req), query));
  on('POST /finance/assets', ({ body, req }) => assets.add(actor(req), body));
  on('PUT /finance/assets/:id', ({ param, body, req }) => assets.change(actor(req), param('id'), body));
  on('POST /finance/assets/:id/dispose', ({ param, body, req }) => assets.dispose(actor(req), param('id'), body));
  on('GET /finance/depreciation', ({ query, req }) => assets.depreciation(actor(req), query));
  on('POST /finance/depreciation', ({ body, req }) => assets.depreciate(actor(req), body));
  exportSheet(routes, '/depreciation/export', (a, r) => {
    const period = periodSchema.parse(r.query.period);
    const rows = allPages<ExportRow>((p) => assets.depreciation(a, { ...r.query, ...p }));
    return { filename: '折旧明细-' + period, bytes: depreciationWorkbook(period, rows) };
  });
  on('GET /finance/payroll', ({ query, req }) => payroll.list(actor(req), query));
  upload(routes, '/payroll/upload', '10mb', (a, r, bytes) => payroll.upload(a, r.query, bytes));
  on('POST /finance/payroll/confirm', ({ body, req }) => payroll.confirm(actor(req), body));
  on('POST /finance/payroll/pay', ({ body, req }) => payroll.pay(actor(req), body));
  on('GET /finance/payroll/payment', ({ query, req }) => payroll.paymentStatus(actor(req), query));
}

/** 成本、毛利，正式报表、预算、结账和归档 */
function periodRoutes(routes: FinanceRoutes) {
  const { router, on, store, actor } = routes;
  const costing = new FinanceCosting(store),
    margin = new FinanceMargin(store),
    reports = new FinanceReports(store),
    closing = new FinanceClosing(store),
    archive = new FinanceArchive(store);
  on('GET /finance/costing', ({ query, req }) => costing.list(actor(req), query));
  on('GET /finance/costing/requirements', ({ query, req }) => costing.requirements(actor(req), query));
  on('POST /finance/costing', ({ body, req }) => costing.run(actor(req), body));
  on('GET /finance/margin', ({ query, req }) => margin.get(actor(req), query));
  on('GET /finance/reports/readiness', ({ query, req }) => reports.readiness(actor(req), query));
  on('GET /finance/reports/dashboard', ({ query, req }) => reports.dashboard(actor(req), query));
  on('GET /finance/reports/:kind', ({ param, query, req }) => reports.get(actor(req), param('kind'), query));
  exportSheet(routes, '/reports/:kind/export', (a, r) => {
    const kind = reportKind.parse(r.params.kind),
      period = periodSchema.parse(r.query.period);
    return { filename: reportNames[kind] + '-' + period, bytes: reportWorkbook(period, [reports.report(a, kind, { period })]) };
  });
  on('GET /finance/budgets', ({ query, req }) => reports.budgets(actor(req), query));
  on('PUT /finance/budgets', ({ body, req }) => reports.budget(actor(req), body));
  on('GET /finance/closing', ({ query, req }) => closing.check(actor(req), query));
  on('POST /finance/closing/tax', ({ body, req }) => closing.accrueTax(actor(req), body));
  on('POST /finance/closing/profit', ({ body, req }) => closing.settleProfit(actor(req), body));
  on('POST /finance/closing/close', ({ body, req }) => closing.close(actor(req), body));
  on('POST /finance/closing/reopen', ({ body, req }) => closing.reopen(actor(req), body));
  // 归档包（zip）：回文件内容，不进接口表
  router.get('/archive/download', async (req, res) => {
    const { period, bytes } = await archive.downloadArchive(actor(req), req.query);
    financeAttachment(res, '财务归档-' + period, 'zip', bytes);
  });
}

/** 费用资产工资、报表结账 */
export function costPeriodPages(routes: FinanceRoutes) {
  costRoutes(routes);
  periodRoutes(routes);
}
