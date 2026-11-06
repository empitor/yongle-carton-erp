import express, { type Router, type Request } from 'express';
import { periodSchema } from '../../shared/finance.js';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { FinanceAssets } from './assets.js';
import { FinanceBank } from './bank.js';
import { FinanceClosing } from './closing.js';
import { FinanceCosting } from './costing.js';
import { FinanceDue } from './due.js';
import { FinanceEvents } from './events.js';
import { FinanceExpenses } from './expenses.js';
import { FinanceInvoices } from './invoices.js';
import { FinanceMonthly } from './monthly.js';
import { FinanceNotes } from './notes.js';
import { FinanceOverview } from './overview.js';
import { FinanceParties } from './parties.js';
import { FinancePayroll } from './payroll.js';
import { FinanceReports } from './reports.js';
import { FinanceSettlements } from './settlements.js';
import { FinanceTermOperations } from './terms-finance.js';
import { financeError } from './core.js';
import { range } from './query.js';
import { financeAttachment, type ExportRow } from './export-workbook.js';
import {
  bankWorkbook, depreciationWorkbook, flowWorkbook, monthlyWorkbook,
  reportKind, reportNames, reportWorkbook, statementWorkbook, taxWorkbook,
} from './exports.js';
import path from 'node:path';

export function mountFinanceRoutes(router: Router, store: Store) {
  const cash = new FinanceSettlements(store),
    bank = new FinanceBank(store),
    invoices = new FinanceInvoices(store);
  const events = new FinanceEvents(store),
    parties = new FinanceParties(store),
    due = new FinanceDue(store);
  const expenses = new FinanceExpenses(store),
    assets = new FinanceAssets(store),
    payroll = new FinancePayroll(store);
  const costing = new FinanceCosting(store),
    closing = new FinanceClosing(store),
    reports = new FinanceReports(store);
  const overview = new FinanceOverview(store),
    monthly = new FinanceMonthly(store),
    notes = new FinanceNotes(store);
  const terms = new FinanceTermOperations(store);
  type Handler = (actor: Actor, req: Request) => unknown;
  const route = (method: 'get' | 'post' | 'put', path: string, handler: Handler) => {
    router[method](path, async (req, res) => res.json(await handler(res.locals.financeActor, req)));
  };
  const get = (path: string, h: Handler) => route('get', path, h);
  const post = (path: string, h: Handler) => route('post', path, h);
  const put = (path: string, h: Handler) => route('put', path, h);
  const exportSheet = (path: string, build: (a: Actor, r: Request) => { filename: string; bytes: Promise<Buffer> }) => {
    router.get(path, async (req, res) => {
      const { filename, bytes } = build(res.locals.financeActor, req);
      financeAttachment(res, filename, 'xlsx', await bytes);
    });
  };
  const pages = (read: (page: { page: number; pageSize: number }) => {
    rows: ExportRow[];
    filteredRecords: number;
  }) => {
    const rows: ExportRow[] = [];
    for (let page = 1; ; page++) {
      const data = read({ page, pageSize: 200 });
      rows.push(...data.rows);
      if (page * 200 >= data.filteredRecords) return rows;
    }
  };
  const upload = (
    path: string,
    max: string,
    h: (a: Actor, r: Request, bytes: Buffer) => unknown,
  ) => {
    router.post(
      path,
      express.raw({ type: 'application/octet-stream', limit: max }),
      async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) financeError('请上传文件字节。');
        res.json(await h(res.locals.financeActor, req, req.body));
      },
    );
  };

  get('/summary', (a, r) => overview.summary(a, r.query));
  get('/related/:kind/:id', (a, r) => overview.related(a, r.params.kind, r.params.id, r.query));
  get('/flow', (a, r) => overview.flow(a, r.query));
  exportSheet('/flow/export', (a, r) => {
    const period = periodSchema.parse(r.query.period);
    const rows = pages((p) => monthly.detail(a, { ...r.query, ...p }));
    return { filename: '月度台账-' + period, bytes: flowWorkbook(period, rows, true) };
  });
  get('/monthly-report', (a, r) => monthly.get(a, r.query));
  get('/monthly-report/detail', (a, r) => monthly.detail(a, r.query));
  get('/monthly-report/trend', (a, r) => monthly.trend(a, r.query));
  exportSheet('/monthly-report/detail/export', (a, r) => {
    const period = periodSchema.parse(r.query.period);
    const rows = pages((p) => monthly.detail(a, { ...r.query, ...p }));
    return { filename: '经营明细-' + period, bytes: flowWorkbook(period, rows, false) };
  });
  exportSheet('/monthly-report/export', (a, r) => {
    const data = monthly.get(a, r.query);
    return { filename: '月度经营报表-' + data.period, bytes: monthlyWorkbook(data) };
  });
  post('/events/:id/correct', (a, r) => events.correct(a, r.params.id, r.body));
  post('/events/:id/acknowledge', (a, r) =>
    events.acknowledgeStatisticalCorrection(a, r.params.id, r.body),
  );
  post('/tax-completion/batch', (a, r) => events.resolveBatch(a, r.body));
  get('/party-terms', (a, r) => parties.terms(a, r.query));
  get('/party-terms/:kind/:id', (a, r) => parties.getTerms(a, r.params.kind, r.params.id));
  put('/party-terms/:kind/:id', (a, r) => {
    parties.saveTerms(a, { ...r.body, kind: r.params.kind, partyId: Number(r.params.id) });
    return parties.getTerms(a, r.params.kind, r.params.id);
  });
  post('/obligations', (a, r) => parties.create(a, r.body));
  post('/obligations/:id/bad-debt', (a, r) => parties.badDebt(a, r.params.id, r.body));
  get('/aging', (a, r) => parties.aging(a, r.query));
  put('/obligations/:id/due', (a, r) => due.change(a, r.params.id, r.body));
  put('/installments/:id/due', (a, r) => due.change(a, r.params.id, r.body, true));
  get('/due-recalculation', (a, r) => due.preview(a, r.query));
  post('/due-recalculation', (a, r) => due.recalculate(a, r.body));
  get('/held', (a, r) => due.held(a, r.query));
  get('/payment-plan', (a, r) => due.plan(a, r.query));
  get('/due-soon', (a, r) => due.soon(a, r.query));
  get('/statements', (a, r) => cash.statement(a, r.query));
  put('/statements', (a, r) => cash.markStatement(a, r.body));
  exportSheet('/statements/export', (a, r) => {
    const { from, to, kind, party, data } = cash.statementForExport(a, r.query);
    return { filename: `往来对账单-${from}-至-${to}`, bytes: statementWorkbook(from, to, party, kind, data) };
  });
  get('/cash/accounts', (a, r) => cash.accounts(a, r.query));
  get('/cash/daily', (a, r) => cash.daily(a, r.query));
  put('/cash/accounts', (a, r) => cash.saveAccount(a, r.body));
  get('/cash/documents', (a, r) => cash.cashList(a, r.query));
  get('/cash/documents/:id', (a, r) => cash.cash(a, r.params.id));
  put('/cash/documents', (a, r) => cash.saveCash(a, r.body));
  post('/cash/documents/:id/confirm', (a, r) => cash.confirm(a, r.params.id, r.body));
  post('/cash/documents/:id/cancel', (a, r) => cash.cancel(a, r.params.id, r.body));
  post('/cash/documents/:id/allocate', (a, r) => cash.allocate(a, r.params.id, r.body));
  get('/cash/documents/:id/suggestions', (a, r) => cash.suggest(a, r.params.id, r.query));
  post('/cash/auto-allocate', (a, r) => cash.autoAllocate(a, r.body));
  post('/allocations/:id/revoke', (a, r) => cash.revoke(a, r.params.id, r.body));
  get('/discount-opportunities', (a, r) => due.discounts(a, r.query));
  get('/deposits', (a, r) => terms.deposits(a, r.query));
  post('/deposits', (a, r) => terms.deposit(a, r.body));
  post('/deposits/:id/actions', (a, r) => terms.depositAction(a, r.params.id, r.body));
  get('/interest', (a, r) => terms.interest(a, r.query));
  post('/interest/confirm', (a, r) => terms.confirmInterest(a, r.body));
  get('/notes', (a, r) => notes.list(a, r.query));
  post('/notes', (a, r) => notes.add(a, r.body));
  post('/notes/:id/status', (a, r) => notes.change(a, r.params.id, r.body));
  get('/mapping-profiles', (a, r) => bank.profiles(a, r.query));
  put('/mapping-profiles', (a, r) => bank.saveProfile(a, r.body));
  get('/bank/rows', (a, r) => bank.list(a, r.query));
  post('/bank/import', (a, r) => bank.import(a, r.body));
  upload('/bank/upload', '10mb', (a, r, bytes) => {
    let mapping: unknown;
    try {
      mapping = typeof r.query.mapping === 'string' ? JSON.parse(r.query.mapping) : undefined;
    } catch {
      financeError('列映射不是有效 JSON。');
    }
    return bank.upload(a, { ...r.query, mapping }, bytes);
  });
  get('/bank/rows/:id/suggestions', (a, r) => bank.suggestions(a, r.params.id));
  put('/bank/rows/:id/match', (a, r) => bank.match(a, r.params.id, r.body));
  get('/bank/reconcile', (a, r) => bank.reconcile(a, r.query));
  exportSheet('/bank/reconcile/export', (a, r) => {
    const data = bank.reconcile(a, r.query);
    const { from, to } = range.parse(r.query);
    return { filename: `银行余额调节表-${from}-至-${to}`, bytes: bankWorkbook(from, to, data) };
  });
  get('/invoices', (a, r) => invoices.list(a, r.query));
  get('/invoice-matching', (a, r) => invoices.unmatched(a, r.query));
  get('/invoices/:id', (a, r) => invoices.get(a, r.params.id));
  post('/invoices', (a, r) => invoices.create(a, r.body));
  upload('/invoices/upload', '10mb', (a, r, bytes) => invoices.upload(a, r.query, bytes));
  put('/invoices/:id/links', (a, r) => invoices.link(a, r.params.id, r.body));
  post('/invoices/:id/confirm', (a, r) => invoices.confirm(a, r.params.id, r.body));
  post('/invoices/:id/status', (a, r) => invoices.status(a, r.params.id, r.body));
  upload('/attachments/upload', '20mb', (a, r, bytes) =>
    invoices.saveAttachment(a, r.query, bytes),
  );
  router.get('/attachments/:id', (req, res) => {
    const file = invoices.attachment(res.locals.financeActor, req.params.id);
    const filename = path.basename(String(file.filename));
    if (file.media_type === 'application/octet-stream') res.attachment(filename);
    else
      res
        .type(String(file.media_type))
        .set('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(filename));
    res.send(Buffer.from(file.bytes as Uint8Array));
  });
  get('/tax', (a, r) => invoices.tax(a, r.query));
  exportSheet('/tax/export', (a, r) => {
    const data = invoices.tax(a, r.query);
    return { filename: '税务底稿-' + data.period, bytes: taxWorkbook(data) };
  });
  get('/expenses', (a, r) => expenses.list(a, r.query));
  put('/expenses', (a, r) => expenses.save(a, r.body));
  post('/expenses/:id/transition', (a, r) => expenses.transition(a, r.params.id, r.body));
  post('/employee-advances', (a, r) => expenses.advance(a, r.body));
  get('/assets', (a, r) => assets.list(a, r.query));
  post('/assets', (a, r) => assets.add(a, r.body));
  put('/assets/:id', (a, r) => assets.change(a, r.params.id, r.body));
  post('/assets/:id/dispose', (a, r) => assets.dispose(a, r.params.id, r.body));
  get('/depreciation', (a, r) => assets.depreciation(a, r.query));
  post('/depreciation', (a, r) => assets.depreciate(a, r.body));
  exportSheet('/depreciation/export', (a, r) => {
    const period = periodSchema.parse(r.query.period);
    const rows = pages((p) => assets.depreciation(a, { ...r.query, ...p }));
    return { filename: '折旧明细-' + period, bytes: depreciationWorkbook(period, rows) };
  });
  get('/payroll', (a, r) => payroll.list(a, r.query));
  put('/payroll', (a, r) => payroll.save(a, r.body));
  upload('/payroll/upload', '10mb', (a, r, bytes) => payroll.upload(a, r.query, bytes));
  post('/payroll/confirm', (a, r) => payroll.confirm(a, r.body));
  post('/payroll/pay', (a, r) => payroll.pay(a, r.body));
  get('/costing', (a, r) => costing.list(a, r.query));
  get('/costing/requirements', (a, r) => costing.requirements(a, r.query));
  post('/costing', (a, r) => costing.run(a, r.body));
  get('/margin', (a, r) => costing.margin(a, r.query));
  get('/reports/readiness', (a, r) => reports.readiness(a, r.query));
  get('/reports/dashboard', (a, r) => reports.dashboard(a, r.query));
  get('/reports/:kind', (a, r) => reports.get(a, r.params.kind, r.query));
  exportSheet('/reports/:kind/export', (a, r) => {
    const kind = reportKind.parse(r.params.kind), period = periodSchema.parse(r.query.period);
    const data = reports.get(a, kind, { period });
    return { filename: reportNames[kind] + '-' + period, bytes: reportWorkbook(period, [{ kind, data }]) };
  });
  get('/budgets', (a, r) => reports.budgets(a, r.query));
  put('/budgets', (a, r) => reports.budget(a, r.body));
  get('/closing', (a, r) => closing.check(a, r.query));
  post('/closing/tax', (a, r) => closing.accrueTax(a, r.body));
  post('/closing/profit', (a, r) => closing.settleProfit(a, r.body));
  post('/closing/close', (a, r) => closing.close(a, r.body));
  post('/closing/reopen', (a, r) => closing.reopen(a, r.body));
  get('/archive', (a, r) => closing.archive(a, r.query));
  router.get('/archive/download', async (req, res) => {
    const { period, bytes } = await closing.downloadArchive(res.locals.financeActor, req.query);
    financeAttachment(res, '财务归档-' + period, 'zip', bytes);
  });
}
