import type { ReactNode } from 'react';
import { pageHref } from '../../../shared/core/index';
import { yuan } from '../../ui/index';
import type { FinData } from '../fin-api';

type Todo = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  href?: string;
  tone?: 'warning';
};
/** 概览要列的几样数：这个月的经营数、待处理和逾期、7 天内到期、能拿优惠的（还没读到的是 null） */
type TodoSources = {
  report: FinData<'GET /finance/monthly-report'> | null;
  summary: FinData<'GET /finance/summary'> | null;
  soon: FinData<'GET /finance/due-soon'> | null;
  discounts: FinData<'GET /finance/discount-opportunities'> | null;
  perms: { edit: boolean; approve: boolean };
  enabled: boolean;
};

/** 逾期没收、没付的，应收、应付各一行 */
function overdueTodos(summary: TodoSources['summary']) {
  return (summary?.overdue ?? []).map((o) => ({
    count: o.count,
    key: 'overdue-' + o.kind,
    label: o.kind === 'receivable' ? '逾期没收的客户欠款' : '逾期没付的供应商货款',
    value: o.count + ' 笔 · ' + yuan(o.amount) + ' 元',
    href: pageHref('finance-ar', { tab: 'soon' }),
    tone: 'warning' as const,
  }));
}

/** 概览“需要处理”一节：只列不为 0 的；没有权限去处理的只写数字，不给走不通的链接。 */
export function overviewTodos({ report, summary, soon, discounts, perms, enabled }: TodoSources): Todo[] {
  const missingTax = report?.missingTax ?? 0,
    missingPrice = report?.missingPrice ?? 0,
    events = summary?.events ?? 0,
    pendingApproval = summary?.pendingApproval ?? 0,
    dueSoon = soon?.filteredRecords ?? 0,
    discountable = discounts?.filteredRecords ?? 0;
  const items: (Todo & { count: number })[] = [
    {
      count: missingTax,
      key: 'tax',
      label: '待补税率的单据',
      value: missingTax + ' 张',
      href: perms.edit && enabled ? pageHref('finance-flow', { missing: true }) : undefined,
      tone: 'warning',
    },
    {
      // 服务端只给“没算进理论金额的”一个总数（缺价格、缺数量都在里面），分不出各几张，所以叫“缺价格或数量”
      count: missingPrice,
      key: 'price',
      label: '缺价格或数量、没算进理论金额的单据',
      value: missingPrice + ' 张',
      tone: 'warning',
    },
    {
      count: events,
      key: 'events',
      label: '记账前要处理的单据',
      value: events + ' 张',
      href: perms.edit ? pageHref('finance-ledger', { tab: 'events' }) : undefined,
    },
    {
      count: pendingApproval,
      key: 'approve',
      label: '待审核凭证',
      value: pendingApproval + ' 张',
      href: perms.approve ? pageHref('finance-ledger') : undefined,
    },
    ...overdueTodos(summary),
    {
      count: dueSoon,
      key: 'soon',
      label: '7 天内到期或已逾期',
      value: dueSoon + ' 笔',
      href: pageHref('finance-ar', { tab: 'soon' }),
    },
    {
      count: discountable,
      key: 'discount',
      label: '现在结清能拿优惠的单子',
      value: discountable + ' 笔',
      href: pageHref('finance-ar', { tab: 'discount' }),
    },
  ];
  return items.filter((item) => item.count > 0).map(({ count: _count, ...todo }) => todo);
}
