import { useEffect, useState } from 'react';
import DetailPanel from '../ui/DetailPanel';
import { PageHeading } from '../ui/ListLayout';
import {
  ErrorLine,
  ExportLink,
  Facts,
  FinList,
  FinTable,
  PeriodInput,
  Status,
  col,
  documentName,
  metricNames,
  mon,
  sourceMonthName,
  syncEvents,
  useFin,
  usePeriod,
  yuan,
} from './kit';

const sign = (v: unknown) => (Number(v) < 0 ? 'fin-negative' : undefined);
const extras = [
  ['ordered', '本月接单'],
  ['discountExpense', '给客户的优惠'],
  ['discountIncome', '供应商给的优惠'],
  ['interestIncome', '利息收入'],
  ['interestExpense', '利息支出'],
  ['depositIncome', '保证金收回'],
  ['depositExpense', '保证金付出'],
] as const;

/** 下钻明细的来源单据，给人看的字段，不依赖内部结构细节。 */
export function SourceDetail({ row }: { row: any }) {
  const detail = row.detail || {};
  const source = detail.source || detail;
  const doc = source.doc;
  const lines: any[] = doc?.lines || doc?.items || [];
  return (
    <>
      <Facts
        items={[
          ['类型', metricNames[row.metric] || row.metric],
          ['日期', row.date],
          ['单号', documentName(row)],
          ['往来单位', row.party],
          ['金额 / 元', row.amount === null ? '缺价格，未计入' : yuan(row.amount)],
          ['来源月份', sourceMonthName(row.source_month)],
          ['到期日', row.due_date],
          ['已收付 / 元', row.paid ? yuan(row.paid) : null],
          ['说明', detail.description],
        ]}
      />
      {lines.length > 0 && (
        <>
          <h3>单据明细</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>品名</th>
                  <th className="num">数量</th>
                  <th>单位</th>
                  <th className="num">单价</th>
                  <th>税率</th>
                  <th>口径</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.productName || l.item?.name || l.name || '—'}</td>
                    <td className="num">{l.stockedQuantity ?? l.quantity ?? '—'}</td>
                    <td>{l.unit || l.item?.unit || '—'}</td>
                    <td className="num">{l.unitPriceExact ?? l.unitPrice ?? '—'}</td>
                    <td>{l.taxRate || '未填'}</td>
                    <td>{l.taxMode || '未填'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {source.warnings?.length > 0 && (
        <p className="fin-note">{(source.warnings as string[]).join(' ')}</p>
      )}
    </>
  );
}

export default function OverviewPage() {
  const [period, setPeriod] = usePeriod();
  const [drill, setDrill] = useState<{ metric: string; sourceMonth?: string } | null>(null);
  const [row, setRow] = useState<any>(null);
  useEffect(() => {
    void syncEvents().catch(() => {});
  }, []);
  const report = useFin('/monthly-report', { period });
  const settings = useFin('/settings');
  const summary = useFin('/summary');
  const soon = useFin('/due-soon', { days: 7, pageSize: 1 });
  const discounts = useFin('/discount-opportunities', { pageSize: 1 });
  const trend = useFin<any[]>('/monthly-report/trend', { period, months: 12 });
  const m = report.data;
  const cell = (metric: string, value: unknown) => (
    <button
      className="fin-amount"
      aria-pressed={drill?.metric === metric && !drill?.sourceMonth}
      onClick={() => {
        setDrill({ metric });
        setRow(null);
      }}
    >
      {yuan(value)}
    </button>
  );
  const sources = ((m?.sources || []) as any[]).filter((s) => s.metric === 'actualIncome');
  const paidSources = ((m?.sources || []) as any[]).filter((s) => s.metric === 'actualExpense');
  const sourceTable = (title: string, rows: any[], metric: string) => (
    <section className="panel fin-card business-records">
      <h2>{title}</h2>
      <FinTable
        label={title}
        empty="本月没有"
        rows={rows}
        rowKey={(r) => r.source_month}
        onRow={(r) => {
          setDrill({ metric, sourceMonth: r.source_month });
          setRow(null);
        }}
        selected={drill?.metric === metric ? drill?.sourceMonth : null}
        cols={[
          col('source_month', '单据月份', { render: (r) => sourceMonthName(r.source_month) }),
          col('count', '笔数', { num: true }),
          mon('amount', '金额 / 元'),
        ]}
      />
    </section>
  );
  return (
    <div className="fin-page">
      <PageHeading
        title="财务概览"
        actions={
          <>
            <ExportLink path="/monthly-report/export" query={{ period }} label="导出本月" />
            <PeriodInput value={period} onChange={setPeriod} />
          </>
        }
      />
      <ErrorLine text={report.error} />
      {settings.data && !settings.data.startPeriod && (
        <div className="fin-banner" data-tone="info">
          <span className="fin-grow">
            财务还没启用。下面的单据和收付数字已经能看；要记账、出正式报表，请先启用。
          </span>
          <a href="#finance-settings">去财务设置</a>
        </div>
      )}
      <section className="panel">
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
              <td className={'num fin-profit ' + (sign(m?.theoreticalProfit) || '')}>
                {yuan(m?.theoreticalProfit)}
              </td>
            </tr>
            <tr>
              <th scope="row">
                实际
                <small>已确认的实收 − 实付</small>
              </th>
              <td className="num">{cell('actualIncome', m?.actualIncome)}</td>
              <td className="num">{cell('actualExpense', m?.actualExpense)}</td>
              <td className={'num fin-profit ' + (sign(m?.actualProfit) || '')}>
                {yuan(m?.actualProfit)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      {m && (m.missingPrice > 0 || m.missingTax > 0) && (
        <div className="fin-banner">
          <span className="fin-grow">
            {m.missingTax > 0 && <>本月有 <strong>{m.missingTax}</strong> 张单据待补税率。</>}
            {m.missingPrice > 0 && (
              <>
                {' '}
                <strong>{m.missingPrice}</strong> 张缺价格，没有算进理论金额。
              </>
            )}
            不影响业务和上面的数字，出正式报表前补完就行。
          </span>
          <a href="#finance-flow?missing=1">去补</a>
        </div>
      )}
      <div className="fin-grid">
        {sourceTable('本月实收来自哪个月的单子', sources, 'actualIncome')}
        {sourceTable('本月实付来自哪个月的单子', paidSources, 'actualExpense')}
        <section className="panel fin-card business-records">
          <h2>另外列出</h2>
          <ul className="fin-todo">
            {extras.map(([key, label]) => (
              <li key={key}>
                <button
                  className="link-button"
                  onClick={() => {
                    setDrill({ metric: key });
                    setRow(null);
                  }}
                >
                  {label}
                </button>
                <strong>{yuan(m?.[key])}</strong>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel fin-card business-records">
          <h2>要留意</h2>
          <ul className="fin-todo">
            <li>
              <a href="#finance-ledger?tab=events">待处理的财务事件</a>
              <strong>{summary.data?.events ?? '—'}</strong>
            </li>
            <li>
              <a href="#finance-ledger">待审核凭证</a>
              <strong>{summary.data?.pendingApproval ?? '—'}</strong>
            </li>
            {((summary.data?.overdue || []) as any[]).map((o) => (
              <li key={o.kind}>
                <a href={'#finance-ar?tab=soon'}>{o.kind === 'receivable' ? '逾期应收' : '逾期应付'}</a>
                <strong>
                  {o.count} 笔 · {yuan(o.amount)}
                </strong>
              </li>
            ))}
            <li>
              <a href="#finance-ar?tab=soon">7 天内到期或已逾期</a>
              <strong>{soon.data?.filteredRecords ?? '—'}</strong>
            </li>
            <li>
              <a href="#finance-ar?tab=discount">可以拿现结优惠的单子</a>
              <strong>{discounts.data?.filteredRecords ?? '—'}</strong>
            </li>
            {((summary.data?.accounts || []) as any[]).map((a) => (
              <li key={a.id}>
                <span title="只算已记账的凭证，刚确认还没记账的收付不在里面">
                  {a.name} 账面余额（已记账）
                </span>
                <strong>{yuan(a.balance)}</strong>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {drill && (
        <>
          <div className="fin-toolbar">
            <strong>
              {metricNames[drill.metric] || drill.metric}明细
              {drill.sourceMonth ? ' · ' + sourceMonthName(drill.sourceMonth) : ''}
            </strong>
            <span className="fin-grow" />
            <ExportLink
              path="/monthly-report/detail/export"
              query={{ period, metric: drill.metric, sourceMonth: drill.sourceMonth }}
            />
            <button
              onClick={() => {
                setDrill(null);
                setRow(null);
              }}
            >
              收起
            </button>
          </div>
          <FinList
            path="/monthly-report/detail"
            label="经营明细"
            query={{ period, metric: drill.metric, sourceMonth: drill.sourceMonth }}
            rowKey={(r, i) => r.metric + ':' + r.id + ':' + i}
            onRow={setRow}
            empty="本月没有这类记录"
            cols={[
              col('date', '日期'),
              col('number', '单号', { render: documentName }),
              col('party', '往来单位', { wrap: true }),
              col('source_month', '单据月份', { render: (r) => sourceMonthName(r.source_month) }),
              col('status', '状态', { render: (r) => <Status value={r.status} /> }),
              col('amount', '金额 / 元', {
                money: true,
                render: (r) => (r.amount === null ? '缺价格' : yuan(r.amount)),
              }),
            ]}
          />
        </>
      )}
      <section className="panel fin-card business-records">
        <h2>最近 12 个月</h2>
        <FinTable
          label="最近 12 个月经营趋势"
          rows={trend.data || []}
          rowKey={(r) => r.period}
          onRow={(r) => {
            setPeriod(r.period);
            setDrill(null);
          }}
          selected={period}
          cols={[
            col('period', '月份'),
            mon('theoreticalIncome', '送货'),
            mon('theoreticalExpense', '到货'),
            col('theoreticalProfit', '理论盈亏', {
              money: true,
              render: (r) => <span className={sign(r.theoreticalProfit)}>{yuan(r.theoreticalProfit)}</span>,
            }),
            mon('actualIncome', '实收'),
            mon('actualExpense', '实付'),
            col('actualProfit', '实际盈亏', {
              money: true,
              render: (r) => <span className={sign(r.actualProfit)}>{yuan(r.actualProfit)}</span>,
            }),
          ]}
        />
      </section>
      {row && (
        <DetailPanel title={(metricNames[row.metric] || '') + ' ' + documentName(row)} close={() => setRow(null)}>
          <SourceDetail row={row} />
        </DetailPanel>
      )}
    </div>
  );
}
