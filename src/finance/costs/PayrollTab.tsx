import { useRef, useState } from 'react';
import { ManagementDialog, FormMessage, FormSection, useConfirm, Hint, yuan, notify, useAction, FormField, Loading } from '../../ui/index';
import { EditorShell, Stats } from '../editor';
import { today } from '../../../shared/core/index';
import { PeriodInput, FinSection, type HeadFn } from '../layout';
import { FinList, col, mon, type Col } from '../table';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import {
  accrualNotice,
  accruePayroll,
  closingJobs,
  jobDone,
  listPayroll,
  payPayroll,
  payrollPayment,
  uploadPayroll,
} from './costs-api';
import { usePeriod } from '../page-state';
import { FormDialog } from '../FormDialog';

const payrollColumns = [
  '工号',
  '姓名',
  '部门',
  '科目',
  '应发',
  '个人社保',
  '个人公积金',
  '个税',
  '实发',
  '单位社保',
  '单位公积金',
];

type Stage = 'loading' | 'import' | 'accrue' | 'pay' | 'done';
/** 工资列表的一行：员工明细或按部门的合计 */
type PayrollListRow = Awaited<ReturnType<typeof listPayroll>>['rows'][number];
/** 这个月工资的实发、已发、还剩 */
type Payment = FinData<'GET /finance/payroll/payment'>;

/** 工资的列：看员工明细时第一列是员工，否则是人数 */
const payrollCols = (detail: boolean): Col<PayrollListRow>[] => [
  detail ? col('employee_name', '员工') : col('employees', '人数', { num: true }),
  col('department', '部门'),
  mon('gross', '应发'),
  mon('social', '个人社保'),
  mon('housing', '个人公积金'),
  mon('tax', '个税'),
  mon('net', '实发'),
  mon('employer_social', '单位社保'),
  mon('employer_housing', '单位公积金'),
];

/** 工资这个月到哪一步：先导入工资表，再计提，计提凭证记账后发放，发完就是 done */
function payrollStage(s: { ready: boolean; accrued: boolean; imported: boolean; remaining: number }): Stage {
  if (!s.ready) return 'loading';
  if (!s.accrued) return s.imported ? 'accrue' : 'import';
  return s.remaining > 0 ? 'pay' : 'done';
}

/** 页头按步骤给一个主按钮；导入工资表随时能重来（计提后改了要到结账页重做计提），放“更多” */
function payrollHead(
  stage: Stage,
  a: {
    perms: ReturnType<typeof useFinPerms>;
    busy: boolean;
    posted: boolean;
    open: (d: 'upload' | 'pay') => void;
    accrue: (empty?: boolean) => void;
  },
) {
  const upload = a.perms.close ? { label: '导入工资表', onClick: () => a.open('upload') } : null;
  const accrue = a.perms.close ? { label: '计提工资', disabled: a.busy, onClick: () => a.accrue() } : null;
  const pay = a.perms.cash
    ? {
        label: '发放工资',
        disabled: !a.posted,
        title: a.posted ? undefined : '计提凭证记账后才能发放',
        onClick: () => a.open('pay'),
      }
    : null;
  if (stage === 'import')
    return {
      primary: upload,
      more: [a.perms.close && { label: '本月没有工资，直接计提', onClick: () => a.accrue(true) }],
    };
  if (stage === 'accrue') return { primary: accrue, more: [upload && { ...upload, label: '重新导入工资表' }] };
  if (stage === 'loading') return { primary: null, more: [] };
  return {
    primary: stage === 'pay' ? pay : null,
    // 计提以后工资表还能改：改完到结账页重做工资计提
    more: [upload && { ...upload, label: '重新导入工资表（改完要重做计提）' }],
  };
}

/** 工资这个月走到哪一步，一句话说下一步做什么 */
function PayrollHint({
  stage,
  period,
  posted,
  payment,
  canImport,
}: {
  stage: Stage;
  period: string;
  posted: boolean;
  payment: Payment | null;
  canImport: boolean;
}) {
  const net = Number(payment?.net || 0),
    remaining = Number(payment?.remaining || 0);
  return (
    <>
      {stage === 'import' && (
        <Hint>
          {period} 还没有工资。先导入算好的工资表{canImport ? '' : '（需要财务负责人导入）'}；没有工资的月份，
          结账前点“更多”里的“本月没有工资，直接计提”。
        </Hint>
      )}
      {stage === 'accrue' && <Hint>工资表已导入，核对无误后点“计提工资”，生成待记账凭证。</Hint>}
      {stage === 'pay' && !posted && (
        <Hint>工资已计提，凭证还没记账。到凭证账簿记账后才能发放。</Hint>
      )}
      {stage === 'pay' && posted && (
        <Hint>
          实发合计 {yuan(net)} 元，已发 {yuan(payment?.paid)} 元，还剩 {yuan(remaining)} 元。可以分几次发。
        </Hint>
      )}
      {stage === 'done' && net > 0 && <Hint>{period} 工资已经发完。</Hint>}
    </>
  );
}

/**
 * 工资：按状态一个主按钮，导入工资表 → 计提工资（先确认）→ 发放工资。
 * 只导入算好的工资汇总，系统不算个税和社保；工资进正式报表，不进理论盈亏。
 */
export default function PayrollTab({ head, enabled }: { head: HeadFn; enabled: boolean }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [detail, setDetail] = useState(false);
  const [dialog, setDialog] = useState<'upload' | 'pay' | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const action = useAction();
  const [confirmDialog, confirm] = useConfirm();
  const payment = useFinRead(payrollPayment(period));
  const closing = useFinRead(enabled ? closingJobs(period) : null);
  // 计提过、凭证也记了账（或这个月没有工资、不用凭证）
  const posted = jobDone(closing.data, 'payroll');
  const net = Number(payment.data?.net || 0),
    remaining = Number(payment.data?.remaining || 0);
  const accrued = net > 0 || posted;
  const accrue = async (empty: boolean) => {
    if (
      !(await confirm({
        title: '计提 ' + period + ' 工资',
        message: empty
          ? '这个月没有工资数据，计提后只记一笔“本月无工资”，结账时这一项就算完成。'
          : '按导入的工资表生成一张待记账凭证：工资费用记到各部门科目，应付工资、社保、公积金、个税挂账。计提后再改工资表，要到结账页重做计提。',
        confirmLabel: '计提工资',
      }))
    )
      return;
    await action.run(async () => {
      const result = await accruePayroll(period);
      notify(result?.voucherId != null ? period + ' 工资已计提，凭证待记账，记账后才能发放。' : accrualNotice(period + ' 计提工资', result));
    });
  };
  const ready = !!payment.data && imported !== null && (!enabled || !!closing.data);
  const stage = payrollStage({ ready, accrued, imported: !!imported, remaining });
  const { primary, more } = payrollHead(stage, {
    perms,
    busy: action.busy,
    posted,
    open: setDialog,
    accrue: (empty) => void accrue(empty ?? !imported),
  });
  return (
    <>
      {head({ children: <PeriodInput value={period} onChange={setPeriod} />, primary, more })}
      <FormMessage close={action.clear}>{action.error}</FormMessage>
      <PayrollHint
        stage={stage}
        period={period}
        posted={posted}
        payment={payment.data}
        canImport={perms.close}
      />
      <FinSection
        title={period + ' 工资'}
        note="只导入算好的汇总，系统不算个税和社保"
        extra={
          perms.close && (
            <label className="fin-check">
              <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} />
              看员工明细
            </label>
          )
        }
      >
        <FinList
          list={listPayroll}
          label="工资"
          query={{ period, detail: detail ? 1 : 0 }}
          rowKey={(r) => ('id' in r ? r.id : r.department)}
          onData={(d) => setImported(d.filteredRecords)}
          empty="这个月没有工资数据"
          cols={payrollCols(detail)}
        />
      </FinSection>
      {dialog === 'upload' && <PayrollUploadDialog period={period} close={() => setDialog(null)} />}
      {dialog === 'pay' && <PayrollPayDialog period={period} close={() => setDialog(null)} />}
      {confirmDialog}
    </>
  );
}

/** 导入算好的工资表：选文件，列顺序一眼看清。 */
function PayrollUploadDialog({ period, close }: { period: string; close: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <EditorShell
      title={'导入 ' + period + ' 工资表'}
      size="md"
      submitLabel="导入工资表"
      note="只导入算好的汇总，系统不算个税和社保。"
      close={close}
      submit={async () => {
        const file = fileRef.current?.files?.[0];
        if (!file) throw new Error('请选择文件。');
        await uploadPayroll(period, file);
        return period + ' 工资表已导入。';
      }}
    >
      <FormSection title="选文件" columns={1}>
        <FormField label="工资表文件" required hint="Excel（.xlsx）或 CSV">
          <input ref={fileRef} type="file" accept=".csv,.xlsx" />
        </FormField>
      </FormSection>
      <FormSection title="表里的列" hint="第一行是表头，从第二行起按这个顺序排：" columns={1}>
        <ol className="fb-columns">
          {payrollColumns.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </FormSection>
    </EditorShell>
  );
}

/** 工资可以分几次发：显示实发合计、已发、还剩，金额默认填剩下的全部。 */
function PayrollPayDialog({ period, close }: { period: string; close: () => void }) {
  const { data, error } = useFinRead(payrollPayment(period));
  const title = '发放 ' + period + ' 工资';
  if (!data)
    return (
      <ManagementDialog title={title} size="sm" close={close}>
        {error ? (
          <FormMessage>{error}</FormMessage>
        ) : (
          <Loading />
        )}
      </ManagementDialog>
    );
  return (
    <FormDialog
      title={title}
      size="sm"
      columns={1}
      leading={
        <Stats
          items={[
            ['实发合计', yuan(data.net)],
            ['已发', yuan(data.paid)],
            ['还剩', yuan(data.remaining)],
          ]}
        />
      }
      note="可以分几次发，比如先发一部分、过几天再补发。"
      submitLabel="确认发放"
      fields={[
        { name: 'amount', label: '本次发放', type: 'money', required: true },
        { name: 'date', label: '发放日期', type: 'date', required: true },
        { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
      ]}
      initial={{ date: today(), amount: data.remaining }}
      close={close}
      submit={async (v) => {
        await payPayroll(period, v);
        notify('已发放 ' + yuan(v.amount) + ' 元工资。');
      }}
    />
  );
}
