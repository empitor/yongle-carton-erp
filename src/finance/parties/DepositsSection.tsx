import { useState } from 'react';
import { FormMessage, yuan, stepper, loadingText } from '../../ui/index';
import type { Kind } from './shared';
import { today } from '../../../shared/core/index';
import { voucherStateNames } from '../labels';
import { FinSection } from '../layout';
import { FinTable, col, mon, type Col } from '../table';
import { FormDialog } from '../FormDialog';
import { useFinPerms, useFinRead } from '../fin-api';
import DepositPanel, { depositDirection } from './DepositPanel';
import { allDeposits, saveDeposit, type DepositRow } from './parties-api';

const depositCols: Col<DepositRow>[] = [
  col('date', '日期'),
  col('kind', '方向', { render: depositDirection }),
  col('party_name', '往来单位', { wrap: true }),
  // 右侧详情打开时收说明，详情里有全文
  col('description', '说明', { wrap: true, priority: 'low' }),
  mon('amount_cents', '金额 / 元'),
  col('balance', '余额 / 元', {
    money: true,
    render: (r) => (r.voucher_state ? voucherStateNames[r.voucher_state] : yuan(r.balance)),
  }),
];

/**
 * 保证金：不算收入支出，在经营报表里单独列。按页签上的应收 / 应付看客户的或供应商的；
 * 点一行看详情，有余额的在详情里退回或转抵货款。
 */
export default function DepositsSection({ kind }: { kind: Kind }) {
  const perms = useFinPerms();
  const partyKind = kind === 'receivable' ? 'customer' : 'supplier';
  const [dialog, setDialog] = useState(false);
  const [row, setRow] = useState<DepositRow | null>(null);
  const { data, error } = useFinRead(allDeposits);
  const rows = (data?.rows || []).filter((r) => r.party_kind === partyKind);
  const current = row && rows.find((r) => r.id === row.id);
  return (
    <FinSection
      id="deposits"
      title="保证金"
      note="不算收入支出，经营报表里单独列"
      extra={
        perms.cash && (
          <button type="button" className="secondary" onClick={() => setDialog(true)}>
            新建保证金
          </button>
        )
      }
    >
      <FormMessage>{error}</FormMessage>
      <FinTable
        label="保证金"
        rows={rows}
        onRow={setRow}
        selected={row?.id}
        empty={
          data ? '还没有' + (kind === 'receivable' ? '客户' : '供应商') + '的保证金' : loadingText()
        }
        cols={depositCols}
      />
      {current && (
        <DepositPanel
          key={current.id}
          current={current}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, current.id, setRow)}
        />
      )}
      {dialog && (
        <FormDialog
          title="新建保证金"
          size="md"
          sections={[{ title: '谁的保证金' }, { title: '多少钱、走哪个账户' }]}
          fields={[
            {
              name: 'kind',
              label: '方向',
              type: 'select',
              required: true,
              section: '谁的保证金',
              options: [
                ['paid', '我们付出'],
                ['received', '我们收到'],
              ],
            },
            {
              name: 'partyKind',
              label: '单位类型',
              type: 'select',
              required: true,
              section: '谁的保证金',
              options: [
                ['supplier', '供应商'],
                ['customer', '客户'],
              ],
            },
            {
              name: 'partyId',
              label: '单位',
              type: 'party',
              required: true,
              span: 'full',
              section: '谁的保证金',
              partyKind: (v) => (v.partyKind === 'customer' ? 'customer' : 'supplier'),
            },
            {
              name: 'amount',
              label: '金额 / 元',
              type: 'money',
              required: true,
              section: '多少钱、走哪个账户',
            },
            {
              name: 'date',
              label: '日期',
              type: 'date',
              required: true,
              section: '多少钱、走哪个账户',
            },
            {
              name: 'accountId',
              label: '资金账户',
              type: 'cash-account',
              required: true,
              section: '多少钱、走哪个账户',
            },
            {
              name: 'description',
              label: '说明',
              required: true,
              section: '多少钱、走哪个账户',
            },
          ]}
          initial={{
            kind: partyKind === 'customer' ? 'received' : 'paid',
            partyKind,
            date: today(),
          }}
          submitLabel="保存保证金"
          notice="保证金已登记，凭证待记账。"
          close={() => setDialog(false)}
          submit={saveDeposit}
        />
      )}
    </FinSection>
  );
}
