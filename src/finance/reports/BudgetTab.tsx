import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, yuan, stepper } from '../../ui/index';
import { type TabProps } from './FormalReports';
import { FinList, col, mon, type Col } from '../table';
import { FinSection, PeriodInput } from '../layout';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { listBudgets, saveBudget } from './reports-api';
import { FormDialog } from '../FormDialog';

type BudgetRow = FinData<'GET /finance/budgets'>['rows'][number];

const budgetCols: Col<BudgetRow>[] = [
  col('account_code', '科目编码'),
  col('name', '科目'),
  mon('amount_cents', '预算'),
  mon('actual', '实际'),
  mon('difference', '差额'),
];

/** 新建（row 是 null）或编辑一个科目这个月的预算 */
function BudgetDialog({ period, row, close }: { period: string; row: BudgetRow | null; close: () => void }) {
  return (
    <FormDialog
      title={(row ? '编辑 ' : '新建 ') + period + ' 预算'}
      size="sm"
      columns={1}
      fields={[
        { name: 'accountCode', label: '科目', type: 'account', required: true },
        { name: 'amount', label: '金额', type: 'money', required: true },
      ]}
      initial={{ accountCode: row?.account_code, amount: row?.amount_cents }}
      submitLabel="保存预算"
      notice="预算已保存。"
      close={close}
      submit={(v) => saveBudget({ ...v, period, ...(row ? { version: row.version } : {}) })}
    />
  );
}

/** 预算：不常用，从“更多”打开。点一行看详情，编辑在详情里；已结账的月份不能改。 */
export default function BudgetTab({ head, period, setPeriod }: TabProps) {
  const perms = useFinPerms();
  const [row, setRow] = useState<BudgetRow | null>(null);
  const [rows, setRows] = useState<BudgetRow[]>([]);
  // 新建是 'new'，编辑是那一行
  const [editing, setEditing] = useState<BudgetRow | 'new' | null>(null);
  const periods = useFinRead(['GET /finance/periods']);
  const closed = (periods.data ?? []).some((p) => p.period === period && p.status === 'closed');
  const canEdit = perms.close && !closed;
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        primary: canEdit ? { label: '新建预算', onClick: () => setEditing('new') } : null,
      })}
      {closed && <Hint>这个月已结账，预算不能再改。</Hint>}
      <FinSection id="budget" title={period + ' 预算'} note="按科目设，和实际发生额对比">
        <FinList
          list={listBudgets}
          label="预算"
          query={{ period }}
          rowKey={(r) => r.account_code}
          onRow={setRow}
          onData={(d) => setRows(d.rows)}
          selected={row?.account_code}
          empty={canEdit ? '这个月没有预算，点页面上方的“新建预算”' : '这个月没有预算'}
          cols={budgetCols}
        />
      </FinSection>
      {row && (
        <DetailPanel
          kicker={period + ' 预算'}
          title={row.account_code + ' ' + row.name}
          subtitle={'预算 ' + yuan(row.amount_cents) + ' 元 · 实际 ' + yuan(row.actual) + ' 元'}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.account_code, row.account_code, setRow)}
          actions={
            <ActionBar
              primary={[{ label: '编辑预算', hidden: !canEdit, onClick: () => setEditing(row) }]}
            />
          }
        >
          <Section title="对比">
            <Facts
              items={[
                { label: '预算', value: yuan(row.amount_cents) + ' 元' },
                { label: '实际', value: yuan(row.actual) + ' 元' },
                { label: '差额', value: yuan(row.difference) + ' 元' },
              ]}
            />
          </Section>
        </DetailPanel>
      )}
      {editing && (
        <BudgetDialog
          period={period}
          row={editing === 'new' ? null : editing}
          close={() => {
            setEditing(null);
            setRow(null);
          }}
        />
      )}
    </>
  );
}
