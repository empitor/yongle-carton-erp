/**
 * 财务的表（fin_ 开头）分四个文件，按建表顺序：总账（这里：设置、科目、期间、期初、凭证、分录、业务事件、凭证模板）、
 * 往来和资金（finance-dealings.ts）、发票费用资产成本和期末（finance-costs.ts），预置数据在 finance-seed.ts。
 * fin_vouchers 和 fin_events 互相引用，SQLite 建表时不要求被引用的表已经存在。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 *
 * 约束的写法：
 * - 状态、种类这些固定的取值都列了枚举；用户自己填的文字（资产类别、发票类型、现金流量项目）不列。
 * - 金额能为负的（红冲、冲减后的往来、成本）不加非负；只有代码保证为正的才加。
 * - fin_events.problem、fin_statements.discrepancy 是给人看的文字，不是 JSON。
 */
import { isDate, isJsonArray, isJsonObject, isPeriod, isPeriodOrNull } from './checks.js';

export const financeLedgerTables = `
-- - 金额都是整数分；能为负的（红冲、冲减后的往来、成本、跨期调整、分期）不加非负约束。
-- - 状态、种类的取值在 server/finance/base/stored-values.ts，测试逐个和建表 CHECK 比对；页面下拉也要的收付方式、账期方式在 shared/finance/finance.ts。
-- - 含税口径只用 orderTaxModes 一份；fin_party_terms.tax_mode 另认旧写法“不含税”（等于未税）。
-- - 新库预置财务设置一行、科目 93 个、凭证模板 11 个（server/core/schema/tables/finance-seed.ts，按第 20 版冻结，要改得写升级步骤）。
-- - 凭证、财务事件、往来、收付款单、发票的编号连财务一起初始化后也不从头来。

-- 财务设置，只有一行
CREATE TABLE fin_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  start_period TEXT CHECK(${isPeriodOrNull('start_period')}),
  taxpayer TEXT CHECK(taxpayer IS NULL OR taxpayer IN ('general','small')),
  require_separate_approver INTEGER NOT NULL DEFAULT 1 CHECK(require_separate_approver IN (0,1)),
  revenue_recognition TEXT NOT NULL DEFAULT 'delivery' CHECK(revenue_recognition IN ('delivery','invoice')),
  cost_allocation TEXT NOT NULL DEFAULT 'output' CHECK(cost_allocation IN ('output','material')),
  aging_days TEXT NOT NULL DEFAULT '[30,60,90,180,365]' CHECK(${isJsonArray('aging_days')}),
  tax_rates TEXT NOT NULL DEFAULT '{"smallVat":null,"urban":null,"education":null,"localEducation":null,"income":null}' CHECK(${isJsonObject('tax_rates')})
) STRICT;

-- 财务设置的变更历史：每改一次记一行改完以后的样子。某个时间点按什么口径（收入确认方式等），查这里，不查审计。
-- 新库不预置行：一次都没改过就是 fin_settings 的默认值。初始化时跟着财务设置保留。
CREATE TABLE fin_settings_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at TEXT NOT NULL,
  settings_version INTEGER NOT NULL,
  taxpayer TEXT CHECK(taxpayer IS NULL OR taxpayer IN ('general','small')),
  require_separate_approver INTEGER NOT NULL CHECK(require_separate_approver IN (0,1)),
  revenue_recognition TEXT NOT NULL CHECK(revenue_recognition IN ('delivery','invoice')),
  cost_allocation TEXT NOT NULL CHECK(cost_allocation IN ('output','material')),
  aging_days TEXT NOT NULL CHECK(${isJsonArray('aging_days')}),
  tax_rates TEXT NOT NULL CHECK(${isJsonObject('tax_rates')}),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL
) STRICT;
CREATE INDEX fin_settings_history_at ON fin_settings_history(changed_at,id);

-- 会计科目；科目代码是 4、6、8、10 位数字；auxiliary 存的是辅助核算的种类，不是 JSON
CREATE TABLE fin_accounts(
  code TEXT PRIMARY KEY CHECK(length(code) IN (4,6,8,10) AND code NOT GLOB '*[^0-9]*'),
  parent_code TEXT REFERENCES fin_accounts(code),
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('asset','liability','equity','cost','profit')),
  direction TEXT NOT NULL CHECK(direction IN ('debit','credit')),
  cash_kind TEXT CHECK(cash_kind IS NULL OR cash_kind IN ('cash','bank')),
  auxiliary TEXT CHECK(auxiliary IS NULL OR auxiliary IN ('customer','supplier','department','employee','project')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1))
) STRICT;
CREATE INDEX fin_accounts_parent ON fin_accounts(parent_code);

-- 会计期间和结账状态
CREATE TABLE fin_periods(
  period TEXT PRIMARY KEY CHECK(${isPeriod('period')}),
  status TEXT NOT NULL CHECK(status IN ('open','closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- 期初余额和年累计；辅助核算的三列（种类、编号、名称）要么都有要么都没有
CREATE TABLE fin_opening(
  id INTEGER PRIMARY KEY,
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  auxiliary_kind TEXT CHECK(auxiliary_kind IS NULL OR auxiliary_kind IN ('customer','supplier','department','employee','project')),
  auxiliary_id TEXT,
  auxiliary_name TEXT,
  debit INTEGER NOT NULL CHECK(debit>=0),
  credit INTEGER NOT NULL CHECK(credit>=0),
  year_debit INTEGER NOT NULL CHECK(year_debit>=0),
  year_credit INTEGER NOT NULL CHECK(year_credit>=0),
  CHECK((auxiliary_kind IS NULL)=(auxiliary_id IS NULL) AND (auxiliary_kind IS NULL)=(auxiliary_name IS NULL))
) STRICT;
CREATE UNIQUE INDEX fin_opening_key ON fin_opening(account_code,coalesce(auxiliary_id,''));

-- 凭证。编号用 AUTOINCREMENT：连财务一起初始化以后编号不从头来，不会和审计里的旧编号混在一起。
-- period 就是 date 的年月；module_source、module_id 是生成这张凭证的财务功能和那边的记录编号，一起有或一起没有。
-- 红字凭证用 reversal_of 指原凭证
CREATE TABLE fin_vouchers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  period TEXT NOT NULL REFERENCES fin_periods(period),
  description TEXT NOT NULL,
  attachment_count INTEGER NOT NULL CHECK(attachment_count BETWEEN 0 AND 10000),
  event_id INTEGER REFERENCES fin_events(id),
  reversal_of INTEGER REFERENCES fin_vouchers(id),
  status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','posted','void')),
  maker_id TEXT NOT NULL,
  maker_name TEXT NOT NULL,
  approver_id TEXT,
  approver_name TEXT,
  approved_at TEXT,
  poster_id TEXT,
  poster_name TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  module_source TEXT CHECK(module_source IS NULL OR module_source IN ('asset','asset_disposal','depreciation','tax','profit_close','annual_close','costing','expense','employee_advance','invoice','note','bad_debt','obligation','payroll','cash','deposit','interest','event_reversal','purchase_return')),
  module_id INTEGER,
  UNIQUE(period,number),
  CHECK(substr(date,1,7)=period),
  CHECK((module_source IS NULL)=(module_id IS NULL))
) STRICT;
CREATE INDEX fin_voucher_module ON fin_vouchers(module_source,module_id);
-- 红冲关系的普通索引：下面那条唯一索引只管没作废的，删凭证时数据库按 reversal_of 找引用它的行用不上
CREATE INDEX fin_vouchers_reversal_of ON fin_vouchers(reversal_of);
CREATE UNIQUE INDEX fin_vouchers_event ON fin_vouchers(event_id) WHERE event_id IS NOT NULL AND status<>'void';
CREATE UNIQUE INDEX fin_vouchers_reversal ON fin_vouchers(reversal_of) WHERE reversal_of IS NOT NULL AND status<>'void';

-- 凭证分录；辅助核算存种类、编号、名称快照，三列要么都有要么都没有；cash_flow 是用户填的现金流量项目，不列枚举
CREATE TABLE fin_entries(
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  position INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  description TEXT NOT NULL,
  debit INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  auxiliary_kind TEXT CHECK(auxiliary_kind IS NULL OR auxiliary_kind IN ('customer','supplier','department','employee','project')),
  auxiliary_id TEXT,
  auxiliary_name TEXT,
  cash_flow TEXT,
  CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)),
  CHECK((auxiliary_kind IS NULL)=(auxiliary_id IS NULL) AND (auxiliary_kind IS NULL)=(auxiliary_name IS NULL)),
  PRIMARY KEY(voucher_id,position)
) STRICT;
CREATE INDEX fin_entries_account ON fin_entries(account_code,voucher_id);

-- 财务事件（业务事件，由业务单据生成，待生成凭证），一张业务单据一条。编号用 AUTOINCREMENT，初始化后不从头来。
-- snapshot 是来源单据财务口径和算好的金额的 JSON 快照；amount_cents 是记账金额（送货含税、到货不含税）；problem 是给人看的文字，不是 JSON。
-- snapshot 后面几列（第 21 步加的）：
--
-- - 只存在列里的：接手的上一条 previous_event_id 和它当时的状态 previous_status，同步时按单据算的金额 document_cents。
-- - 从快照取出来的查询列：往来单位 party_kind（customer、supplier，和 party_id 同有同无）、party_name，
--   单号 source_number（没有取对方单号），理论金额 theoretical_cents（含税），缺税率 missing_tax。
--   只由 server/finance/events/event-columns.ts 和快照在同一句里一起写；SQL 查这几项读列。
CREATE TABLE fin_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('delivery','arrival','production','stock')),
  source_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('delivery.confirmed','delivery.reversed','production.completed','stock.adjusted','arrival.confirmed','arrival.corrected')),
  source_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR amount_cents>=0),
  status TEXT NOT NULL CHECK(status IN ('ready','info_pending','waiting_invoice','generated','difference','source_deleted','awaiting_allocation_reversal','cost_pending','costed','no_amount','corrected','superseded','before_opening')),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  problem TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  revenue_recognition TEXT CHECK(revenue_recognition IS NULL OR revenue_recognition IN ('delivery','invoice')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  previous_event_id INTEGER REFERENCES fin_events(id),
  previous_status TEXT CHECK(previous_status IS NULL OR previous_status IN ('ready','info_pending','waiting_invoice','generated','difference','source_deleted','awaiting_allocation_reversal','cost_pending','costed','no_amount','corrected','superseded','before_opening')),
  party_kind TEXT CHECK(party_kind IS NULL OR party_kind IN ('customer','supplier')),
  party_id TEXT CHECK((party_kind IS NULL)=(party_id IS NULL)),
  party_name TEXT,
  source_number TEXT,
  document_cents INTEGER,
  theoretical_cents INTEGER,
  missing_tax INTEGER NOT NULL DEFAULT 0 CHECK(missing_tax IN (0,1)),
  UNIQUE(source_kind,source_id,event_type,source_version)
) STRICT;
CREATE INDEX fin_events_status ON fin_events(status,date,id);
CREATE INDEX fin_events_voucher ON fin_events(voucher_id);
CREATE INDEX fin_events_previous ON fin_events(previous_event_id);
CREATE INDEX fin_events_party ON fin_events(party_kind,party_id);

-- 业务单据最近一次被财务看到的版本；status 的 deleted 是财务已经处理过它被删除（被删的分流只做一次）
CREATE TABLE fin_source_observations(
  source_kind TEXT NOT NULL CHECK(source_kind IN ('delivery','arrival','production','stock')),
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','reversed','deleted')),
  event_id INTEGER NOT NULL REFERENCES fin_events(id),
  PRIMARY KEY(source_kind,source_id)
) STRICT;
CREATE INDEX fin_source_observations_event ON fin_source_observations(event_id);

-- 凭证模板：只有建库时预置的这 11 个，运行时只改科目映射 mapping
CREATE TABLE fin_templates(
  name TEXT PRIMARY KEY CHECK(name IN ('delivery.confirmed','arrival.confirmed','settlement.discount','deposit','interest','notes','bad_debt','expense','asset','payroll','inventory')),
  mapping TEXT NOT NULL CHECK(${isJsonObject('mapping')}),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;
`;
