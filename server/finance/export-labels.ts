import { textCell } from './export-workbook.js';

const metrics: Record<string, string> = {
  theoreticalIncome: '送货',
  theoreticalExpense: '到货',
  actualIncome: '实收',
  actualExpense: '实付',
  ordered: '接单',
  discountIncome: '优惠收入',
  discountExpense: '优惠支出',
  interestIncome: '利息收入',
  interestExpense: '利息支出',
  depositIncome: '保证金收取',
  depositExpense: '保证金支付',
};
const statuses: Record<string, string> = {
  draft: '草稿',
  pending: '待审核',
  approved: '已审核',
  posted: '已记账',
  void: '已作废',
  confirmed: '已确认',
  cancelled: '已撤销',
  reversed: '已冲销',
  ready: '待制单',
  generated: '已生成凭证',
  info_pending: '待补资料',
  waiting_invoice: '待开票',
  difference: '待核对',
  source_deleted: '来源已删除',
  cost_pending: '待计算成本',
  costed: '已计算成本',
  no_amount: '无金额',
  corrected: '已更正',
  awaiting_allocation_reversal: '待撤销核销',
  before_opening: '启用前',
};
const known = (values: Record<string, string>, key: string, fallback: string) =>
  Object.hasOwn(values, key) ? values[key] : fallback;
export const metricLabel = (value: unknown) => known(metrics, textCell(value), '其他');
export const partyLabel = (value: unknown) =>
  value === 'receivable' ? '应收' : value === 'payable' ? '应付' : '未分类';
export function statusLabel(value: unknown) {
  const status = textCell(value);
  return known(statuses, status, status && !/\p{Script=Han}/u.test(status) ? '未知状态' : status);
}
export function sourceMonthLabel(value: unknown) {
  const month = textCell(value);
  if (/^\d{4}-\d{2}$/.test(month)) return month;
  if (month === 'advance') return '预收预付';
  if (month === 'unallocated') return '未核销';
  return '';
}
