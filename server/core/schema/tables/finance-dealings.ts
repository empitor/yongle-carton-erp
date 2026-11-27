/** 财务的往来和资金：账期、应收应付、资金账户和收付款、核销、分期、定金、利息、坏账、对账单、银行流水、票据、附件。约束的写法见 finance-ledger.ts 开头。 */
import { isDate, isDateOrNull, isPeriod } from './checks.js';

export const financeDealingTables = `
-- 往来单位的账期（term_type：none、days、monthly）、税率和授信。这里的 kind 是客户还是供应商（和应收应付表的 kind 不是一回事）；
-- tax_rate 是 0～100 的数字文本，末尾可以带 %（发票表的税率不带 %，两边写法不同，按现状各管各的）
CREATE TABLE fin_party_terms(
  kind TEXT NOT NULL CHECK(kind IN ('customer','supplier')),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  term_days INTEGER NOT NULL CHECK(term_days BETWEEN 0 AND 3650),
  credit_limit INTEGER CHECK(credit_limit IS NULL OR credit_limit>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  tax_rate TEXT CHECK(tax_rate IS NULL OR (rtrim(tax_rate,'%') GLOB '[0-9]*' AND rtrim(tax_rate,'%') NOT GLOB '*[^0-9.]*' AND CAST(rtrim(tax_rate,'%') AS REAL) BETWEEN 0 AND 100)),
  tax_mode TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('含税','未税','不含税')),
  term_type TEXT NOT NULL DEFAULT 'days' CHECK(term_type IN ('none','days','monthly')),
  term_months INTEGER CHECK(term_months IS NULL OR term_months BETWEEN 0 AND 120),
  payment_day INTEGER CHECK(payment_day IS NULL OR payment_day BETWEEN 1 AND 31),
  cutoff_day INTEGER CHECK(cutoff_day IS NULL OR cutoff_day BETWEEN 1 AND 31),
  options TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(options)),
  PRIMARY KEY(kind,party_id)
) STRICT;

-- 应收应付。编号用 AUTOINCREMENT，初始化后不从头来。amount_cents 红冲时为负，不加非负；红冲的 reversal_of 指原往来
CREATE TABLE fin_obligations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  due_date TEXT CHECK(${isDateOrNull('due_date')}),
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  event_id INTEGER REFERENCES fin_events(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  tax_status TEXT NOT NULL DEFAULT 'known' CHECK(tax_status IN ('known','pending','superseded')),
  reversal_of INTEGER REFERENCES fin_obligations(id),
  opening_id INTEGER REFERENCES fin_opening(id),
  terms_snapshot TEXT CHECK(terms_snapshot IS NULL OR json_valid(terms_snapshot)),
  estimate_voucher_id INTEGER REFERENCES fin_vouchers(id),
  estimate_remaining INTEGER CHECK(estimate_remaining IS NULL OR estimate_remaining>=0)
) STRICT;
CREATE UNIQUE INDEX fin_obligation_opening ON fin_obligations(opening_id) WHERE opening_id IS NOT NULL;
CREATE INDEX fin_obligations_event ON fin_obligations(event_id);
CREATE INDEX fin_obligations_party ON fin_obligations(kind,party_id,date);
CREATE INDEX fin_obligations_reversal ON fin_obligations(reversal_of);

-- 资金账户；last_four 是银行账号后四位
CREATE TABLE fin_cash_accounts(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('cash','bank','wechat','alipay','other')),
  account_code TEXT NOT NULL UNIQUE REFERENCES fin_accounts(code),
  last_four TEXT CHECK(last_four IS NULL OR (length(last_four)=4 AND last_four NOT GLOB '*[^0-9]*')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- 收付款单。编号用 AUTOINCREMENT，初始化后不从头来。cash_flow 是用户填的现金流量项目，不列枚举
CREATE TABLE fin_cash_documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('receipt','payment','transfer','income','outlay')),
  account_id INTEGER NOT NULL REFERENCES fin_cash_accounts(id),
  target_account_id INTEGER REFERENCES fin_cash_accounts(id),
  party_id TEXT,
  party_name TEXT,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  method TEXT NOT NULL CHECK(method IN ('现金','银行','承兑汇票','微信','支付宝','其他')),
  description TEXT NOT NULL,
  counter_account TEXT,
  cash_flow TEXT,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;
CREATE INDEX fin_cash_account_date ON fin_cash_documents(account_id,date);

-- 收付款核销（含反向核销、现结优惠、多付转抵）。金额红冲时为负，只要求不为 0
CREATE TABLE fin_allocations(
  id INTEGER PRIMARY KEY,
  cash_id INTEGER NOT NULL REFERENCES fin_cash_documents(id),
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents<>0),
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0,1)),
  reversal_of INTEGER REFERENCES fin_allocations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reversing','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT
) STRICT;
CREATE INDEX fin_alloc_cash ON fin_allocations(cash_id,date);
CREATE INDEX fin_alloc_obligation ON fin_allocations(obligation_id,date);
CREATE UNIQUE INDEX fin_alloc_reversal ON fin_allocations(reversal_of) WHERE reversal_of IS NOT NULL;

-- 分期。金额跟着往来金额按比例重算，没有加非负（往来被红票冲减后能不能到 0 以下没有完全证实）
CREATE TABLE fin_installments(
  id INTEGER PRIMARY KEY,
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  position INTEGER NOT NULL CHECK(position>=1),
  due_date TEXT CHECK(${isDateOrNull('due_date')}),
  amount_cents INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(obligation_id,position)
) STRICT;

-- 押金、保证金：kind 是付出去的还是收进来的
CREATE TABLE fin_deposits(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('paid','received')),
  party_kind TEXT NOT NULL CHECK(party_kind IN ('customer','supplier')),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  description TEXT NOT NULL,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- 押金、保证金的退还、抵扣（转抵）；抵扣（apply）必须指明抵哪张往来单
CREATE TABLE fin_deposit_actions(
  id INTEGER PRIMARY KEY,
  deposit_id INTEGER NOT NULL REFERENCES fin_deposits(id),
  kind TEXT NOT NULL CHECK(kind IN ('refund','apply')),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  obligation_id INTEGER REFERENCES fin_obligations(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  CHECK(kind<>'apply' OR obligation_id IS NOT NULL)
) STRICT;
CREATE INDEX fin_deposit_actions_deposit ON fin_deposit_actions(deposit_id);
CREATE INDEX fin_deposit_actions_obligation ON fin_deposit_actions(obligation_id);

-- 逾期利息（经人确认的压款利息），一次确认一行；免除的记 0。date 是这次算到哪一天（也是凭证日期），period 是它的年月。
-- 一个月可以确认几次，下一次从上次算到的那天之后接着算，不重叠由程序保证（server/finance/parties/deposits-interest.ts）
CREATE TABLE fin_interest(
  id INTEGER PRIMARY KEY,
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  period TEXT NOT NULL CHECK(${isPeriod('period')}),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  reason TEXT NOT NULL,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  CHECK(substr(date,1,7)=period)
) STRICT;
CREATE INDEX fin_interest_obligation ON fin_interest(obligation_id,date);

-- 坏账核销（writeoff）、计提（provision），以及承兑票据结算往来（note）。
-- 票据结算转回、退票记负数，所以只有核销和计提要求金额为正
CREATE TABLE fin_bad_debts(
  id INTEGER PRIMARY KEY,
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  kind TEXT NOT NULL CHECK(kind IN ('writeoff','provision','note')),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  CHECK(kind='note' OR amount_cents>0)
) STRICT;
CREATE INDEX fin_bad_debts_obligation ON fin_bad_debts(obligation_id);

-- 对账单；discrepancy 是对账差异的文字说明（没有差异是空字符串），不是 JSON
CREATE TABLE fin_statements(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
  party_id TEXT NOT NULL,
  from_date TEXT NOT NULL CHECK(${isDate('from_date')}),
  to_date TEXT NOT NULL CHECK(${isDate('to_date')}),
  status TEXT NOT NULL CHECK(status IN ('sent','confirmed','difference')),
  discrepancy TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(kind,party_id,from_date,to_date),
  CHECK(from_date<=to_date)
) STRICT;

-- 银行流水
CREATE TABLE fin_bank_rows(
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES fin_cash_accounts(id),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents<>0),
  reference TEXT,
  party_name TEXT NOT NULL,
  description TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  entry_position INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(voucher_id,entry_position)
) STRICT;
CREATE INDEX fin_bank_date ON fin_bank_rows(account_id,date);

-- 银行流水和分录的勾对
CREATE TABLE fin_bank_matches(
  bank_id INTEGER NOT NULL REFERENCES fin_bank_rows(id),
  voucher_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(bank_id,voucher_id,position),
  UNIQUE(voucher_id,position),
  FOREIGN KEY(voucher_id,position) REFERENCES fin_entries(voucher_id,position)
) STRICT;

-- 承兑票据：应收票据、应付票据
CREATE TABLE fin_notes(
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
  bank TEXT NOT NULL,
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  due_date TEXT NOT NULL CHECK(${isDate('due_date')}),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  status TEXT NOT NULL CHECK(status IN ('held','endorsed','discounted','matured','returned','cancelled')),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(kind,number),
  CHECK(due_date>=date)
) STRICT;

-- 财务附件，按 SHA-256 去重；media_type 按文件头判断，认不出的记 application/octet-stream
CREATE TABLE fin_attachments(
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','application/pdf','application/octet-stream')),
  created_at TEXT NOT NULL,
  bytes BLOB NOT NULL
) STRICT;
`;
