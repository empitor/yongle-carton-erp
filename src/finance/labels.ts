import {
  cashRecordText,
  documentName as sharedDocumentName,
  financeMetricNames,
  financeRecordNames,
  recordText,
  sourceMonthName as sharedSourceMonthName,
} from '../../shared/finance/index';

/* 单据、凭证来源、金额类型这些给人看的叫法：不露内部代码和编号。 */

/** 财务事件的来源种类（fin_events.source_kind），事件页、凭证面板共用 */
export const eventSourceNames: Record<string, string> = {
  delivery: '送货',
  arrival: '到货',
  production: '完工',
  stock: '盘点',
};
/** 凭证由哪个财务功能生成（fin_vouchers.module_source，和 server/finance/stored-values.ts 的 voucherModuleSources 一一对应，有测试比对） */
export const voucherModuleNames: Record<string, string> = {
  asset: '固定资产入账',
  asset_disposal: '固定资产处置',
  depreciation: '计提折旧',
  tax: '税费计提',
  profit_close: '结转损益',
  annual_close: '年度结转',
  costing: '成本结转',
  expense: '费用报销',
  employee_advance: '员工借支',
  invoice: '发票',
  note: '承兑票据',
  bad_debt: '坏账',
  obligation: '往来单',
  payroll: '工资计提',
  cash: '收付款',
  deposit: financeRecordNames.deposit,
  interest: financeRecordNames.interest,
  event_reversal: '红字冲销',
  purchase_return: '退货冲暂估',
};
/** 按月生成的凭证，module_id 是期间（如 202610） */
const periodModules = ['depreciation', 'tax', 'profit_close', 'annual_close', 'costing', 'payroll'];
/** 期间 202610 写成 2026-10：年份占几位 */
const YEAR_DIGITS = 4;

/** 凭证来源里的业务单据（财务事件，server/finance/voucher-read.ts 的 voucherDetail）：种类、编号和单号 */
type SourceEvent = { source_kind: string; source_id: string; number: string | null };
/** 凭证来源里没有单号的那笔记录（收付款、保证金和退回转抵、压款利息）：种类、日期、金额（分） */
type SourceRecord = { kind: string | null; date: string; amount: number };
/** 凭证详情的“来源”：业务单据，或生成它的财务功能（module、module_id）、红冲的那条单据、没有单号的那笔记录（没有的是 null 或不带） */
type VoucherSource =
  | SourceEvent
  | { module: string; id: number | null; event?: SourceEvent | null; record?: SourceRecord | null };

const eventText = (e: SourceEvent) =>
  (eventSourceNames[e.source_kind] || '业务单据') + ' ' + (e.number || e.source_id);
const isRecordKind = (kind: string | null): kind is keyof typeof financeRecordNames =>
  kind !== null && Object.hasOwn(financeRecordNames, kind);
/** 没有单号的记录的叫法：保证金和退回、转抵按 kind；别的（利息的 kind 是空）用生成凭证的功能名 */
const recordName = (kind: string | null, fallback: string) =>
  isRecordKind(kind) ? financeRecordNames[kind] : fallback;
/** 凭证面板“来源”一栏：中文叫法加单号，不露出内部代码 */
export function voucherSourceText(source: VoucherSource | null): string | null {
  if (!source) return null;
  if ('source_kind' in source) return eventText(source);
  const name = voucherModuleNames[source.module] || '其他财务功能';
  if (source.module === 'event_reversal')
    return source.event ? name + ' · ' + eventText(source.event) : name;
  const period = String(source.id ?? '');
  if (periodModules.includes(source.module) && /^\d{6}$/.test(period))
    return name + ' ' + period.slice(0, YEAR_DIGITS) + '-' + period.slice(YEAR_DIGITS);
  // 收付款、保证金、压款利息没有单号：服务端带上那笔记录（record），写“收客户款 11-12 100.00”，不露内部编号。
  // 保证金的退回、转抵也挂在保证金上，record.kind 写明是哪一种（deposit_refund、deposit_apply），按它的叫法和日期金额写
  const { record } = source;
  if (record)
    return source.module === 'cash'
      ? cashRecordText(record.kind, record.date, record.amount)
      : recordText(recordName(record.kind, name), record.date, record.amount);
  return name;
}

/** 月度台账、概览的金额类型：和导出同一份叫法 */
export const metricNames: Record<string, string> = financeMetricNames;
/** 单号一栏（写法见 shared/finance/labels.ts 的 documentName）；没有单号写“—” */
export const documentName = (row: Parameters<typeof sharedDocumentName>[0]) => sharedDocumentName(row) || '—';
/** 单据月份；没有写“—” */
export const sourceMonthName = (v: unknown) => sharedSourceMonthName(v) || '—';

/**
 * 来源页面上派生凭证（票据、资产处置、费用报销、坏账、压款利息、保证金）的两个动作：
 * 没记账的撤回（凭证作废），已记账的红字冲销（出一张红字凭证）。撤了以后来源回到生成凭证之前。
 */
export const sourceVoucherActions = {
  withdraw: {
    label: '撤回',
    title: '撤回凭证',
    intro: '这张凭证还没记账，撤回就是作废它，来源回到生成凭证之前。',
    notice: '凭证已撤回。',
  },
  reverse: {
    label: '红字冲销',
    title: '红字冲销凭证',
    intro: '这张凭证已经记账，红字冲销会出一张红字凭证，日期是下面填的那天；来源回到生成凭证之前。',
    notice: '已红字冲销。',
  },
} as const;
/** 保证金本身的凭证撤回或红冲以后（deposits 的 voucher_state），列表上的标记 */
export const voucherStateNames: Record<string, string> = { withdrawn: '已撤回', reversed: '已红冲' };
