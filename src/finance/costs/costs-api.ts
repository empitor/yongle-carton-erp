import { call, uploadFile } from '../../ui/index';
import {
  finRead,
  finWritten,
  requestId,
  uploadFailure,
  uploadQuery,
  type FinData,
  type FinanceWrites,
  type FinRequest,
} from '../fin-api';
import type { SubmitValues } from '../form-values';

/*
 * 费用资产工资的请求：固定资产和折旧、费用报销和员工借还款、工资、月末成本，几个列表一页一页的读法（给 FinList）。
 * 只读一次、跟着条件变的（工资发放情况、结账检查、算成本前要填的）页面用 useFinRead 直接读。
 */

/** 费用资产工资页的写入（一个写地址只由这个文件发） */
const send = call<FinanceWrites>();
/** 带版本号的一条记录：写入时带上版本，别人改过就被拒。 */
type Versioned = { id: number; version: number };
/** FinList 往查询参数里补的翻页 */
type PageQuery = { page: number; pageSize: number };
/** 页面填的内容（通用表单窗口交上来的，规则在服务端校验） */
type Values = SubmitValues;
/** 月末一步在结账页重做时带上的：重做、原凭证号；12 月的年度利润另带 annual */
export type PeriodJobExtra = { redo?: true; expectedVoucherId?: number | null; annual?: true };

/** 固定资产一行、费用单一行 */
export type AssetRow = FinData<'GET /finance/assets'>['rows'][number];
export type ExpenseRow = FinData<'GET /finance/expenses'>['rows'][number];

/**
 * 月末一步（计提折旧、计提工资、税费、结转）办完的一句话：服务端回了凭证号才说生成了待记账凭证；
 * 没有要记的数（没有在用资产、没有工资表）时不生成凭证，这一步照样算做过，不能说“已生成凭证”。
 */
export const accrualNotice = (label: string, result: { voucherId?: number | null } | null | undefined) =>
  result?.voucherId != null
    ? label + '已生成待记账凭证，到凭证页记账后才算完成。'
    : label + '已完成：这个月没有要记的数，没有生成凭证。';

/** 结账检查（只看月末几步跑没跑，不重算要不要重做），给 useFinRead */
export const closingJobs = (period: string): FinRequest<'GET /finance/closing'> => [
  'GET /finance/closing',
  { query: { period, stale: '0' } },
];
/** 月末这一步做完没有：结账检查的“月末几步”（key 是 jobs）里不缺它；还没读到是 false */
export function jobDone(check: FinData<'GET /finance/closing'> | null, kind: 'depreciation' | 'payroll') {
  const jobs = check?.steps.find((s) => s.key === 'jobs');
  return !!jobs && 'missing' in jobs && !jobs.missing.includes(kind);
}

/* ---------- 固定资产 ---------- */
export const listAssets = (query: PageQuery) => finRead('GET /finance/assets', { query });
export const listDepreciation = (query: { period: string } & PageQuery) =>
  finRead('GET /finance/depreciation', { query });
/** 计提折旧；结账页重做时带上 redo 和原凭证号 */
export const depreciate = (period: string, extra: PeriodJobExtra = {}) =>
  finWritten(send('POST /finance/depreciation', { body: { requestId: requestId(), period, ...extra } }));
export const saveAsset = (values: Values) =>
  finWritten(send('POST /finance/assets', { body: { requestId: requestId(), ...values } }));
/** 调部门或折旧科目 */
export const changeAsset = (asset: Versioned, values: Values) =>
  finWritten(
    send('PUT /finance/assets/:id', {
      params: { id: asset.id },
      body: { requestId: requestId(), ...values, version: asset.version },
    }),
  );
export const disposeAsset = (asset: Versioned, values: Values) =>
  finWritten(
    send('POST /finance/assets/:id/dispose', {
      params: { id: asset.id },
      body: { requestId: requestId(), ...values, version: asset.version },
    }),
  );

/* ---------- 费用报销 ---------- */
export const listExpenses = (query: PageQuery) => finRead('GET /finance/expenses', { query });
export const saveExpense = (values: Values, editing?: Versioned) =>
  finWritten(
    send('PUT /finance/expenses', {
      body: {
        requestId: requestId(),
        ...values,
        ...(editing ? { id: editing.id, version: editing.version } : {}),
      },
    }),
  );
/** 费用单往下走一步：提交审批、批准、付款、退回 */
export const moveExpense = (
  expense: Versioned,
  action: 'submit' | 'approve' | 'pay' | 'reject',
  values: Values = {},
) =>
  finWritten(
    send('POST /finance/expenses/:id/transition', {
      params: { id: expense.id },
      body: { requestId: requestId(), ...values, action, version: expense.version },
    }),
  );
export const saveEmployeeAdvance = (values: Values) =>
  finWritten(send('POST /finance/employee-advances', { body: { requestId: requestId(), ...values } }));

/* ---------- 工资 ---------- */
/** 工资列表：看员工明细（detail 是 1，要结账权限）或按部门的合计 */
export const listPayroll = async ({ detail, ...query }: { period: string; detail: 0 | 1 } & PageQuery) =>
  detail === 1
    ? await finRead('GET /finance/payroll?detail=1', { query })
    : await finRead('GET /finance/payroll', { query: { ...query, detail: '0' } });
/** 这个月工资的实发、已发、还剩，给 useFinRead */
export const payrollPayment = (period: string): FinRequest<'GET /finance/payroll/payment'> => [
  'GET /finance/payroll/payment',
  { query: { period } },
];
export const uploadPayroll = (period: string, file: File) =>
  finWritten(
    uploadFile(
      '/api/finance/payroll/upload' + uploadQuery({ period, format: /\.csv$/i.test(file.name) ? 'csv' : 'xlsx' }),
      file,
      uploadFailure(file),
    ),
  );
/** 计提工资；结账页重做时带上 redo 和原凭证号 */
export const accruePayroll = (period: string, extra: PeriodJobExtra = {}) =>
  finWritten(send('POST /finance/payroll/confirm', { body: { requestId: requestId(), period, ...extra } }));
export const payPayroll = (period: string, values: Values) =>
  finWritten(send('POST /finance/payroll/pay', { body: { requestId: requestId(), ...values, period } }));

/* ---------- 月末成本、毛利 ---------- */
export const listCosting = (query: { period: string } & PageQuery) => finRead('GET /finance/costing', { query });
export const listMargin = (query: { period: string; group: 'order' | 'customer' | 'product' | 'month' } & PageQuery) =>
  finRead('GET /finance/margin', { query });
/** 算（或重做）一个月的成本：期初成本、要补金额或对方科目的出入库 */
export const runCosting = (body: FinanceWrites['POST /finance/costing']['body']) =>
  finWritten(send('POST /finance/costing', { body: { requestId: requestId(), ...body } }));
