import { useEffect, useState } from 'react';
import { useConfirm, notify, hashParams, stepper, useAction } from '../../ui/index';
import VoucherEditor from './VoucherEditor';
import VoucherPanel, { VoucherStatus } from './VoucherPanel';
import { ErrorLine, PeriodInput, type HeadFn } from '../layout';
import { FinList, col, type Col } from '../table';
import { useFinPerms, type FinData } from '../fin-api';
import { listVouchers, voucherStep } from './ledger-api';
import { usePeriod } from '../page-state';
import { RedInk } from '../status';

/** 凭证的“待确认”和业务单据撞名，这里叫“未提交”；已记账的规则不变。 */
const voucherStates = [
  ['', '全部状态'],
  ['draft', '未提交'],
  ['pending', '待审核'],
  ['approved', '已审核'],
  ['posted', '已记账'],
  ['void', '已作废'],
] as const;
/** 凭证列表的一行（凭证头） */
type VoucherRow = FinData<'GET /finance/vouchers'>['rows'][number];

/** 凭证列表的列：红字凭证的摘要前标“红字” */
const voucherColumns: Col<VoucherRow>[] = [
  col('number', '凭证号', { num: true }),
  col('date', '日期'),
  col('description', '摘要', {
    wrap: true,
    render: (r) =>
      r.reversal_of ? (
        <>
          <RedInk /> {r.description}
        </>
      ) : (
        r.description
      ),
  }),
  col('maker_name', '制单'),
  col('status', '状态', { render: (r) => <VoucherStatus value={r.status} /> }),
];

/** 凭证按状态往前推一步：未提交 → 提交审核 → 审核 → 记账。 */
const steps = [
  { from: 'draft', step: 'submit', label: '提交', done: '已提交审核', perm: 'edit' },
  { from: 'pending', step: 'approve', label: '审核', done: '已审核', perm: 'approve' },
  { from: 'approved', step: 'post', label: '记账', done: '已记账', perm: 'approve' },
] as const;

export default function VouchersTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<number | null>(() => {
    const v = hashParams().get('voucher');
    return v ? Number(v) : null;
  });
  // 详情里点“冲销的是”那张凭证：页面不换，地址里的 voucher 变了也要跟着打开
  useEffect(() => {
    const follow = () => {
      const v = hashParams().get('voucher');
      if (v) setSelected(Number(v));
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const [creating, setCreating] = useState(false);
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const action = useAction();
  const [confirmDialog, confirm] = useConfirm();
  // 只给当前能做的那一步：先提交，再审核，最后记账；每一步都先确认
  const next = steps.find((s) => perms[s.perm] && rows.some((r) => r.status === s.from));
  const picked = next ? rows.filter((r) => r.status === next.from) : [];
  const advance = async () => {
    if (!next) return;
    const ok = await confirm({
      title: next.label + '本页 ' + picked.length + ' 张凭证',
      message:
        next.step === 'post'
          ? '记账后凭证不能改、不能删，错了只能红字冲销。审核分离开着时，自己制的单不能自己审。'
          : next.step === 'approve'
            ? '审核后还要记账才生效。审核分离开着时，自己制的单会被拒绝并说明原因。'
            : '提交后等审核，审核、记账后才生效。',
      confirmLabel: next.label + ' ' + picked.length + ' 张',
    });
    if (!ok) return;
    await action.run(async () => {
      for (const row of picked) await voucherStep(row, next.step);
      notify(next.done + ' ' + picked.length + ' 张凭证。');
    });
  };
  const create = perms.edit ? { label: '新建凭证', onClick: () => setCreating(true) } : null;
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        primary: next
          ? {
              label: next.label + '本页 ' + picked.length + ' 张',
              disabled: action.busy,
              onClick: () => void advance(),
            }
          : create,
        secondary: next ? create : null,
      })}
      <div className="fin-toolbar">
        <select aria-label="凭证状态" value={status} onChange={(e) => setStatus(e.target.value)}>
          {voucherStates.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        list={listVouchers}
        label="凭证"
        query={{ period, status: status || undefined }}
        onData={(d) => setRows(d.rows)}
        onRow={(r) => setSelected(r.id)}
        selected={selected}
        empty="这个月还没有凭证"
        cols={voucherColumns}
      />
      {selected && (
        <VoucherPanel
          id={selected}
          close={() => setSelected(null)}
          {...stepper(
            rows,
            (r) => r.id,
            selected,
            (r) => setSelected(r.id),
          )}
        />
      )}
      {creating && (
        <VoucherEditor close={() => setCreating(false)} saved={(id) => setSelected(id)} />
      )}
      {confirmDialog}
    </>
  );
}
