/** 财务的发票、费用、固定资产和折旧、工资、存货成本和销售成本、期末任务、报表快照、预算。约束的写法见 finance-ledger.ts 开头。 */
import { FINISHED_UNIT, RAW_UNIT } from '../../../../shared/core/index.js';
import { isDate, isPeriod } from './checks.js';

export const financeCostTables = `
-- 发票。编号用 AUTOINCREMENT，初始化后不从头来。type 是用户填的发票类型，不列枚举；
-- rate 是 0～100 的数字文本，不带 %；红票的金额为负，净额加税额等于价税合计
CREATE TABLE fin_invoices(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK(direction IN ('sale','purchase')),
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  tax_id TEXT NOT NULL,
  net INTEGER NOT NULL,
  rate TEXT NOT NULL CHECK(rate GLOB '[0-9]*' AND rate NOT GLOB '*[^0-9.]*' AND CAST(rate AS REAL) BETWEEN 0 AND 100),
  tax INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','normal','red','pending_certification','certified','nondeductible','void')),
  original_id INTEGER REFERENCES fin_invoices(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  transfer_voucher_id INTEGER REFERENCES fin_vouchers(id),
  attachment_id INTEGER REFERENCES fin_attachments(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(type,number),
  CHECK(net+tax=gross)
) STRICT;
CREATE INDEX fin_invoice_date ON fin_invoices(direction,date);
CREATE INDEX fin_invoices_original ON fin_invoices(original_id);

-- 发票和应收应付的对应（发票分到哪些往来）；unit 是用户在关联时填的文字，不限定；estimate_cents=0 标开错重开的蓝票
CREATE TABLE fin_invoice_links(
  invoice_id INTEGER NOT NULL REFERENCES fin_invoices(id),
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  estimate_cents INTEGER CHECK(estimate_cents IS NULL OR estimate_cents>=0),
  net_cents INTEGER CHECK(net_cents IS NULL OR net_cents>=0),
  quantity_units INTEGER CHECK(quantity_units IS NULL OR quantity_units>0),
  unit TEXT,
  PRIMARY KEY(invoice_id,obligation_id)
) STRICT;
CREATE INDEX fin_invoice_links_obligation ON fin_invoice_links(obligation_id);

-- 费用报销
CREATE TABLE fin_expenses(
  id INTEGER PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  department TEXT NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected','paid')),
  invoice_id INTEGER REFERENCES fin_invoices(id),
  attachment_id INTEGER REFERENCES fin_attachments(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  cash_id INTEGER REFERENCES fin_cash_documents(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;
CREATE INDEX fin_expenses_cash ON fin_expenses(cash_id);

-- 固定资产卡片。category 是用户填的类别，不列枚举；months 是折旧月数，residual_bp 是残值率（万分之几）
CREATE TABLE fin_assets(
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  original_cents INTEGER NOT NULL CHECK(original_cents>0),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  months INTEGER NOT NULL CHECK(months BETWEEN 1 AND 1200),
  residual_bp INTEGER NOT NULL CHECK(residual_bp BETWEEN 0 AND 10000),
  department TEXT NOT NULL,
  expense_account TEXT NOT NULL REFERENCES fin_accounts(code),
  status TEXT NOT NULL CHECK(status IN ('active','disposed')),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- 每期折旧
CREATE TABLE fin_depreciation(
  asset_id INTEGER NOT NULL REFERENCES fin_assets(id),
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  PRIMARY KEY(asset_id,period)
) STRICT;

-- 工资：应发 = 个人社保 + 个人公积金 + 个税 + 实发
CREATE TABLE fin_payroll(
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  department TEXT NOT NULL,
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  gross INTEGER NOT NULL CHECK(gross>=0),
  social INTEGER NOT NULL CHECK(social>=0),
  housing INTEGER NOT NULL CHECK(housing>=0),
  tax INTEGER NOT NULL CHECK(tax>=0),
  net INTEGER NOT NULL CHECK(net>=0),
  employer_social INTEGER NOT NULL CHECK(employer_social>=0),
  employer_housing INTEGER NOT NULL CHECK(employer_housing>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(period,employee_id),
  CHECK(gross=social+housing+tax+net)
) STRICT;

-- 月末存货成本；unit 取自库存品，只有“张”“只”。数量、金额可以为负（跨期调整），不加非负
CREATE TABLE fin_inventory_costs(
  stock_id INTEGER NOT NULL,
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  stock_name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('${RAW_UNIT}','${FINISHED_UNIT}')),
  opening_qty INTEGER NOT NULL,
  opening_cents INTEGER NOT NULL,
  in_qty INTEGER NOT NULL,
  in_cents INTEGER NOT NULL,
  out_qty INTEGER NOT NULL,
  out_cents INTEGER NOT NULL,
  end_qty INTEGER NOT NULL,
  end_cents INTEGER NOT NULL,
  PRIMARY KEY(stock_id,period)
) STRICT;

-- 销售成本明细，冲回的送货记负数
CREATE TABLE fin_cost_sales(
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  movement_id TEXT NOT NULL,
  order_id INTEGER,
  customer_id INTEGER,
  product_id INTEGER,
  cost_cents INTEGER NOT NULL,
  PRIMARY KEY(period,movement_id)
) STRICT;

-- 期末处理：折旧、工资、发工资、成本、税金、结转损益、年结各一行。
-- 撤回重做的留底改名成“原名#第几次”（server/finance/base/jobs.ts），所以 kind 是七个原名之一，或原名加 # 加从 1 起的序号
CREATE TABLE fin_period_jobs(
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  kind TEXT NOT NULL CHECK(
    CASE WHEN instr(kind,'#')=0
      THEN kind IN ('depreciation','payroll','payroll_pay','costing','tax','profit_close','annual_close')
      ELSE substr(kind,1,instr(kind,'#')-1) IN ('depreciation','payroll','payroll_pay','costing','tax','profit_close','annual_close')
        AND substr(kind,instr(kind,'#')+1) GLOB '[1-9]*'
        AND substr(kind,instr(kind,'#')+1) NOT GLOB '*[^0-9]*'
    END),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  details TEXT NOT NULL CHECK(json_valid(details)),
  PRIMARY KEY(period,kind)
) STRICT;

-- 结账时的报表快照，不可覆盖
CREATE TABLE fin_report_snapshots(
  period TEXT NOT NULL REFERENCES fin_periods(period),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  PRIMARY KEY(period,version)
) STRICT;

-- 科目预算
CREATE TABLE fin_budgets(
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(period,account_code)
) STRICT;
`;
