// 财务的接口地址：应收应付、资金发票两页（账期、到期、对账单，收付款和核销、保证金和利息、票据、银行流水、发票和税务底稿）。
// 页面怎么分、共用的写法见 routes.ts。
import path from 'node:path';
import { z } from 'zod';
import { financeError } from './base/core.js';
import { range } from './base/query.js';
import { bankWorkbook, statementWorkbook, taxWorkbook } from './reports/exports.js';
import { exportSheet, upload, type FinanceRoutes } from './routes.js';
import { FinanceAllocations } from './cash/allocations.js';
import { FinanceAttachments } from './base/attachments.js';
import { FinanceBank } from './cash/bank.js';
import { FinanceCashAccounts } from './cash/cash-accounts.js';
import { FinanceDepositsInterest } from './parties/deposits-interest.js';
import { FinanceDue } from './parties/due.js';
import { FinanceInvoiceConfirm } from './cash/invoice-confirm.js';
import { FinanceInvoiceMatching } from './cash/invoice-matching.js';
import { FinanceInvoices } from './cash/invoices.js';
import { FinanceNotes } from './cash/notes.js';
import { FinanceParties } from './parties/parties.js';
import { FinanceSettlements } from './cash/settlements.js';
import { FinanceStatements } from './parties/statements.js';
import { FinanceTax } from './base/vat.js';

/** 改账期的正文先按对象收：单位种类和编号以地址为准，盖掉正文里的同名项，其余由账期的规则校验 */
const termsFields = z.looseObject({});

/** 应收应付：往来、账期、到期、账龄、对账单 */
function partyRoutes(routes: FinanceRoutes) {
  const { on, store, actor } = routes;
  const parties = new FinanceParties(store),
    due = new FinanceDue(store),
    statements = new FinanceStatements(store),
    allocations = new FinanceAllocations(store);
  on('GET /finance/parties', ({ query, req }) => parties.options(actor(req), query));
  on('GET /finance/obligations', ({ query, req }) => parties.obligations(actor(req), query));
  on('POST /finance/obligations', ({ body, req }) => parties.create(actor(req), body));
  on('POST /finance/obligations/:id/bad-debt', ({ param, body, req }) => parties.badDebt(actor(req), param('id'), body));
  on('POST /finance/obligations/transfer-credit', ({ body, req }) => allocations.transferCredit(actor(req), body));
  on('GET /finance/party-terms', ({ query, req }) => parties.terms(actor(req), query));
  on('GET /finance/party-terms/:kind/:id', ({ param, req }) => parties.getTerms(actor(req), param('kind'), param('id')));
  on('PUT /finance/party-terms/:kind/:id', ({ param, body, req }) => {
    const a = actor(req);
    parties.saveTerms(a, { ...termsFields.parse(body), kind: param('kind'), partyId: Number(param('id')) });
    return parties.getTerms(a, param('kind'), param('id'));
  });
  on('GET /finance/aging', ({ query, req }) => parties.aging(actor(req), query));
  on('PUT /finance/obligations/:id/due', ({ param, body, req }) => due.change(actor(req), param('id'), body));
  on('GET /finance/due-recalculation', ({ query, req }) => due.preview(actor(req), query));
  on('POST /finance/due-recalculation', ({ body, req }) => due.recalculate(actor(req), body));
  on('GET /finance/held', ({ query, req }) => due.held(actor(req), query));
  on('GET /finance/payment-plan', ({ query, req }) => due.plan(actor(req), query));
  on('GET /finance/due-soon', ({ query, req }) => due.soon(actor(req), query));
  on('GET /finance/discount-opportunities', ({ query, req }) => due.discounts(actor(req), query));
  on('GET /finance/statements', ({ query, req }) => statements.statement(actor(req), query));
  on('PUT /finance/statements', ({ body, req }) => statements.mark(actor(req), body));
  exportSheet(routes, '/statements/export', (a, r) => {
    const { from, to, kind, party, data } = statements.statementForExport(a, r.query);
    return { filename: `往来对账单-${from}-至-${to}`, bytes: statementWorkbook(from, to, party, kind, data) };
  });
}

/** 资金：资金账户、收付款和核销、保证金和利息、承兑汇票 */
function cashRoutes({ on, store, actor }: FinanceRoutes) {
  const cashAccounts = new FinanceCashAccounts(store),
    cash = new FinanceSettlements(store),
    allocations = new FinanceAllocations(store),
    deposits = new FinanceDepositsInterest(store),
    notes = new FinanceNotes(store);
  on('GET /finance/cash/accounts', ({ query, req }) => cashAccounts.accounts(actor(req), query));
  on('GET /finance/cash/daily', ({ query, req }) => cashAccounts.daily(actor(req), query));
  on('PUT /finance/cash/accounts', ({ body, req }) => cashAccounts.saveAccount(actor(req), body));
  on('GET /finance/cash/documents', ({ query, req }) => cash.cashList(actor(req), query));
  on('GET /finance/cash/documents/:id', ({ param, req }) => cash.cash(actor(req), param('id')));
  on('PUT /finance/cash/documents', ({ body, req }) => cash.saveCash(actor(req), body));
  on('POST /finance/cash/documents/:id/confirm', ({ param, body, req }) => cash.confirm(actor(req), param('id'), body));
  on('POST /finance/cash/documents/:id/cancel', ({ param, body, req }) => cash.cancel(actor(req), param('id'), body));
  on('POST /finance/cash/documents/:id/allocate', ({ param, body, req }) => allocations.allocate(actor(req), param('id'), body));
  on('GET /finance/cash/documents/:id/suggestions', ({ param, query, req }) =>
    allocations.suggest(actor(req), param('id'), query),
  );
  on('POST /finance/allocations/:id/revoke', ({ param, body, req }) => allocations.revoke(actor(req), param('id'), body));
  on('GET /finance/deposits', ({ query, req }) => deposits.deposits(actor(req), query));
  on('POST /finance/deposits', ({ body, req }) => deposits.deposit(actor(req), body));
  on('POST /finance/deposits/:id/actions', ({ param, body, req }) => deposits.depositAction(actor(req), param('id'), body));
  on('GET /finance/interest', ({ query, req }) => deposits.interest(actor(req), query));
  on('POST /finance/interest/confirm', ({ body, req }) => deposits.confirmInterest(actor(req), body));
  on('GET /finance/notes', ({ query, req }) => notes.list(actor(req), query));
  on('POST /finance/notes', ({ body, req }) => notes.add(actor(req), body));
  on('POST /finance/notes/:id/status', ({ param, body, req }) => notes.change(actor(req), param('id'), body));
  on('POST /finance/notes/:id/allocate', ({ param, body, req }) => notes.allocate(actor(req), param('id'), body));
}

/** 银行流水的列映射：地址上的 mapping 是一段 JSON 文字（不给就是按默认列名认） */
function bankMapping(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return financeError('列映射不是有效 JSON。');
  }
}

/** 银行流水：导入、匹配、余额调节表 */
function bankRoutes(routes: FinanceRoutes) {
  const { on, store, actor } = routes;
  const bank = new FinanceBank(store);
  on('GET /finance/bank/rows', ({ query, req }) => bank.list(actor(req), query));
  upload(routes, '/bank/upload', '10mb', (a, r, bytes) =>
    bank.upload(a, { ...r.query, mapping: bankMapping(r.query.mapping) }, bytes),
  );
  on('GET /finance/bank/rows/:id/suggestions', ({ param, req }) => bank.suggestions(actor(req), param('id')));
  on('PUT /finance/bank/rows/:id/match', ({ param, body, req }) => bank.match(actor(req), param('id'), body));
  on('GET /finance/bank/reconcile', ({ query, req }) => bank.reconcile(actor(req), query));
  exportSheet(routes, '/bank/reconcile/export', (a, r) => {
    const data = bank.reconcile(a, r.query);
    const { from, to } = range.parse(r.query);
    return { filename: `银行余额调节表-${from}-至-${to}`, bytes: bankWorkbook(from, to, data) };
  });
}

/** 发票、附件、税务底稿 */
function invoiceRoutes(routes: FinanceRoutes) {
  const { router, on, store, actor } = routes;
  const invoices = new FinanceInvoices(store),
    invoiceConfirm = new FinanceInvoiceConfirm(store),
    matching = new FinanceInvoiceMatching(store),
    attachments = new FinanceAttachments(store),
    tax = new FinanceTax(store);
  on('GET /finance/invoices', ({ query, req }) => invoices.list(actor(req), query));
  on('GET /finance/invoice-matching', ({ query, req }) => matching.list(actor(req), query));
  on('GET /finance/invoices/:id', ({ param, req }) => invoices.get(actor(req), param('id')));
  on('POST /finance/invoices', ({ body, req }) => invoices.create(actor(req), body));
  on('PUT /finance/invoices/:id/links', ({ param, body, req }) => invoices.link(actor(req), param('id'), body));
  on('POST /finance/invoices/:id/confirm', ({ param, body, req }) => invoiceConfirm.confirm(actor(req), param('id'), body));
  on('POST /finance/invoices/:id/status', ({ param, body, req }) => invoices.status(actor(req), param('id'), body));
  upload(routes, '/attachments/upload', '20mb', (a, r, bytes) => attachments.save(a, r.query, bytes));
  // 原件：回文件内容，不进接口表
  router.get('/attachments/:id', (req, res) => {
    const file = attachments.get(actor(req), req.params.id);
    const filename = path.basename(file.filename);
    if (file.media_type === 'application/octet-stream') res.attachment(filename);
    else res.type(file.media_type).set('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(filename));
    res.send(Buffer.from(file.bytes));
  });
  on('GET /finance/tax', ({ query, req }) => tax.worksheet(actor(req), query));
  exportSheet(routes, '/tax/export', (a, r) => {
    const data = tax.worksheet(a, r.query);
    return { filename: '税务底稿-' + data.period, bytes: taxWorkbook(data) };
  });
}

/** 应收应付、资金发票 */
export function partyCashPages(routes: FinanceRoutes) {
  partyRoutes(routes);
  cashRoutes(routes);
  bankRoutes(routes);
  invoiceRoutes(routes);
}
