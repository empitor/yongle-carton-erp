import { useState } from 'react';
import { ListSummary, PageHeading } from '../ui/ListLayout';
import {
  ErrorLine,
  ExportLink,
  FinList,
  FinTable,
  FormDialog,
  PeriodInput,
  Status,
  Tabs,
  col,
  finSend,
  mon,
  NeedEnable,
  useFinanceEnabled,
  useAction,
  useFin,
  useFinPerms,
  usePeriod,
  useTab,
  yuan,
} from './kit';

const tabs = [
  ['balance', '资产负债表'],
  ['profit', '利润表'],
  ['cashflow', '现金流量表'],
  ['trial', '试算平衡'],
  ['closing', '结账'],
  ['dashboard', '管理看板'],
  ['budget', '预算'],
] as const;

/** 正式报表前的提醒：只有这里才要求补完。 */
function Readiness({ period }: { period: string }) {
  const { data } = useFin('/reports/readiness', { period });
  if (!data || data.ready) return null;
  return (
    <section className="panel fin-card business-records">
      <div className="fin-banner">
        <span className="fin-grow">
          <strong>{period} 还有 {data.count} 张单据没补完</strong>，涉及 {yuan(data.amount)} 元。
          {data.reversalCount > 0 && <> 其中 {data.reversalCount} 张是已冲销的送货单，要先撤销核销。</>}
          补完才能出正式报表和结账，业务和经营报表不受影响。
        </span>
        <a href="#finance-flow?missing=1">去月度台账补</a>
      </div>
      <FinTable
        label="待补单据"
        rows={data.rows || []}
        rowKey={(r, i) => (r.id ?? r.source_id) + ':' + i}
        cols={[
          col('date', '日期'),
          col('source_kind', '类型', {
            render: (r) => (r.source_kind === 'delivery' ? '送货' : '到货'),
          }),
          col('number', '单号', { render: (r) => r.number || r.source_id }),
          col('problem', '说明', { wrap: true }),
          mon('amount_cents', '金额 / 元'),
        ]}
      />
    </section>
  );
}

function FormalReport({ kind, period }: { kind: 'balance' | 'profit' | 'cashflow'; period: string }) {
  const readiness = useFin('/reports/readiness', { period });
  const ready = !!readiness.data?.ready;
  const { data, error } = useFin(ready ? '/reports/' + kind : null, { period });
  if (readiness.data && !ready) return null;
  const drill = (r: any) => {
    const d = r.drill?.[0];
    if (d) location.hash = '#finance-ledger?tab=books&account=' + d.account;
  };
  const lines = (title: string, rows: any[], total?: number) => (
    <section className="panel fin-card business-records">
      <h2>{title}</h2>
      <FinTable
        label={title}
        rows={rows}
        rowKey={(r, i) => r.id ?? i}
        onRow={rows[0]?.drill ? drill : undefined}
        cols={[
          col('name', '项目'),
          ...(rows[0]?.opening !== undefined ? [mon('opening', '年初 / 期初')] : []),
          mon('amount', kind === 'profit' ? '本月' : '期末'),
          ...(rows[0]?.ytd !== undefined ? [mon('ytd', '本年累计')] : []),
        ]}
      />
      {total !== undefined && (
        <p className="fin-note">
          合计 <strong>{yuan(total)}</strong>
        </p>
      )}
    </section>
  );
  return (
    <>
      <ErrorLine text={error} />
      {data?.needsReview && (
        <div className="fin-banner" data-tone="info">
          报表行项目和公式还没有经过懂账的人复核，先按内部参考使用。
        </div>
      )}
      {kind === 'balance' && data && (
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
            {lines('资产', data.assets, data.totalAssets)}
            {lines('负债', data.liabilities, data.totalLiabilities)}
            {lines('所有者权益', data.equity, data.totalEquity)}
          </div>
        </>
      )}
      {kind === 'profit' && data && (
        <>
          <ListSummary
            items={[
              { label: '本月净利润', value: yuan(data.netProfit) },
              { label: '本年累计', value: yuan(data.yearProfit) },
            ]}
          />
          {lines('利润表', data.lines)}
        </>
      )}
      {kind === 'cashflow' && data && (
        <>
          <ListSummary
            items={[
              { label: '期初现金', value: yuan(data.opening) },
              { label: '本期净流量', value: yuan(data.total) },
              { label: '期末现金', value: yuan(data.ending) },
            ]}
          />
          {data.unclassified?.length > 0 && (
            <div className="fin-banner">
              有 {data.unclassified.length} 项现金流没有归类，请到凭证里补现金流量项目。
            </div>
          )}
          <section className="panel business-records">
            <FinTable
              label="现金流量表"
              rows={data.lines || []}
              rowKey={(_, i) => i}
              cols={[
                col('group', '类别', {
                  render: (r) =>
                    ({ operating: '经营', investing: '投资', financing: '筹资', unclassified: '未归类' })[
                      r.group as string
                    ] || r.group,
                }),
                col('item', '项目', { render: (r) => r.item || '未填' }),
                col('account_code', '科目'),
                mon('amount', '金额 / 元'),
              ]}
            />
          </section>
        </>
      )}
    </>
  );
}

function TrialBalance({ period }: { period: string }) {
  const { data, error } = useFin('/reports/trial', { period });
  return (
    <>
      <ErrorLine text={error} />
      {data && (
        <ListSummary
          items={[
            { label: '本期借方', value: yuan(data.debit) },
            { label: '本期贷方', value: yuan(data.credit) },
            { label: '是否平衡', value: data.balanced ? '平衡' : '不平' },
          ]}
        />
      )}
      <section className="panel business-records">
        <FinTable
          label="试算平衡表"
          rows={data?.rows || []}
          rowKey={(r) => r.account_code}
          empty="这个月没有发生额"
          cols={[
            col('account_code', '科目编码'),
            col('account_name', '科目'),
            mon('opening', '期初'),
            mon('debit', '借方'),
            mon('credit', '贷方'),
            mon('ending', '期末'),
          ]}
        />
      </section>
    </>
  );
}

const stepNames: Record<string, string> = {
  events: '财务事件都处理完',
  vouchers: '凭证都已记账',
  jobs: '折旧、工资、成本、税费都跑过',
  bank: '银行流水都已匹配（不强制）',
  trial: '试算平衡',
  balance: '资产负债表平衡',
  profit: '损益已结转',
};
const jobNames: Record<string, string> = {
  depreciation: '计提折旧',
  payroll: '工资计提',
  costing: '计算成本',
  tax: '税费计提',
};
function ClosingTab({ period }: { period: string }) {
  const perms = useFinPerms();
  const { data, error } = useFin('/closing', { period });
  const action = useAction();
  const [dialog, setDialog] = useState(false);
  const profitStep = data?.steps?.find((s: any) => s.key === 'profit');
  const run = (job: string) =>
    action.run(() => {
      const path = {
        depreciation: '/depreciation',
        payroll: '/payroll/confirm',
        tax: '/closing/tax',
        profit: '/closing/profit',
      }[job]!;
      return finSend('POST', path, {
        period,
        // 12 月先月末损益，记账后这一步还没完成时才是年度利润。
        ...(job === 'profit' && profitStep?.annualNext ? { annual: true } : {}),
      });
    });
  const closed = data?.record?.status === 'closed';
  const jobStep = data?.steps?.find((s: any) => s.key === 'jobs');
  return (
    <section className="panel fin-card business-records">
      <ErrorLine text={error} />
      <ErrorLine text={action.error} close={action.clear} />
      <h2>
        {period} 结账 <Status value={data?.record?.status || 'open'} />
      </h2>
      {data && !closed && data.next !== period && (
        <p className="fin-note">要按顺序结账，下一个该结的是 {data.next || '启用期'}。</p>
      )}
      <ol className="fin-steps">
        {((data?.steps || []) as any[]).map((s) => (
          <li key={s.key}>
            <span className="business-status" data-tone={s.ok ? 'success' : s.blocking ? 'warning' : 'muted'}>
              {s.ok ? '完成' : s.blocking ? '待处理' : '建议'}
            </span>
            <span className="fin-grow">
              {stepNames[s.key] || s.key}
              {s.count ? '（' + s.count + ' 项）' : ''}
            </span>
            {s.key === 'events' && !s.ok && <a href="#finance-ledger?tab=events">去处理</a>}
            {s.key === 'vouchers' && !s.ok && <a href="#finance-ledger">去记账</a>}
            {s.key === 'bank' && !s.ok && <a href="#finance-cash?tab=bank">去匹配</a>}
            {s.key === 'profit' && !s.ok && perms.close && !closed && (
              <button disabled={action.busy} onClick={() => run('profit')}>
                {s.annualNext ? '结转年度利润' : '结转损益'}
              </button>
            )}
          </li>
        ))}
      </ol>
      {jobStep && !jobStep.ok && perms.close && !closed && (
        <div className="fin-actions fin-subform">
          {(jobStep.missing as string[]).map((job) =>
            job === 'costing' ? (
              // 成本可能要先填期初和手工流水的金额，统一到成本页的窗口里算
              <a key={job} className="button" href="#finance-costs?tab=costing">
                {jobNames[job]}
              </a>
            ) : (
              <button key={job} disabled={action.busy} onClick={() => run(job)}>
                {jobNames[job] || job}
              </button>
            ),
          )}
        </div>
      )}
      <p className="fin-note">跑完会生成凭证草稿，要到凭证页记账后才算完成。</p>
      {perms.close && (
        <div className="fin-actions fin-subform">
          {!closed && (
            <button
              className="primary"
              disabled={action.busy || !data?.canClose}
              onClick={() =>
                action.run(() =>
                  finSend('POST', '/closing/close', { period, version: data.record.version }),
                )
              }
            >
              结账
            </button>
          )}
          {closed && <button onClick={() => setDialog(true)}>反结账</button>}
          {closed && <ExportLink path="/archive/download" query={{ period }} label="下载归档文件" />}
        </div>
      )}
      {dialog && (
        <FormDialog
          title={'反结账 ' + period}
          intro="只能反结最近一个已结的月份。已生成的报表快照保留。"
          danger
          submitLabel="确认反结账"
          fields={[{ name: 'reason', label: '原因', required: true, wide: true }]}
          close={() => setDialog(false)}
          submit={(v) =>
            finSend('POST', '/closing/reopen', { period, reason: v.reason, version: data.record.version })
          }
        />
      )}
    </section>
  );
}

function DashboardTab({ period }: { period: string }) {
  const { data, error } = useFin('/reports/dashboard', { period });
  const a = data?.accounting;
  return (
    <>
      <ErrorLine text={error} />
      {data?.estimated && (
        <div className="fin-banner">
          本月有 {data.missingTax} 张单据待补税率，下面的会计口径数字是估算。
        </div>
      )}
      {a && (
        <ListSummary
          items={[
            { label: '会计收入', value: yuan(a.revenue) },
            { label: '销售成本', value: yuan(a.salesCost) },
            { label: '毛利', value: yuan(a.grossProfit) },
            { label: '期间费用', value: yuan(a.expense) },
            { label: '净利润', value: yuan(a.profit) },
            { label: '含待补的估算收入', value: yuan(a.estimatedRevenue) },
          ]}
        />
      )}
      <p className="fin-note">这里是记账口径。理论、实际两种盈亏看财务概览。</p>
    </>
  );
}

function BudgetTab({ period }: { period: string }) {
  const perms = useFinPerms();
  const [row, setRow] = useState<any>(null);
  // 已结账的月份预算不能再改，不给入口。
  const periods = useFin<any>('/periods');
  const closed = ((Array.isArray(periods.data) ? periods.data : []) as any[]).some(
    (p) => p.period === period && p.status === 'closed',
  );
  const canEdit = perms.close && !closed;
  return (
    <>
      <div className="fin-toolbar">
        <span className="fin-grow" />
        {closed && <span className="fin-note">这个月已结账，预算不能再改。</span>}
        {canEdit && (
          <button className="primary" onClick={() => setRow({})}>
            设预算
          </button>
        )}
      </div>
      <FinList
        path="/budgets"
        label="预算"
        query={{ period }}
        rowKey={(r) => r.account_code}
        onRow={canEdit ? setRow : undefined}
        empty="这个月没有预算"
        cols={[
          col('account_code', '科目编码'),
          col('name', '科目'),
          mon('amount_cents', '预算'),
          mon('actual', '实际'),
          mon('difference', '差额'),
        ]}
      />
      {row && (
        <FormDialog
          title={'设 ' + period + ' 预算'}
          fields={[
            { name: 'accountCode', label: '科目', type: 'account', required: true },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
          ]}
          initial={{ accountCode: row.account_code, amount: row.amount_cents }}
          close={() => setRow(null)}
          submit={(v) =>
            finSend('PUT', '/budgets', { ...v, period, ...(row.version ? { version: row.version } : {}) })
          }
        />
      )}
    </>
  );
}

export default function ReportsPage() {
  const [tab, setTab] = useTab('balance');
  const [period, setPeriod] = usePeriod();
  const formal = tab === 'balance' || tab === 'profit' || tab === 'cashflow';
  // 缺资料时正式报表导不出来，不给会失败的按钮，下面的提示会说明要补什么。
  const readiness = useFin('/reports/readiness', { period });
  const enabled = useFinanceEnabled();
  if (!enabled)
    return (
      <div className="fin-page">
        <PageHeading title="报表结账" />
        <NeedEnable what="正式报表和结账" />
      </div>
    );
  return (
    <div className="fin-page">
      <PageHeading
        title="报表结账"
        actions={
          <>
            {(tab === 'trial' || (formal && readiness.data?.ready)) && (
              <ExportLink path={'/reports/' + tab + '/export'} query={{ period }} />
            )}
            <PeriodInput value={period} onChange={setPeriod} />
          </>
        }
      />
      <Tabs label="报表结账分类" tabs={tabs} value={tab} onChange={setTab} />
      {(formal || tab === 'closing') && <Readiness period={period} />}
      {formal && <FormalReport key={tab} kind={tab} period={period} />}
      {tab === 'trial' && <TrialBalance period={period} />}
      {tab === 'closing' && <ClosingTab period={period} />}
      {tab === 'dashboard' && <DashboardTab period={period} />}
      {tab === 'budget' && <BudgetTab period={period} />}
    </div>
  );
}
