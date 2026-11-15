/* 财务给人看的叫法：页面和导出都从这里取，改一处两边一起变。 */
import { z } from 'zod';
import { MONTH_DAY_START, centsText } from '../core/index.js';

/**
 * 收付款的类型：一个类型一个叫法。界面（列表、筛选、详情、编辑窗、提示）和导出、
 * 月度台账里收付款那一行的标识（“收客户款 11-12 100.00”）都用这一份。
 */
export const cashKindNames = {
  receipt: '收客户款',
  payment: '付供应商款',
  income: '其他收入',
  outlay: '其他支出',
  transfer: '内部转账',
} as const;
/**
 * 没有单号的几种财务记录（压款利息、保证金和退回）：月度台账、导出、凭证“来源”里的标识
 * 和收付款一样写“叫法 月-日 金额”（“保证金 11-12 500.00”），不露内部编号。
 */
export const financeRecordNames = {
  interest: '压款利息',
  deposit: '保证金',
  deposit_refund: '退回保证金',
  deposit_apply: '保证金转抵',
} as const;
/**
 * 月度台账、概览的金额类型（metric）：页面（类型一栏、详情、下钻标题）和导出用这一份。
 * 保证金按钱的进出分：收到保证金是钱进来（客户交给我们的保证金，或我们交出去的被退回来），
 * 付出保证金是钱出去（我们交给供应商的保证金，或退给客户的）；一笔一笔的是哪种看单号一栏
 * （“保证金 11-13 200.00”“退回保证金 11-20 50.00”）。
 */
export const financeMetricNames = {
  theoreticalIncome: '送货',
  theoreticalExpense: '到货',
  actualIncome: '实收',
  actualExpense: '实付',
  discountIncome: '收到优惠',
  discountExpense: '给出优惠',
  interestIncome: '利息收入',
  interestExpense: '利息支出',
  depositIncome: '收到保证金',
  depositExpense: '付出保证金',
  ordered: '接单',
} as const;

/** 状态的颜色档：页面按它给状态上色，导出只用叫法 */
type StatusLevel = 'muted' | 'warning' | 'info' | 'success';
/**
 * 财务各表存进库的状态（server/finance/stored-values.ts，有测试逐个比对）和界面派生的几种 → 叫法、颜色档。
 * 发票、承兑票据有自己的叫法表（src/finance/cash/shared.ts）。
 */
export const financeStatuses: Record<string, readonly [string, StatusLevel]> = {
  draft: ['待确认', 'muted'],
  pending: ['待审核', 'warning'],
  approved: ['已审核', 'info'],
  posted: ['已记账', 'success'],
  void: ['已作废', 'muted'],
  confirmed: ['已确认', 'success'],
  cancelled: ['已撤销', 'muted'],
  open: ['未结账', 'info'],
  closed: ['已结账', 'success'],
  info_pending: ['待补税率', 'warning'],
  ready: ['可记账', 'info'],
  difference: ['有差异', 'warning'],
  source_deleted: ['单据已删', 'warning'],
  // 来源单据最近一次被看到时已经删了（fin_source_observations）
  deleted: ['已删除', 'muted'],
  cost_pending: ['待算成本', 'muted'],
  waiting_invoice: ['等发票', 'muted'],
  awaiting_allocation_reversal: ['待撤销核销', 'warning'],
  generated: ['已生成凭证', 'success'],
  before_opening: ['启用前', 'muted'],
  corrected: ['已更正', 'muted'],
  // 业务单据：凭证已被红字冲销的那条，和红字冲销它的那条（界面派生，不存库）
  red_reversed: ['已红字冲销', 'muted'],
  superseded: ['已替代', 'muted'],
  no_amount: ['无金额', 'muted'],
  acknowledged: ['已核对', 'muted'],
  resolved: ['已处理', 'muted'],
  submitted: ['待审批', 'warning'],
  rejected: ['已退回', 'muted'],
  paid: ['已付款', 'success'],
  in_use: ['在用', 'success'],
  active: ['有效', 'success'],
  disposed: ['已处置', 'muted'],
  sent: ['已发送', 'info'],
  known: ['已明确', 'success'],
  costed: ['已算成本', 'success'],
  // 核销记录：撤销的红字凭证还没记账时是 reversing，记账后（或原凭证没记账直接作废）是 revoked
  reversing: ['撤销待记账', 'warning'],
  revoked: ['已撤销', 'muted'],
  reversed: ['已冲销', 'muted'],
};
export const financeStatusName = (value: unknown): string | undefined => financeStatuses[String(value)]?.[0];
/** 凭证的 draft 和业务单据的“待确认”撞名，凭证上叫“未提交” */
export const voucherStatusName = (value: unknown) =>
  value === 'draft' ? '未提交' : financeStatusName(value);

/**
 * 送货、到货没算进理论金额时缺的是什么：明细（事件快照）里记着缺数量的写“缺数量或单位”，别的写“缺价格”。
 * 月度台账、概览明细的金额和状态、导出的金额一栏都用它。
 */
export function missingAmountName(detail: unknown) {
  const missing = typeof detail === 'object' && detail !== null && 'missing' in detail ? detail.missing : undefined;
  return Array.isArray(missing) && missing.includes('quantity') ? '缺数量或单位' : '缺价格';
}

/**
 * 月度台账、概览明细一行的状态：送货、到货只分“待补税率 / 缺价格（或缺数量或单位） / 可记账 / 已生成凭证”，
 * 接单行显示订单状态，收付款显示已确认、已记账。
 */
export function monthlyRowStatus(row: {
  metric?: unknown;
  status?: unknown;
  missing_tax?: unknown;
  amount?: unknown;
  detail?: unknown;
}): readonly [string, StatusLevel] {
  const status = String(row.status ?? '');
  if (row.metric === 'ordered') return [status, 'muted'];
  if (row.metric === 'theoreticalIncome' || row.metric === 'theoreticalExpense') {
    if (Number(row.missing_tax)) return ['待补税率', 'warning'];
    if (row.amount === null || status === 'info_pending') return [missingAmountName(row.detail), 'warning'];
    if (status === 'generated') return ['已生成凭证', 'success'];
    if (['ready', 'waiting_invoice', 'cost_pending'].includes(status)) return ['可记账', 'info'];
  }
  return financeStatuses[status] ?? [status, 'muted'];
}

/** 单据月份：收付款没核销到单据的那部分写“没核销到单据”；没有往来单据可核销的是预收预付；没有就是空 */
export function sourceMonthName(value: unknown) {
  if (value === 'advance') return '预收预付';
  if (value === 'unallocated') return '没核销到单据';
  return /^\d{4}-\d{2}$/.test(String(value)) ? String(value) : '';
}

/** 没有单号的记录：“叫法 月-日 金额” */
export const recordText = (name: string, date: unknown, cents: unknown) =>
  name + ' ' + String(date ?? '').slice(MONTH_DAY_START) + ' ' + centsText(Number(cents));
/** 按取值查叫法表（只认表里自己的键），没有返回 undefined */
const nameIn = (names: Readonly<Record<string, string>>, value: unknown) => {
  const key = String(value);
  return Object.hasOwn(names, key) ? names[key] : undefined;
};
/** 收付款没有单号：“收客户款 11-12 100.00”（类型、月-日、这笔收付款的总额） */
export const cashRecordText = (kind: unknown, date: unknown, cents: unknown) =>
  recordText(nameIn(cashKindNames, kind) ?? '收付款', date, cents);
/** 压款利息、保证金和退回同样写法：“保证金 11-12 500.00” */
export const financeRecordText = (kind: unknown, date: unknown, cents: unknown) =>
  recordText(nameIn(financeRecordNames, kind) ?? '财务记录', date, cents);

/** 月度台账明细（detail）里拼单号用的几项：收付款、没有单号的财务记录、手工凭证；不是对象时都没有 */
const nameDetail = z.object({
  cashId: z.unknown().optional(),
  cashKind: z.unknown().optional(),
  cashDate: z.unknown().optional(),
  cashTotal: z.unknown().optional(),
  recordKind: z.unknown().optional(),
  recordDate: z.unknown().optional(),
  recordTotal: z.unknown().optional(),
  voucherId: z.unknown().optional(),
});
type NameDetail = z.output<typeof nameDetail>;

/**
 * 月度台账一行的单号：收付款、压款利息、保证金没有单号，写“叫法 月-日 金额”（金额是这笔记录的总额）；
 * 手工凭证写“凭证 号”。没有单号返回空串。
 */
export function documentName(row: { number?: unknown; date?: unknown; detail?: unknown }) {
  const d: NameDetail = nameDetail.safeParse(row.detail).data ?? {};
  if (d.cashId != null && d.cashKind) return cashRecordText(d.cashKind, d.cashDate ?? row.date, d.cashTotal);
  if (d.recordKind) return financeRecordText(d.recordKind, d.recordDate ?? row.date, d.recordTotal);
  const number = typeof row.number === 'string' || typeof row.number === 'number' ? String(row.number) : '';
  return /^\d+$/.test(number) && d.voucherId ? '凭证 ' + number : number;
}
