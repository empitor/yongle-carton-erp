import { useEffect, useRef, useState } from 'react';
import { DetailPanel, Hint, yuan } from '../../ui/index';
import { SourceDetail, SourceActions, sourceHeader } from '../SourceDetail';
import { useEnable } from '../enable';
import { overviewTodos } from './todos';
import DrillSection, { type Drill, type DrillRow } from './DrillSection';
import TrendSection from './TrendSection';
import AccountingSection from './AccountingSection';
import { financePageTitles } from '../page-titles';
import { ErrorLine, FinHead, FinSection, PeriodInput } from '../layout';
import { FinTable, col, mon } from '../table';
import { exportHref, useFinPerms, useFinRead, useSyncOnOpen, type FinData } from '../fin-api';
import { metricNames, sourceMonthName } from '../labels';
import { usePeriod } from '../page-state';

type Report = FinData<'GET /finance/monthly-report'>;
/** 实收、实付来自哪个月的单子的一行 */
type Source = Report['sources'][number];
type Metric = Drill['metric'];
type Open = (metric: Metric, sourceMonth?: string) => void;

const sign = (v: number) => (v < 0 ? 'fin-negative' : undefined);
/** 不算进理论、实际盈亏，另外列出的几项；只显示不为 0 的。 */
const extras = [
  ['ordered', '本月接单'],
  ['discountExpense', '给客户的优惠'],
  ['discountIncome', '供应商给的优惠'],
  ['interestIncome', '利息收入'],
  ['interestExpense', '利息支出'],
  // 保证金按钱的进出：收到的（客户交的、或我们交出去被退回的）、付出的（交给供应商的、或退给客户的），和月度台账、导出同一叫法
  ['depositIncome', metricNames.depositIncome],
  ['depositExpense', metricNames.depositExpense],
] as const;

/** 不算进盈亏、另外列出的几项按钮：蓝色金额点开看明细 */
function ExtraAmounts({ m, drill, open }: { m: Report | null; drill: Drill | null; open: Open }) {
  const shown = m ? extras.filter(([key]) => m[key] !== 0).map(([key, label]) => ({ key, label, value: m[key] })) : [];
  if (!shown.length) return null;
  return (
    <div className="fin-extras" aria-label="另外列出，不算进盈亏">
      {shown.map(({ key, label, value }) => (
        <button
          key={key}
          type="button"
          className="fin-extra"
          aria-pressed={drill?.metric === key}
          onClick={() => open(key)}
        >
          <span>{label}</span>
          <strong>{yuan(value)}</strong>
        </button>
      ))}
    </div>
  );
}

/** 理论和实际的收入、支出、盈亏对照；蓝色金额点开看明细，下面另列不算进盈亏的几项 */
function ProfitCompare(props: { period: string; m: Report | null; drill: Drill | null; open: Open }) {
  const { period, m, drill, open } = props;
  const cell = (metric: Metric, value: number | undefined) => (
    <button
      type="button"
      className="fin-amount"
      title="点开看明细"
      aria-pressed={drill?.metric === metric && !drill.sourceMonth}
      onClick={() => open(metric)}
    >
      {yuan(value)}
    </button>
  );
  const profit = (value: number | undefined) => (
    <td className={'num fin-profit ' + (value === undefined ? '' : sign(value) || '')}>{yuan(value)}</td>
  );
  return (
    <section className="panel fin-overview-main">
      <table className="fin-compare">
        <thead>
          <tr>
            <th scope="col">{period}</th>
            <th scope="col" className="num">
              收入 / 元
            </th>
            <th scope="col" className="num">
              支出 / 元
            </th>
            <th scope="col" className="num">
              盈亏 / 元
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">
              理论
              <small>送货单 − 到货单</small>
            </th>
            <td className="num">{cell('theoreticalIncome', m?.theoreticalIncome)}</td>
            <td className="num">{cell('theoreticalExpense', m?.theoreticalExpense)}</td>
            {profit(m?.theoreticalProfit)}
          </tr>
          <tr>
            <th scope="row">
              实际
              <small>已确认的实收 − 实付</small>
            </th>
            <td className="num">{cell('actualIncome', m?.actualIncome)}</td>
            <td className="num">{cell('actualExpense', m?.actualExpense)}</td>
            {profit(m?.actualProfit)}
          </tr>
        </tbody>
      </table>
      <div className="fin-overview-foot">
        <span className="fin-note">蓝色金额点开能看明细。</span>
        <ExtraAmounts m={m} drill={drill} open={open} />
      </div>
    </section>
  );
}

/** 需要处理的事和资金账户余额 */
function TodoSection(props: {
  todos: ReturnType<typeof overviewTodos>;
  accounts: FinData<'GET /finance/summary'>['accounts'];
  ready: boolean;
}) {
  const { todos, accounts, ready } = props;
  return (
    <FinSection title="需要处理">
      {todos.length ? (
        <ul className="fin-todo">
          {todos.map((t) => (
            <li key={t.key} data-tone={t.tone}>
              {t.href ? <a href={t.href}>{t.label}</a> : <span>{t.label}</span>}
              <strong>{t.value}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fin-note">{ready ? '现在没有要处理的事。' : '正在读取…'}</p>
      )}
      {accounts.length > 0 && (
        <>
          <h3 className="fin-subhead" title="只算已记账的凭证，刚确认还没记账的收付不在里面">
            资金账户余额（已记账）
          </h3>
          <ul className="fin-todo">
            {accounts.map((a) => (
              <li key={a.id}>
                <span>{a.name}</span>
                <strong>{yuan(a.balance)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </FinSection>
  );
}

/** 本月实收、实付来自哪个月的单子；点一行看那个月的明细 */
function SourceTable({
  title,
  rows,
  metric,
  drill,
  open,
}: {
  title: string;
  rows: Source[];
  metric: Metric;
  drill: Drill | null;
  open: Open;
}) {
  if (!rows.length) return null;
  return (
    <FinSection title={title}>
      <FinTable
        label={title}
        rows={rows}
        rowKey={(r) => r.source_month}
        onRow={(r) => open(metric, r.source_month)}
        selected={drill?.metric === metric ? drill.sourceMonth : null}
        cols={[
          col('source_month', '单据月份', { render: (r: Source) => sourceMonthName(r.source_month) }),
          col('count', '笔数', { num: true }),
          mon('amount', '金额 / 元'),
        ]}
      />
    </FinSection>
  );
}

/** 这个月的经营数和概览要列的几样数；打开页面时先补扫一次业务单据 */
function useOverviewData(period: string) {
  const sync = useSyncOnOpen();
  const report = useFinRead(['GET /finance/monthly-report', { query: { period } }]);
  const summary = useFinRead(['GET /finance/summary']);
  const soon = useFinRead(['GET /finance/due-soon', { query: { days: 7, pageSize: 1 } }]);
  const discounts = useFinRead(['GET /finance/discount-opportunities', { query: { pageSize: 1 } }]);
  return { sync, report, summary, soon: soon.data, discounts: discounts.data };
}

export default function OverviewPage() {
  const [period, setPeriod] = usePeriod();
  const perms = useFinPerms();
  const enable = useEnable();
  const [drill, setDrill] = useState<Drill | null>(null);
  const [row, setRow] = useState<DrillRow | null>(null);
  const drillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (drill) drillRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [drill]);
  const { sync, report, summary, soon, discounts } = useOverviewData(period);
  const m = report.data;
  const open = (metric: Metric, sourceMonth?: string) => {
    setDrill({ metric, sourceMonth });
    setRow(null);
  };
  const sources = m ? m.sources.filter((s) => s.metric === 'actualIncome') : [];
  const paidSources = m ? m.sources.filter((s) => s.metric === 'actualExpense') : [];
  const todos = overviewTodos({ report: m, summary: summary.data, soon, discounts, perms, enabled: enable.enabled });
  return (
    <div className="fin-page">
      <FinHead
        title={financePageTitles['finance']}
        primary={
          enable.action ||
          (enable.enabled && perms.edit && m && m.missingTax > 0
            ? { label: '补税率（' + m.missingTax + '）', href: '#finance-flow?missing=1' }
            : null)
        }
        more={[
          {
            label: '导出本月经营报表',
            href: exportHref('/monthly-report/export', { period }),
            download: true,
          },
        ]}
      >
        <PeriodInput value={period} onChange={setPeriod} />
      </FinHead>
      <ErrorLine text={sync.error} close={sync.clear} />
      <ErrorLine text={report.error} />
      {enable.known && !enable.enabled && (
        <Hint>
          财务还没启用。下面的单据和收付数字已经能看；要记账、补税率、出正式报表，先启用
          {enable.canEnable ? '（点页面上方的“启用财务”）。' : '，请财务负责人在财务设置里启用。'}
        </Hint>
      )}
      <ProfitCompare period={period} m={m} drill={drill} open={open} />
      {drill && (
        <div ref={drillRef} className="fin-drill">
          <DrillSection
            drill={drill}
            period={period}
            onRow={setRow}
            onClose={() => {
              setDrill(null);
              setRow(null);
            }}
          />
        </div>
      )}
      <div className="fin-grid">
        <TodoSection todos={todos} accounts={summary.data?.accounts ?? []} ready={!!summary.data && !!m} />
        <SourceTable title="本月实收来自哪个月的单子" rows={sources} metric="actualIncome" drill={drill} open={open} />
        <SourceTable title="本月实付来自哪个月的单子" rows={paidSources} metric="actualExpense" drill={drill} open={open} />
      </div>
      <TrendSection
        period={period}
        onPick={(p) => {
          setPeriod(p);
          setDrill(null);
        }}
      />
      <AccountingSection period={period} enabled={enable.enabled && enable.known} />
      {row && (
        <DetailPanel {...sourceHeader(row)} actions={<SourceActions row={row} />} close={() => setRow(null)}>
          <SourceDetail row={row} />
        </DetailPanel>
      )}
      {enable.dialog}
    </div>
  );
}
