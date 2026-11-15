// 归前端财务-乙（costs 页）。财务接口表“费用资产工资”一块（服务端 server/finance/routes-period.ts 的 costRoutes）：费用和员工借还款、固定资产和折旧、工资。
// 回答照服务端各服务的返回值写（assets.ts、expenses.ts、payroll.ts、jobs.ts），服务端 route() 按它检查。
import type { Body, Page, Paging } from './finance-api-shapes.js';
import type { VoucherRecord } from './finance-api-ledger.js';

/** 固定资产（fin_assets 整行，金额是分，残值率按万分比存） */
type AssetRecord = {
  id: number;
  number: string;
  name: string;
  category: string;
  original_cents: number;
  date: string;
  months: number;
  residual_bp: number;
  department: string;
  expense_account: string;
  status: string;
  voucher_id: number | null;
  version: number;
};
/** 资产列表一行：资产加累计折旧、处置凭证三列 */
type AssetRow = AssetRecord & {
  accumulated: number;
  disposal_voucher_id: number | null;
  disposal_voucher_status: string | null;
  disposal_voucher_state: string | null;
};
/** 一个月的折旧明细一行 */
type DepreciationRow = {
  asset_id: number;
  period: string;
  amount_cents: number;
  voucher_id: number;
  number: string;
  name: string;
  department: string;
};
/**
 * 月末一步（计提折旧、计提工资、发放工资……，照 server/finance/jobs.ts）办完的结果：哪个月、哪一步、生成的凭证
 * （没有要记的数时是 null）和这一步的明细
 */
export type PeriodJobResult<Details> = { period: string; kind: string; voucherId: number | null; details: Details };
/** 费用单（fin_expenses 整行） */
type ExpenseRow = {
  id: number;
  employee_id: string;
  employee_name: string;
  department: string;
  date: string;
  account_code: string;
  amount_cents: number;
  description: string;
  status: string;
  invoice_id: number | null;
  attachment_id: number | null;
  voucher_id: number | null;
  cash_id: number | null;
  version: number;
};
/** 工资按部门的合计一行 */
type PayrollByDepartment = {
  department: string;
  employees: number;
  gross: number;
  net: number;
  social: number;
  housing: number;
  tax: number;
  employer_social: number;
  employer_housing: number;
};
/** 一个员工这个月的工资（fin_payroll 整行） */
type PayrollRow = Omit<PayrollByDepartment, 'employees'> & {
  id: number;
  period: string;
  employee_id: string;
  employee_name: string;
  account_code: string;
  version: number;
};
/** 一个月的工资查询：period 必给，可只看一个部门 */
type PayrollQuery = { period: string; department?: string } & Paging;

export type CostsApi = {
  /** 费用单列表，可按状态、员工筛 */
  'GET /finance/expenses': { query?: { status?: string; employeeId?: string } & Paging; response: Page<ExpenseRow> };
  'PUT /finance/expenses': { body: Body; response: ExpenseRow };
  'POST /finance/expenses/:id/transition': { body: Body; response: ExpenseRow };
  /** 员工借还款直接生成凭证，回凭证头和分录（页面不读） */
  'POST /finance/employee-advances': { body: Body; response: VoucherRecord };
  /** 固定资产列表，可按状态、部门筛 */
  'GET /finance/assets': { query?: { status?: string; department?: string } & Paging; response: Page<AssetRow> };
  'POST /finance/assets': { body: Body; response: AssetRecord };
  'PUT /finance/assets/:id': { body: Body; response: AssetRecord };
  /** 处置，回资产和处置凭证的编号 */
  'POST /finance/assets/:id/dispose': { body: Body; response: AssetRecord & { disposalVoucherId: number } };
  'GET /finance/depreciation': { query: { period: string } & Paging; response: Page<DepreciationRow> };
  /** 计提折旧：这个月的折旧合计和按科目分的几行 */
  'POST /finance/depreciation': {
    body: Body;
    response: PeriodJobResult<{ total: number; lines: { id: number; account: string; amount: number }[] }>;
  };
  /** 工资按部门的合计（detail=0） */
  'GET /finance/payroll': { query: PayrollQuery & { detail?: '0' }; response: Page<PayrollByDepartment> };
  /** 工资的员工明细（要结账权限） */
  'GET /finance/payroll?detail=1': { query: PayrollQuery; response: Page<PayrollRow> };
  /** 计提工资：工资成本、实发、各项挂账的合计和科目 */
  'POST /finance/payroll/confirm': {
    body: Body;
    response: PeriodJobResult<{
      cost: number;
      net: number;
      wagesAccount: string;
      totals: { social: number; housing: number; tax: number };
      accounts: { socialAccount?: string; housingAccount?: string; taxAccount?: string };
    }>;
  };
  /** 发放工资（可以分几次）：这次按收付款单拆开的几笔、已发、实发 */
  'POST /finance/payroll/pay': {
    body: Body;
    response: PeriodJobResult<{ payments: { cashId: number; amount: number }[]; paid: number; net: number }>;
  };
  /** 这个月工资的实发合计、已发、还剩、发了几次 */
  'GET /finance/payroll/payment': {
    query: { period: string };
    response: { period: string; net: number; paid: number; remaining: number; payments: number };
  };
};
