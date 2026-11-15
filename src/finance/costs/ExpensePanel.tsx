import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, notify, useAction } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { useAccountNames } from '../editor';
import { useSourceVoucher } from '../source-voucher';
import { FinStatusChip } from '../status';
import { useFinPerms } from '../fin-api';
import { moveExpense, type ExpenseRow } from './costs-api';
import { ExpenseForm, ExpensePayDialog, ExpenseRejectDialog, expenseAmount } from './ExpenseDialogs';

/* 费用单详情：提交审批 → 批准（生成待记账凭证）→ 付款，退回、编辑，凭证的撤回。列表在 ExpensesTab.tsx。 */

export default function ExpensePanel({
  row,
  close,
  previous,
  next,
}: {
  row: ExpenseRow;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  const perms = useFinPerms();
  const accountName = useAccountNames();
  const voucher = useSourceVoucher(row.voucher_id, close);
  const [dialog, setDialog] = useState<'edit' | 'pay' | 'reject' | null>(null);
  const action = useAction();
  const amountText = expenseAmount(row);
  const editable = ['draft', 'rejected'].includes(row.status) && perms.edit;
  const pending = row.status === 'pending' && perms.approve;
  const move = (act: 'submit' | 'approve') =>
    action.run(async () => {
      await moveExpense(row, act, act === 'approve' ? { date: today() } : {});
      close();
      notify(act === 'submit' ? '费用单已提交审批。' : '已批准，生成了待记账凭证，记账后才能付款。');
    });
  const open = (d: typeof dialog) => {
    action.clear();
    setDialog(d);
  };
  const shut = () => setDialog(null);
  return (
    <>
      <DetailPanel
        kicker="费用报销"
        title={row.description}
        subtitle={[row.employee_name, row.department, amountText].filter(Boolean).join(' · ')}
        status={<FinStatusChip value={row.status} />}
        close={close}
        previous={previous}
        next={next}
        actions={
          <ActionBar
            primary={[
              { label: '提交审批', hidden: !editable, disabled: action.busy, onClick: () => void move('submit') },
              { label: '批准', hidden: !pending, disabled: action.busy, onClick: () => void move('approve') },
              {
                label: '付款',
                hidden: !(row.status === 'approved' && perms.cash),
                onClick: () => open('pay'),
              },
            ]}
            secondary={[
              { label: '编辑', hidden: !editable, onClick: () => open('edit') },
              { label: '退回', hidden: !pending, onClick: () => open('reject') },
            ]}
            more={voucher.action ? [voucher.action] : []}
          />
        }
      >
        {action.error && <Hint tone="danger">{action.error}</Hint>}
        {row.status === 'rejected' && <Hint tone="warning">已退回，改好后重新提交审批。</Hint>}
        {row.status === 'approved' && <Hint>付款前，这张费用单的凭证要先记账。</Hint>}
        <Section title="基本信息">
          <Facts
            items={[
              { label: '金额', value: amountText },
              { label: '费用科目', value: accountName(row.account_code) },
              {
                label: '员工',
                value: row.employee_name + (row.employee_id ? '（' + row.employee_id + '）' : ''),
              },
              { label: '部门', value: row.department },
              { label: '日期', value: row.date },
              {
                label: '凭证',
                value: <a href={'#finance-ledger?voucher=' + row.voucher_id}>查看凭证</a>,
                hidden: !row.voucher_id,
              },
              {
                label: '说明',
                value: row.description,
                wide: true,
                hidden: String(row.description || '').length <= 16,
              },
            ]}
          />
        </Section>
      </DetailPanel>
      {voucher.dialog}
      {dialog === 'edit' && <ExpenseForm row={row} close={shut} done={close} />}
      {dialog === 'pay' && <ExpensePayDialog row={row} close={shut} done={close} />}
      {dialog === 'reject' && <ExpenseRejectDialog row={row} close={shut} done={close} />}
    </>
  );
}
