/**
 * 财务各表里“状态、种类”这类列能存的全部值。
 *
 * 建表（server/core/schema/tables/finance-*.ts）的 CHECK 里写的是同一份：基础模块不能引用财务模块，所以两边各写一遍，
 * 由 tests/schema-constraints.test.ts 逐个比对，改了一边测试会提醒改另一边。
 * 0.9.0 发布以后要加值，除了改这里和建表，还要写升级步骤重建那张表（SQLite 的 CHECK 不能单独改）。
 *
 * 这里只列存进库的值。只用来筛选、显示的（比如事件列表能筛的状态）在用的地方从这里取一部分。
 * 页面下拉也要列的三组（收付方式 fin_cash_documents.method、账期方式 fin_party_terms.term_type、
 * 税率口径 fin_party_terms.tax_mode）放在
 * shared/finance/finance.ts，前后端共用。
 */
import { financeSourceKinds } from '../../../shared/core/index.js';

/** fin_periods.status */
export const periodStatuses = ['open', 'closed'] as const;

/** fin_vouchers.status */
export const voucherStatuses = ['draft', 'pending', 'approved', 'posted', 'void'] as const;

/** fin_vouchers.module_source：哪个财务功能生成的凭证（FinanceLedger.createLinked 的 module；event_reversal 是来源凭证的红冲） */
export const voucherModuleSources = [
  'asset',
  'asset_disposal',
  'depreciation',
  'tax',
  'profit_close',
  'annual_close',
  'costing',
  'expense',
  'employee_advance',
  'invoice',
  'note',
  'bad_debt',
  'obligation',
  'payroll',
  'cash',
  'deposit',
  'interest',
  'event_reversal',
  // 未到票退货冲减暂估：红冲当时的暂估、按剩下的另出一张，module_id 是采购退货单（purchase_returns.id）
  'purchase_return',
] as const;

/** fin_events.source_kind、fin_source_observations.source_kind：送货单、到货单、完工单、盘点调整流水（种类只定义在 shared/core/finance-sources.ts） */
export const eventSourceKinds = financeSourceKinds;

/** fin_events.event_type */
export const eventTypes = [
  'delivery.confirmed',
  'delivery.reversed',
  'production.completed',
  'stock.adjusted',
  'arrival.confirmed',
  'arrival.corrected',
] as const;

/** fin_events.status、fin_events.previous_status（上一条被接手时的状态）；最后两个（被新版本替代、启用前的单据）不在事件列表里出现 */
export const eventStatuses = [
  'ready',
  'info_pending',
  'waiting_invoice',
  'generated',
  'difference',
  'source_deleted',
  'awaiting_allocation_reversal',
  'cost_pending',
  'costed',
  'no_amount',
  'corrected',
  'superseded',
  'before_opening',
] as const;

/** fin_source_observations.status：来源单据最近一次被看到时的状态；deleted 是看到它被删除、已经处理过 */
export const observationStatuses = ['confirmed', 'reversed', 'deleted'] as const;

/** fin_templates.name：凭证模板只有建库时预置的这些 */
export const templateNames = [
  'delivery.confirmed',
  'arrival.confirmed',
  'settlement.discount',
  'deposit',
  'interest',
  'notes',
  'bad_debt',
  'expense',
  'asset',
  'payroll',
  'inventory',
] as const;

/** fin_party_terms.kind、fin_deposits.party_kind、fin_events.party_kind：往来单位是客户还是供应商 */
export const partyKinds = ['customer', 'supplier'] as const;

/** fin_obligations.kind、fin_statements.kind、fin_notes.kind：应收还是应付 */
export const obligationKinds = ['receivable', 'payable'] as const;

/** fin_obligations.tax_status：税额已定、待补税率、已被新版本替代 */
export const obligationTaxStatuses = ['known', 'pending', 'superseded'] as const;

/** fin_cash_accounts.kind */
export const cashAccountKinds = ['cash', 'bank', 'wechat', 'alipay', 'other'] as const;

/** fin_cash_documents.kind：收款、付款、转账、其他收入、其他支出 */
export const cashDocumentKinds = ['receipt', 'payment', 'transfer', 'income', 'outlay'] as const;

/** fin_cash_documents.status */
export const cashDocumentStatuses = ['draft', 'confirmed', 'cancelled'] as const;

/** fin_allocations.status */
export const allocationStatuses = ['active', 'reversing', 'revoked'] as const;

/** fin_deposits.kind：付出去的、收进来的 */
export const depositKinds = ['paid', 'received'] as const;

/** fin_deposit_actions.kind：退还、抵扣 */
export const depositActionKinds = ['refund', 'apply'] as const;

/** fin_bad_debts.kind：核销、计提、承兑票据结算往来 */
export const badDebtKinds = ['writeoff', 'provision', 'note'] as const;

/** fin_statements.status */
export const statementStatuses = ['sent', 'confirmed', 'difference'] as const;

/** fin_notes.status */
export const noteStatuses = ['held', 'endorsed', 'discounted', 'matured', 'returned', 'cancelled'] as const;

/** fin_attachments.media_type：按文件头判断，认不出的记最后一个 */
export const attachmentMediaTypes = ['image/png', 'image/jpeg', 'application/pdf', 'application/octet-stream'] as const;

/** fin_invoices.direction */
export const invoiceDirections = ['sale', 'purchase'] as const;

/** fin_invoices.status */
export const invoiceStatuses = [
  'draft',
  'normal',
  'red',
  'pending_certification',
  'certified',
  'nondeductible',
  'void',
] as const;

/** fin_expenses.status */
export const expenseStatuses = ['draft', 'pending', 'approved', 'rejected', 'paid'] as const;

/** fin_assets.status */
export const assetStatuses = ['active', 'disposed'] as const;

/** fin_period_jobs.kind 的原名；撤回重做的留底是“原名#第几次” */
export const periodJobKinds = [
  'depreciation',
  'payroll',
  'payroll_pay',
  'costing',
  'tax',
  'profit_close',
  'annual_close',
] as const;
