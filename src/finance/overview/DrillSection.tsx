import { yuan, col } from '../../ui/index';
import { missingAmountName, type financeMetricNames } from '../../../shared/finance/index';
import type { FinData } from '../fin-api';
import { FinList } from '../table';
import { listMonthlyDetail } from './overview-api';
import { FinSection, ExportLink } from '../layout';
import { FlowStatus } from '../status';
import { documentName, metricNames, sourceMonthName } from '../labels';

/** 点开的是哪项金额（送货、到货、实收……），和只看哪个单据月份 */
export type Drill = { metric: keyof typeof financeMetricNames; sourceMonth?: string };
/** 经营明细的一行（月度台账的明细行） */
export type DrillRow = FinData<'GET /finance/monthly-report/detail'>['rows'][number];

/** 点开某个金额后的经营明细：一行一笔，点一行在右侧看详情。 */
export default function DrillSection({
  drill,
  period,
  onRow,
  onClose,
}: {
  drill: Drill;
  period: string;
  onRow: (row: DrillRow) => void;
  onClose: () => void;
}) {
  const query = { period, metric: drill.metric, sourceMonth: drill.sourceMonth };
  return (
    <FinSection
      title={metricNames[drill.metric] + '明细' + (drill.sourceMonth ? ' · ' + sourceMonthName(drill.sourceMonth) : '')}
      extra={
        <>
          <ExportLink path="/monthly-ledger/export" query={query} />
          <button type="button" className="secondary" onClick={onClose}>
            收起
          </button>
        </>
      }
    >
      <FinList
        list={listMonthlyDetail}
        label="经营明细"
        query={query}
        rowKey={(r, i) => r.metric + ':' + String(r.id) + ':' + i}
        onRow={onRow}
        empty="本月没有这类记录"
        cols={[
          col('date', '日期'),
          col('number', '单号', { render: documentName }),
          col('party', '往来单位', { wrap: true }),
          // 上面已按单据月份点进来；1280 宽打开详情时收起
          col('source_month', '单据月份', {
            render: (r: DrillRow) => sourceMonthName(r.source_month),
            priority: 'mid',
          }),
          col('status', '状态', { render: (r: DrillRow) => <FlowStatus row={r} /> }),
          // 没算进理论金额的照明细写缺的是什么：缺数量或单位、缺价格
          col('amount', '金额（元）', {
            money: true,
            render: (r: DrillRow) => (r.amount === null ? missingAmountName(r.detail) : yuan(r.amount)),
          }),
        ]}
      />
    </FinSection>
  );
}
