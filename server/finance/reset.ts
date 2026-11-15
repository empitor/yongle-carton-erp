// 初始化（连财务一起清）时财务清空自己的表（登记接口见 server/core/deletion-rules.ts）。由本模块的 index.ts 引入。
import { many, registerReset, rows } from '../core/index.js';

registerReset({
  module: '财务',
  finance: true,
  order: 60,
  statements: [
    'DELETE FROM fin_report_snapshots',
    'DELETE FROM fin_budgets',
    'DELETE FROM fin_period_jobs',
    'DELETE FROM fin_cost_sales',
    'DELETE FROM fin_inventory_costs',
    'DELETE FROM fin_payroll',
    'DELETE FROM fin_depreciation',
    'DELETE FROM fin_assets',
    'DELETE FROM fin_expenses',
    'DELETE FROM fin_invoice_links',
    'DELETE FROM fin_invoices',
    'DELETE FROM fin_attachments',
    'DELETE FROM fin_notes',
    'DELETE FROM fin_bank_matches',
    'DELETE FROM fin_bank_rows',
    'DELETE FROM fin_statements',
    'DELETE FROM fin_interest',
    'DELETE FROM fin_deposit_actions',
    'DELETE FROM fin_deposits',
    'DELETE FROM fin_installments',
    'DELETE FROM fin_allocations',
    'DELETE FROM fin_bad_debts',
    'DELETE FROM fin_cash_documents',
    'DELETE FROM fin_cash_accounts',
    'DELETE FROM fin_obligations',
    'DELETE FROM fin_source_observations',
    'DELETE FROM fin_entries',
    'DELETE FROM fin_vouchers',
    'DELETE FROM fin_events',
    'DELETE FROM fin_opening',
    'DELETE FROM fin_periods',
    // 账期和税率按往来单位记，业务清空了这些单位也就没了，一起清。
    'DELETE FROM fin_party_terms',
  ],
  // 科目表和设置本身保留：清掉启用月份、科目的“用过”标记
  after(store) {
    store.db.exec('UPDATE fin_settings SET start_period=NULL,version=version+1 WHERE start_period IS NOT NULL');
    store.db.exec('UPDATE fin_accounts SET used=0 WHERE used=1');
  },
  closedPeriods: (store) =>
    many(
      store.db,
      rows.fin_periods.pick({ period: true, version: true }),
      "SELECT period,version FROM fin_periods WHERE status='closed' ORDER BY period",
    ),
});
