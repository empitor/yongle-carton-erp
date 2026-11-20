import { useState } from 'react';
import { useConfirm, Hint, StatusChip, notify, useAction } from '../../ui/index';
import OpeningChanges from './OpeningChanges';
import { ErrorLine, ExportLink } from '../layout';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { closePeriod, reopenPeriod, runPeriodJob, type ClosingJob } from './reports-api';
import { accrualNotice, type PeriodJobExtra } from '../costs/costs-api';
import { FormDialog } from '../FormDialog';
import { FinStatusChip } from '../status';
import { filled } from '../submit-pick';

type Check = FinData<'GET /finance/closing'>;
type Step = Check['steps'][number];
/** 月末几步那一项（key 是 jobs）：还没跑的、跑过但数变了要重做的 */
type JobsStep = Extract<Step, { missing: unknown }>;
/** 损益结转那一项（key 是 profit）：要不要补做、12 月下一步是不是年度利润 */
type ProfitStep = Extract<Step, { annualNext: unknown }>;
type JobKind = JobsStep['missing'][number];
/** 重做时带上页面看到的原凭证号，别处已经重做过时服务端会拦下 */
type Redo = { voucherId: number | null };

const stepNames: Record<string, string> = {
  events: '业务单据都已生成凭证或处理完',
  vouchers: '凭证都已记账',
  jobs: '折旧、工资、成本、税费都跑过，而且是按现在的数算的',
  bank: '银行流水都已匹配',
  opening: '启用前单据的变动已核对',
  trial: '试算平衡',
  balance: '资产负债表平衡',
  profit: '损益已结转',
};
const jobNames: Record<JobKind, string> = {
  depreciation: '计提折旧',
  payroll: '计提工资',
  costing: '计算成本',
  tax: '计提税费',
};
const profitLabel = (s: ProfitStep) =>
  s.stale
    ? '补做损益结转'
    : s.annualStale
      ? '补做年度利润结转'
      : s.annualNext
        ? '结转年度利润'
        : '结转损益';

/** 每一步写账前说清楚会生成什么。 */
const jobMessages: Record<ClosingJob, string> = {
  depreciation: '按平均年限法算这个月所有在用资产的折旧，生成一张待记账凭证。',
  payroll: '按导入的工资表生成工资计提凭证（没导入就记“本月无工资”）。之后再改工资表，要回这里重做计提。',
  tax: '按财务设置里的税率计提这个月的附加税费，生成一张待记账凭证。',
  profit: '把这个月的收入、费用结转到本年利润，生成一张待记账凭证。之后再补录损益要重新结转。',
};

/** 月末一步要带的：12 月先月末损益，记账后这一步还没完成时才是年度利润（含年度结转后又补损益的补做）；重做带上原凭证号 */
const jobExtra = (job: ClosingJob, annualNext: boolean, redo?: Redo): PeriodJobExtra => ({
  ...(job === 'profit' && annualNext ? { annual: true } : {}),
  ...(redo ? { redo: true, expectedVoucherId: redo.voucherId } : {}),
});

/** 结账、反结账要带上这个月期间记录的版本；还没有这个月的期间时说清楚 */
function periodVersion(record: Check['record']) {
  if (!record) throw new Error('还没有这个月的会计期间，不能结账或反结账。');
  return record.version;
}

type Run = (job: ClosingJob, label: string, redo?: Redo) => Promise<void>;

/** 在结账页直接跑的月末一步 */
function RunButton({ job, label, busy, run, redo }: { job: ClosingJob; label: string; busy: boolean; run: Run; redo?: Redo }) {
  return (
    <button type="button" className="secondary" disabled={busy} onClick={() => void run(job, label, redo)}>
      {label}
    </button>
  );
}

/** 折旧、工资、成本、税费这一步：要重做的（数变了）和还没跑的，各给一个按钮；成本到成本页的窗口里算 */
function JobButtons({ step: s, canAct, busy, run }: { step: JobsStep; canAct: boolean; busy: boolean; run: Run }) {
  return (
    <>
    {s.stale.length > 0 && (
      <div className="fb-step-jobs">
        {s.stale.map(({ kind, reason, voucherId }) => (
          <span key={kind}>
            <small>
              {jobNames[kind]}要重做：{reason}
            </small>
            {canAct &&
              (kind === 'costing' ? (
                // 重做成本可能要重新填手工流水的金额，到成本页的窗口里做
                <a className="button" href="#finance-costs?tab=costing">
                  重做成本
                </a>
              ) : (
                <RunButton job={kind} label={'重做' + jobNames[kind]} busy={busy} run={run} redo={{ voucherId }} />
              ))}
          </span>
        ))}
      </div>
    )}
    {!s.ok && canAct && s.missing.length > 0 && (
      <div className="fb-step-jobs">
        {s.missing.map((job) =>
          job === 'costing' ? (
            // 成本可能要先填期初和手工流水的金额，统一到成本页的窗口里算
            <a key={job} className="button" href="#finance-costs?tab=costing">
              {jobNames[job]}
            </a>
          ) : (
            <RunButton key={job} job={job} label={jobNames[job]} busy={busy} run={run} />
          ),
        )}
      </div>
    )}
    </>
  );
}

/** 页头的一句话：结没结账、能不能结 */
const headNote = (closed: boolean, canClose: boolean) =>
  closed
    ? '已结账。要改这个月的账，先反结账。'
    : canClose
      ? '各项都已完成，可以结账。'
      : '下面的待处理项做完才能结账。计提跑完会生成待记账凭证，记账后才算完成。';
/** 结账按钮旁的一句话 */
const footNote = (canClose: boolean, waiting: number) =>
  canClose
    ? '结账后这个月的凭证不能再新建或修改。'
    : waiting
      ? '还有 ' + waiting + ' 项待处理，做完才能结账。'
      : '';

/** 每一步右边去处理的入口；没权限处理的只显示状态 */
function stepAction(
  s: Step,
  a: { perms: ReturnType<typeof useFinPerms>; canAct: boolean; busy: boolean; run: Run },
) {
  const { perms, canAct, run } = a;
  if (s.ok) return null;
  // 要处理的不只“可记账”（有差异、待补税率、待算成本……），落到业务单据页的“全部”
  if (s.key === 'events')
    return perms.edit || perms.close ? <a href="#finance-ledger?tab=events&status=all">去处理</a> : null;
  if (s.key === 'vouchers') return perms.edit || perms.approve ? <a href="#finance-ledger">去记账</a> : null;
  if (s.key === 'bank') return perms.cash ? <a href="#finance-cash?tab=bank">去匹配</a> : null;
  if (s.key === 'profit' && 'annualNext' in s && canAct)
    return (
      <button
        type="button"
        className="secondary"
        disabled={a.busy}
        onClick={() => void run('profit', profitLabel(s))}
      >
        {profitLabel(s)}
      </button>
    );
  return null;
}

/** 一步的说明：叫什么、几项；银行流水、启用前单据的变动不强制；月末几步带上去跑的按钮 */
function StepText({ s, canAck, jobs }: { s: Step; canAck: boolean; jobs: { canAct: boolean; busy: boolean; run: Run } }) {
  return (
    <div className="fb-step-text">
      <span>
        {stepNames[s.key] || s.key}
        {'count' in s && s.count ? <em>{s.count} 项</em> : null}
      </span>
      {s.key === 'bank' && !s.ok && <small>不强制，没匹配也能结账</small>}
      {s.key === 'opening' && !s.ok && 'items' in s && <OpeningChanges items={s.items} canAck={canAck} />}
      {s.key === 'jobs' && 'missing' in s && <JobButtons step={s} {...jobs} />}
    </div>
  );
}

/**
 * 结账向导：月末动作都集中在这里，一项一项打勾，每项右边就是去处理的入口；全部完成后结账。
 * 计提、结转、结账这些直接写账的动作都先确认。没权限去处理的项只显示状态，不给链接。
 */
export default function ClosingTab({ period }: { period: string }) {
  const perms = useFinPerms();
  const { data, error } = useFinRead(['GET /finance/closing', { query: { period } }]);
  const action = useAction();
  const [confirmDialog, confirm] = useConfirm();
  const [dialog, setDialog] = useState(false);
  const steps = data?.steps ?? [];
  const annualNext = steps.some((s) => s.key === 'profit' && 'annualNext' in s && s.annualNext);
  const record = data?.record ?? null;
  const closed = record?.status === 'closed';
  const canClose = !!data?.canClose;
  const canAct = perms.close && !closed;
  const run: Run = async (job, label, redo) => {
    if (
      !(await confirm({
        title: label + '（' + period + '）',
        message: redo
          ? '原来的凭证已记账的红字冲销、没记账的作废，再按现在的数重新生成一张待记账凭证。'
          : jobMessages[job] + '到凭证页记账后这一步才算完成。',
        confirmLabel: label,
      }))
    )
      return;
    await action.run(async () => {
      const result = await runPeriodJob(job, period, jobExtra(job, annualNext, redo));
      notify(accrualNotice(label, result));
    });
  };
  const waiting = steps.filter((s) => !s.ok && s.blocking).length;
  const jobs = { canAct, busy: action.busy, run };
  return (
    <section className="panel fin-card business-records fb-closing">
      <header className="fb-closing-head">
        <div>
          <h2>{period} 结账</h2>
          <p>
            {headNote(closed, canClose)}
          </p>
        </div>
        <FinStatusChip value={record?.status || 'open'} />
      </header>
      <ErrorLine text={error} />
      <ErrorLine text={action.error} close={action.clear} />
      {data && !closed && data.next !== period && (
        <Hint tone="warning">要按顺序结账，下一个该结的是 {data.next || '启用期'}。</Hint>
      )}
      <ol className="fb-steps">
        {steps.map((s) => (
          <li key={s.key}>
            <StatusChip tone={s.ok ? 'success' : s.blocking ? 'warning' : 'neutral'}>
              {s.ok ? '完成' : s.blocking ? '待处理' : '建议'}
            </StatusChip>
            <StepText s={s} canAck={perms.edit && !closed} jobs={jobs} />
            <div className="fb-step-action">{stepAction(s, { perms, ...jobs })}</div>
          </li>
        ))}
      </ol>
      {perms.close && (
        <div className="fb-closing-foot fin-subform">
          {/* 主按钮放左边：右下角常驻助手图标，放右边会被挡住 */}
          {!closed && (
            <>
              <button
                className="primary"
                disabled={action.busy || !canClose}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: '结账 ' + period,
                      message: '结账后这个月的凭证不能再新建或修改，要改得先反结账。',
                      confirmLabel: '结账',
                    }))
                  )
                    return;
                  await action.run(async () => {
                    await closePeriod(period, periodVersion(record));
                    notify(period + ' 已结账。');
                  });
                }}
              >
                结账
              </button>
              <span className="fb-closing-note">
                {footNote(canClose, waiting)}
              </span>
            </>
          )}
          {closed && (
            <>
              <button className="secondary" onClick={() => setDialog(true)}>
                反结账
              </button>
              <ExportLink path="/archive/download" query={{ period }} label="下载归档文件" />
              <span className="fb-closing-note" />
            </>
          )}
        </div>
      )}
      {dialog && (
        <FormDialog
          title={'反结账 ' + period}
          size="sm"
          danger
          columns={1}
          intro="只能反结最近一个已结的月份。已生成的报表快照保留。"
          submitLabel="确认反结账"
          fields={[{ name: 'reason', label: '原因', type: 'textarea', required: true }]}
          notice={'已反结账 ' + period + '。'}
          close={() => setDialog(false)}
          submit={(v) => reopenPeriod(period, filled(v.reason, '原因'), periodVersion(record))}
        />
      )}
      {confirmDialog}
    </section>
  );
}
