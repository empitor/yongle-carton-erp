import { useState } from 'react';
import { ListSummary, Hint, yuan, Segmented } from '../../ui/index';
import { snapshotKinds } from '../../../shared/finance/index';
import { ErrorLine, FinSection, PeriodInput, type HeadFn } from '../layout';
import { FinTable, col, mon, type Col } from '../table';
import { exportHref, useFinPerms, useFinRead, type FinData } from '../fin-api';
import { readinessOf, reportOf } from './reports-api';

/** 三张正式报表（试算平衡表在结账页） */
type ReportKind = (typeof snapshotKinds)[number];
const reportNames: Record<ReportKind, string> = { balance: '资产负债表', profit: '利润表', cashflow: '现金流量表' };
const reportKinds = snapshotKinds.map((k) => [k, reportNames[k]] as const);
const kindOf = (value: string) => snapshotKinds.find((k) => k === value);

type ReadinessRow = FinData<'GET /finance/reports/readiness'>['rows'][number];
type Report = FinData<'GET /finance/reports/:kind'>;
type BalanceReport = Extract<Report, { assets: unknown }>;
type ProfitReport = Extract<Report, { netProfit: unknown }>;
type CashflowReport = Extract<Report, { unclassified: unknown }>;
type BalanceLine = BalanceReport['assets'][number];
type ProfitLine = ProfitReport['lines'][number];
type CashflowLine = CashflowReport['lines'][number];

const readinessCols: Col<ReadinessRow>[] = [
  col('date', '日期'),
  col('source_kind', '类型', {
    render: (r) => (r.source_kind === 'delivery' ? '送货' : '到货'),
  }),
  col('number', '单号', { render: (r) => r.number || r.source_id }),
  col('problem', '说明', { wrap: true }),
  mon('amount_cents', '金额 / 元'),
];

/** 正式报表前的提醒：只有这里和结账才要求补完。没有权限补的账号只说明，不给链接。 */
export function Readiness({ period }: { period: string }) {
  const perms = useFinPerms();
  const { data } = useFinRead(readinessOf(period));
  if (!data || data.ready) return null;
  return (
    <FinSection
      title={period + ' 还有 ' + data.count + ' 张单据没补完'}
      note={'涉及 ' + yuan(data.amount) + ' 元'}
    >
      <Hint tone="warning">
        补完才能出正式报表和结账，业务和经营报表不受影响。
        {data.reversalCount > 0 && (
          <> 其中 {data.reversalCount} 张是已冲销的送货单，要先撤销核销。</>
        )}
        {perms.edit ? '' : '需要有财务编辑权限的人到月度台账补。'}
      </Hint>
      <FinTable
        label="待补单据"
        rows={data.rows}
        rowKey={(r, i) => (r.id ?? r.source_id) + ':' + i}
        cols={readinessCols}
      />
    </FinSection>
  );
}

/** 点报表一行：打开这一行第一个科目这个月的明细账 */
const drill = (r: BalanceLine | ProfitLine) => {
  const d = r.drill[0];
  if (d) location.hash = '#finance-ledger?tab=books&account=' + d.account;
};
const balanceCols: Col<BalanceLine>[] = [col('name', '项目'), mon('opening', '年初 / 期初'), mon('amount', '期末')];
const profitCols: Col<ProfitLine>[] = [col('name', '项目'), mon('amount', '本月'), mon('ytd', '本年累计')];

/** 资产负债表、利润表的一块：各行（点一行看明细账），有合计的写在下面 */
function ReportLines<R extends BalanceLine | ProfitLine>(props: {
  title: string;
  rows: R[];
  cols: Col<R>[];
  total?: number;
}) {
  const { title, rows, cols, total } = props;
  return (
    <FinSection title={title}>
      <FinTable label={title} rows={rows} rowKey={(r) => r.id} onRow={drill} cols={cols} />
      {total !== undefined && (
        <p className="fin-note">
          合计 <strong>{yuan(total)}</strong>
        </p>
      )}
    </FinSection>
  );
}

function BalanceSheet({ data }: { data: BalanceReport }) {
  return (
    <>
      <ListSummary
        items={[
          { label: '资产合计', value: yuan(data.totalAssets) },
          { label: '负债合计', value: yuan(data.totalLiabilities) },
          { label: '权益合计', value: yuan(data.totalEquity) },
          {
            label: '是否平衡',
            value: data.balanced ? '平衡' : '差 ' + yuan(data.difference),
          },
        ]}
      />
      <div className="fin-grid">
        <ReportLines title="资产" rows={data.assets} cols={balanceCols} total={data.totalAssets} />
        <ReportLines title="负债" rows={data.liabilities} cols={balanceCols} total={data.totalLiabilities} />
        <ReportLines title="所有者权益" rows={data.equity} cols={balanceCols} total={data.totalEquity} />
      </div>
    </>
  );
}

function ProfitSheet({ data }: { data: ProfitReport }) {
  return (
    <>
      <ListSummary
        items={[
          { label: '本月净利润', value: yuan(data.netProfit) },
          { label: '本年累计', value: yuan(data.yearProfit) },
        ]}
      />
      <ReportLines title="利润表" rows={data.lines} cols={profitCols} />
    </>
  );
}

/** 现金流量项目归的几类活动（别的原样显示，例如 transfer） */
const cashGroupNames: Readonly<Record<string, string>> = {
  operating: '经营',
  investing: '投资',
  financing: '筹资',
  unclassified: '未归类',
};
const cashflowCols: Col<CashflowLine>[] = [
  col('group', '类别', {
    render: (r) => (Object.hasOwn(cashGroupNames, r.group) && cashGroupNames[r.group]) || r.group,
  }),
  col('item', '项目', { render: (r) => r.item || '未填' }),
  col('account_code', '科目'),
  mon('amount', '金额 / 元'),
];

function CashflowSheet({ data }: { data: CashflowReport }) {
  return (
    <>
      <ListSummary
        items={[
          { label: '期初现金', value: yuan(data.opening) },
          { label: '本期净流量', value: yuan(data.total) },
          { label: '期末现金', value: yuan(data.ending) },
        ]}
      />
      {data.unclassified.length > 0 && (
        <Hint tone="warning">
          有 {data.unclassified.length} 项现金流没有归类，请到凭证里补现金流量项目。
        </Hint>
      )}
      <FinSection title="现金流量表">
        <FinTable label="现金流量表" rows={data.lines} rowKey={(_, i) => i} cols={cashflowCols} />
      </FinSection>
    </>
  );
}

/** 一张正式报表：资料补完才读；回来的是哪张表按它自己的项认 */
function FormalReport({ kind, period }: { kind: ReportKind; period: string }) {
  const readiness = useFinRead(readinessOf(period));
  const ready = !!readiness.data?.ready;
  const { data, error } = useFinRead(ready ? reportOf(kind, period) : null);
  if (readiness.data && !ready) return null;
  return (
    <>
      <ErrorLine text={error} />
      {data?.needsReview && <Hint>报表行项目和公式还没有经过懂账的人复核，先按内部参考使用。</Hint>}
      {data && 'assets' in data && <BalanceSheet data={data} />}
      {data && 'netProfit' in data && <ProfitSheet data={data} />}
      {data && 'unclassified' in data && <CashflowSheet data={data} />}
    </>
  );
}

export function ReportsTab({ head, period, setPeriod, initial }: TabProps & { initial: string }) {
  const perms = useFinPerms();
  const [kind, setKind] = useState<ReportKind>(kindOf(initial) ?? 'balance');
  const readiness = useFinRead(readinessOf(period));
  const ready = !!readiness.data?.ready;
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        primary:
          readiness.data && !ready && perms.edit
            ? { label: '补税率（' + readiness.data.count + '）', href: '#finance-flow?missing=1' }
            : null,
        more: ready
          ? [
              {
                label: '导出' + reportNames[kind],
                href: exportHref('/reports/' + kind + '/export', { period }),
                download: true,
              },
            ]
          : [],
      })}
      <div className="fin-toolbar">
        <Segmented className="fin-segmented"
          label="报表"
          value={kind}
          onChange={(v) => {
            const next = kindOf(v);
            if (next) setKind(next);
          }}
          options={reportKinds}
        />
      </div>
      <Readiness period={period} />
      <FormalReport key={kind} kind={kind} period={period} />
    </>
  );
}

export type TabProps = { head: HeadFn; period: string; setPeriod: (v: string) => void };
