import { useState } from 'react';
import { UNITS_PER_QUANTITY } from '../../../shared/core/index';
import CostingDialog from './CostingDialog';
import { FinList, col, mon, type Col } from '../table';
import { PeriodInput, FinSection, type HeadFn } from '../layout';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { usePeriod } from '../page-state';
import { listCosting, listMargin } from './costs-api';

/** 毛利按什么分组 */
const groups = ['order', 'customer', 'product', 'month'] as const;
type Group = (typeof groups)[number];
const groupNames: Record<Group, string> = { order: '订单', customer: '客户', product: '产品', month: '月份' };
type MarginRow = FinData<'GET /finance/margin'>['rows'][number];
type CostingRow = FinData<'GET /finance/costing'>['rows'][number];

const marginCols = (group: Group): Col<MarginRow>[] => [
  col('group_id', groupNames[group] || '分组', {
    render: (r) => r.group_id ?? '未分配',
  }),
  mon('revenue', '收入'),
  mon('cost', '成本'),
  mon('margin', '毛利'),
];
/** 数量按千分之一存，显示时按 UNITS_PER_QUANTITY 换回 */
const costingCols: Col<CostingRow>[] = [
  col('stock_name', '库存品', { wrap: true }),
  col('unit', '单位'),
  col('opening_qty', '期初数量', { num: true, render: (r) => r.opening_qty / UNITS_PER_QUANTITY }),
  mon('opening_cents', '期初金额'),
  col('in_qty', '入库数量', { num: true, render: (r) => r.in_qty / UNITS_PER_QUANTITY }),
  mon('in_cents', '入库金额'),
  col('out_qty', '出库数量', { num: true, render: (r) => r.out_qty / UNITS_PER_QUANTITY }),
  mon('out_cents', '出库金额'),
  col('end_qty', '期末数量', { num: true, render: (r) => r.end_qty / UNITS_PER_QUANTITY }),
  mon('end_cents', '期末金额'),
];

/** 毛利：会计口径，要先算当月成本。 */
function MarginSection({ period }: { period: string }) {
  const [group, setGroup] = useState<Group>('order');
  return (
    <FinSection
      id="margin"
      title="毛利"
      note="会计口径，要先算当月成本；和理论盈亏是两回事"
      extra={
        <select
          aria-label="毛利维度"
          value={group}
          onChange={(e) => {
            const next = groups.find((g) => g === e.target.value);
            if (next) setGroup(next);
          }}
        >
          <option value="order">按订单</option>
          <option value="customer">按客户</option>
          <option value="product">按产品</option>
          <option value="month">按月</option>
        </select>
      }
    >
      <FinList
        list={listMargin}
        label="毛利"
        query={{ period, group }}
        rowKey={(r, i) => r.group_id ?? i}
        empty="这个月没有毛利数据，先算成本"
        cols={marginCols(group)}
      />
    </FinSection>
  );
}

/** 成本毛利：月末算库存成本（主按钮，窗口里先填系统算不出来的），下面是毛利。 */
export default function CostingTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [open, setOpen] = useState(false);
  const rows = useFinRead(['GET /finance/costing', { query: { period, pageSize: 1 } }]);
  const done = Number(rows.data?.filteredRecords || 0) > 0;
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        // 算过的月份不再给主按钮，重做放在“更多”里，窗口里会说清楚要冲销原凭证
        primary:
          perms.close && !done ? { label: '计算 ' + period + ' 成本', onClick: () => setOpen(true) } : null,
        more: perms.close && done ? [{ label: '重做 ' + period + ' 成本', onClick: () => setOpen(true) }] : [],
      })}
      {open && <CostingDialog period={period} close={() => setOpen(false)} />}
      <FinSection id="costing" title="库存成本" note="月末加权平均；数量单位各算各的，不换算">
        <FinList
          list={listCosting}
          label="库存成本"
          query={{ period }}
          rowKey={(r) => r.stock_id}
          empty={perms.close ? '这个月还没算成本，点页面上方的“计算成本”' : '这个月还没算成本'}
          cols={costingCols}
        />
      </FinSection>
      <MarginSection period={period} />
    </>
  );
}
