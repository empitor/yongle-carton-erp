import { today } from '../../../shared/core/index';
import { yuan } from '../../ui/index';
import { FormDialog } from '../FormDialog';
import type { Field } from '../form-values';
import { moveExpense, saveEmployeeAdvance, saveExpense, type ExpenseRow } from './costs-api';

/* 费用报销的几个窗口：新建或编辑费用单、付款、退回，和员工借还款。 */

const expenseFields: Field[] = [
  { name: 'employeeId', label: '员工工号', required: true, section: '谁报销' },
  { name: 'employeeName', label: '员工姓名', required: true, section: '谁报销' },
  { name: 'department', label: '部门', required: true, section: '谁报销' },
  { name: 'date', label: '日期', type: 'date', required: true, section: '报销什么' },
  { name: 'amount', label: '金额', type: 'money', required: true, section: '报销什么' },
  { name: 'accountCode', label: '费用科目', type: 'account', required: true, section: '报销什么', span: 'full' },
  { name: 'description', label: '说明', required: true, section: '报销什么', span: 'full' },
];

export const expenseAmount = (row: Pick<ExpenseRow, 'amount_cents'>) => yuan(row.amount_cents) + ' 元';

/** 新建（不给 row）或编辑费用单 */
export function ExpenseForm({ row, close, done }: { row?: ExpenseRow; close: () => void; done?: () => void }) {
  return (
    <FormDialog
      title={row ? '编辑费用单' : '新建费用单'}
      subtitle={row ? row.description : undefined}
      size="md"
      sections={[
        { title: '谁报销', columns: 3 },
        { title: '报销什么', columns: 2 },
      ]}
      note="提交审批、批准后生成待记账凭证。"
      fields={expenseFields}
      initial={
        row
          ? {
              employeeId: row.employee_id,
              employeeName: row.employee_name,
              department: row.department,
              date: row.date,
              accountCode: row.account_code,
              amount: row.amount_cents,
              description: row.description,
            }
          : { date: today() }
      }
      submitLabel="保存费用单"
      notice={row ? '费用单已保存。' : '费用单已保存，待提交审批。'}
      close={close}
      submit={async (v) => {
        await saveExpense(v, row);
        done?.();
      }}
    />
  );
}

/** 窗口要的：哪张费用单、关窗、办完以后（关掉详情） */
type RowDialog = { row: ExpenseRow; close: () => void; done: () => void };

export function ExpensePayDialog({ row, close, done }: RowDialog) {
  return (
    <FormDialog
      title="付款"
      subtitle={[row.employee_name, row.description, expenseAmount(row)].join(' · ')}
      submitLabel="确认付款"
      size="sm"
      columns={1}
      note="确认后生成一张已确认的付款单。"
      fields={[
        { name: 'date', label: '付款日期', type: 'date', required: true },
        { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
      ]}
      initial={{ date: today() }}
      notice={'已付款 ' + expenseAmount(row) + '。'}
      close={close}
      submit={async (v) => {
        await moveExpense(row, 'pay', v);
        done();
      }}
    />
  );
}

export function ExpenseRejectDialog({ row, close, done }: RowDialog) {
  return (
    <FormDialog
      title="退回费用单"
      subtitle={row.description + ' · ' + expenseAmount(row)}
      size="sm"
      submitLabel="退回"
      fields={[{ name: 'reason', label: '原因', type: 'textarea', required: true }]}
      notice="费用单已退回。"
      close={close}
      submit={async (v) => {
        await moveExpense(row, 'reject', v);
        done();
      }}
    />
  );
}

/** 员工借还款不走审批，直接生成凭证 */
export function AdvanceDialog({ close }: { close: () => void }) {
  return (
    <FormDialog
      title="新建员工借还款"
      size="md"
      sections={[
        { title: '谁借还', columns: 3 },
        { title: '多少钱、从哪走', columns: 2 },
      ]}
      note="直接生成待记账凭证，记账后生效。"
      fields={[
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          required: true,
          section: '谁借还',
          options: [
            ['loan', '借款'],
            ['repayment', '还款'],
          ],
        },
        { name: 'employeeId', label: '员工工号', required: true, section: '谁借还' },
        { name: 'employeeName', label: '员工姓名', required: true, section: '谁借还' },
        { name: 'date', label: '日期', type: 'date', required: true, section: '多少钱、从哪走' },
        { name: 'amount', label: '金额', type: 'money', required: true, section: '多少钱、从哪走' },
        { name: 'accountId', label: '资金账户', type: 'cash-account', required: true, section: '多少钱、从哪走' },
        { name: 'accountCode', label: '其他应收科目', type: 'account', required: true, section: '多少钱、从哪走' },
        { name: 'description', label: '说明', required: true, section: '多少钱、从哪走', span: 'full' },
      ]}
      initial={{ kind: 'loan', date: today(), accountCode: '1221' }}
      submitLabel="保存借还款"
      notice="借还款已登记，凭证待记账。"
      close={close}
      submit={saveEmployeeAdvance}
    />
  );
}
