import { yuan, DataTable, col, mon } from '../../ui/index';
import { FinSection } from '../layout';
import { FIN_TABLE } from '../table';
import { useFinRead, type FinData } from '../fin-api';

/** 一个月的经营数 */
type Month = FinData<'GET /finance/monthly-report/trend'>[number];
const sign = (v: number) => (v < 0 ? 'fin-negative' : undefined);

/** 最近 12 个月的理论、实际盈亏，默认收起；点一行切到那个月。 */
export default function TrendSection({
  period,
  onPick,
}: {
  period: string;
  onPick: (period: string) => void;
}) {
  const { data } = useFinRead(['GET /finance/monthly-report/trend', { query: { period, months: 12 } }]);
  return (
    <FinSection title="最近 12 个月" note="点一行切到那个月" collapsed>
      <DataTable
        className={FIN_TABLE}
        label="最近 12 个月经营趋势"
        rows={data ?? []}
        rowKey={(r) => r.period}
        onRow={(r) => onPick(r.period)}
        selected={period}
        cols={[
          col('period', '月份'),
          // 和经营明细的详情面板同屏：1280 宽打开详情时收送货、到货两列，盈亏和实收实付一直显示
          { ...mon('theoreticalIncome', '送货'), priority: 'mid' },
          { ...mon('theoreticalExpense', '到货'), priority: 'mid' },
          col('theoreticalProfit', '理论盈亏', {
            money: true,
            render: (r: Month) => <span className={sign(r.theoreticalProfit)}>{yuan(r.theoreticalProfit)}</span>,
          }),
          mon('actualIncome', '实收'),
          mon('actualExpense', '实付'),
          col('actualProfit', '实际盈亏', {
            money: true,
            render: (r: Month) => <span className={sign(r.actualProfit)}>{yuan(r.actualProfit)}</span>,
          }),
        ]}
      />
    </FinSection>
  );
}
