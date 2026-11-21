import { FormMessage, ListSummary, yuan, DataTable, col, mon, type Col } from '../../ui/index';
import ClosingTab from './ClosingTab';
import { Readiness, type TabProps } from './FormalReports';
import { FinSection, PeriodInput, ExportLink } from '../layout';
import { FIN_TABLE } from '../table';
import { Status } from '../status';
import { useFinRead, type FinData } from '../fin-api';
import { reportOf } from './reports-api';

type Report = FinData<'GET /finance/reports/:kind'>;
type TrialRow = Extract<Report, { rows: unknown }>['rows'][number];
type PeriodRow = FinData<'GET /finance/periods'>[number];

const trialCols: Col<TrialRow>[] = [
  col('account_code', '科目编码'),
  col('account_name', '科目'),
  mon('opening', '期初'),
  mon('debit', '借方'),
  mon('credit', '贷方'),
  mon('ending', '期末'),
];
const periodCols: Col<PeriodRow>[] = [
  col('period', '月份'),
  col('status', '状态', { render: (r) => <Status value={r.status} /> }),
];

function TrialBalance({ period }: { period: string }) {
  const { data: report, error } = useFinRead(reportOf('trial', period));
  // 报表地址回的四张表都没带种类，试算平衡表按它才有的 rows 认
  const data = report && 'rows' in report ? report : null;
  return (
    <FinSection
      id="trial"
      title="试算平衡"
      note={data ? (data.balanced ? '借贷平衡' : '借贷不平，结账前要查清') : undefined}
      collapsed
      extra={<ExportLink path="/reports/trial/export" query={{ period }} />}
    >
      <FormMessage>{error}</FormMessage>
      {data && (
        <ListSummary
          items={[
            { label: '本期借方', value: yuan(data.debit) },
            { label: '本期贷方', value: yuan(data.credit) },
            { label: '是否平衡', value: data.balanced ? '平衡' : '不平' },
          ]}
        />
      )}
      <DataTable
        className={FIN_TABLE}
        label="试算平衡表"
        rows={data?.rows || []}
        rowKey={(r) => r.account_code}
        empty="这个月没有发生额"
        cols={trialCols}
      />
    </FinSection>
  );
}

/** 会计期间：启用后自动产生，结账、反结账在上面的结账向导里做。 */
function PeriodsSection() {
  const { data, error } = useFinRead(['GET /finance/periods']);
  return (
    <FinSection id="periods" title="会计期间" note="每个月的结账状态" collapsed>
      <FormMessage>{error}</FormMessage>
      <DataTable
        className={FIN_TABLE}
        label="会计期间"
        rows={data ?? []}
        rowKey={(r) => r.period}
        empty="还没有期间，启用后自动产生"
        cols={periodCols}
      />
    </FinSection>
  );
}

export default function ClosingPage({ head, period, setPeriod }: TabProps) {
  return (
    <>
      {head({ children: <PeriodInput value={period} onChange={setPeriod} /> })}
      <Readiness period={period} />
      <ClosingTab period={period} />
      <TrialBalance period={period} />
      <PeriodsSection />
    </>
  );
}
