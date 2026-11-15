import { useState } from 'react';
import { stepper } from '../../ui/index';
import { FinList, col, mon, type Col } from '../table';
import { Status } from '../status';
import { useFinPerms } from '../fin-api';
import { type HeadFn } from '../layout';
import ExpensePanel from './ExpensePanel';
import { AdvanceDialog, ExpenseForm } from './ExpenseDialogs';
import { listExpenses, type ExpenseRow } from './costs-api';

const expenseCols: Col<ExpenseRow>[] = [
  col('date', '日期'),
  col('employee_name', '员工'),
  col('department', '部门'),
  col('description', '说明', { wrap: true }),
  col('status', '状态', { render: (r) => <Status value={r.status} /> }),
  mon('amount_cents', '金额 / 元'),
];

/**
 * 费用报销：新建 → 提交审批 → 批准（生成待记账凭证）→ 凭证记账后付款。
 * 员工借还款不走审批，直接生成凭证，入口在页头“更多”。
 */
export default function ExpensesTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [row, setRow] = useState<ExpenseRow | null>(null);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [dialog, setDialog] = useState<'new' | 'advance' | null>(null);
  return (
    <>
      {head({
        primary: perms.edit ? { label: '新建费用单', onClick: () => setDialog('new') } : null,
        more: [perms.cash && { label: '新建员工借还款', onClick: () => setDialog('advance') }],
      })}
      <FinList
        list={listExpenses}
        query={{}}
        label="费用单"
        onData={(d) => setRows(d.rows)}
        onRow={setRow}
        selected={row?.id}
        empty={perms.edit ? '还没有费用单，员工报销时点页面上方的“新建费用单”' : '还没有费用单'}
        cols={expenseCols}
      />
      {row && (
        <ExpensePanel
          key={row.id}
          row={row}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {dialog === 'new' && <ExpenseForm close={() => setDialog(null)} done={() => setRow(null)} />}
      {dialog === 'advance' && <AdvanceDialog close={() => setDialog(null)} />}
    </>
  );
}
