import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, yuan } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { financeRecordNames } from '../../../shared/finance/index';
import { SourceVoucherButton, useSourceVoucher } from '../source-voucher';
import { voucherStateNames } from '../labels';
import { FormDialog } from '../FormDialog';
import { useFinPerms } from '../fin-api';
import { depositAction, type DepositRow } from './parties-api';

/* 保证金详情：基本信息、退回和转抵的记录（每笔可撤回），退回、转抵货款两个窗口。列表在 DepositsSection.tsx。 */

export const depositDirection = (r: { kind: string }) => (r.kind === 'paid' ? '我们付出' : '我们收到');

/** 保证金的一次退回或转抵 */
type DepositAction = DepositRow['actions'][number];
/** 退回、转抵各叫什么（和月度台账、凭证来源同一份叫法） */
const actionNames: Record<DepositAction['kind'], string> = {
  refund: financeRecordNames.deposit_refund,
  apply: financeRecordNames.deposit_apply,
};

function DepositActions({ actions, done }: { actions: DepositAction[]; done: () => void }) {
  return (
    <Section title="退回和转抵">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>是什么</th>
              <th className="num">金额（元）</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{a.date}</td>
                <td>{actionNames[a.kind]}</td>
                <td className="num">{yuan(a.amount_cents)}</td>
                <td>
                  {a.voucher_state ? (
                    voucherStateNames[a.voucher_state]
                  ) : (
                    <SourceVoucherButton voucherId={a.voucher_id} done={done} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** 退回（要选资金账户）或转抵货款（要选抵哪张单子） */
function DepositDialog({
  current,
  dialog,
  close,
  done,
}: {
  current: DepositRow;
  dialog: 'refund' | 'apply';
  close: () => void;
  done: () => void;
}) {
  return (
    <FormDialog
      title={dialog === 'refund' ? '退回保证金' : '保证金转抵货款'}
      subtitle={[current.party_name, depositDirection(current), '余额 ' + yuan(current.balance) + ' 元'].join(' · ')}
      size="md"
      fields={[
        ...(dialog === 'apply'
          ? [
              {
                name: 'obligationId',
                label: '抵扣哪张单子',
                type: 'obligation' as const,
                required: true,
                wide: true,
                obligation: {
                  kind: current.kind === 'paid' ? ('payable' as const) : ('receivable' as const),
                  partyId: current.party_id,
                },
              },
            ]
          : []),
        { name: 'amount', label: '金额（元）', type: 'money', required: true },
        { name: 'date', label: '日期', type: 'date', required: true },
        ...(dialog === 'refund'
          ? [{ name: 'accountId', label: '资金账户', type: 'cash-account' as const, required: true }]
          : []),
        { name: 'reason', label: '原因', required: true, wide: true },
      ]}
      initial={{ date: today(), amount: current.balance }}
      submitLabel={dialog === 'refund' ? '确认退回' : '确认转抵'}
      notice={dialog === 'refund' ? '保证金已退回。' : '保证金已转抵货款。'}
      close={close}
      submit={async (v) => {
        await depositAction(current, dialog, v);
        done();
      }}
    />
  );
}

export default function DepositPanel({
  current,
  close,
  previous,
  next,
}: {
  current: DepositRow;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  const perms = useFinPerms();
  const [dialog, setDialog] = useState<'refund' | 'apply' | null>(null);
  const voucher = useSourceVoucher(current.voucher_id, close);
  const hasBalance = Number(current.balance) > 0;
  const { actions } = current;
  return (
    <>
      <DetailPanel
        kicker="保证金"
        title={current.party_name}
        subtitle={[depositDirection(current), current.date, yuan(current.amount_cents) + ' 元'].join(' · ')}
        close={close}
        previous={previous}
        next={next}
        actions={
          <ActionBar
            primary={[{ label: '退回', hidden: !(perms.cash && hasBalance), onClick: () => setDialog('refund') }]}
            secondary={[
              { label: '转抵货款', hidden: !(perms.edit && hasBalance), onClick: () => setDialog('apply') },
            ]}
            more={voucher.action ? [voucher.action] : []}
          />
        }
      >
        {current.voucher_state ? (
          <Hint>这笔保证金的凭证{voucherStateNames[current.voucher_state]}，余额按 0 算。</Hint>
        ) : (
          !hasBalance && <Hint>已经退完或抵完，没有余额了。</Hint>
        )}
        <Section title="基本信息">
          <Facts
            items={[
              { label: '方向', value: depositDirection(current) },
              { label: '往来单位', value: current.party_name },
              { label: '日期', value: current.date },
              { label: '金额', value: yuan(current.amount_cents) + ' 元' },
              { label: '余额', value: yuan(current.balance) + ' 元' },
              {
                label: '凭证',
                value: <a href={'#finance-ledger?voucher=' + current.voucher_id}>查看凭证</a>,
                hidden: !current.voucher_id,
              },
              { label: '说明', value: current.description, wide: true },
            ]}
          />
        </Section>
        {actions.length > 0 && <DepositActions actions={actions} done={close} />}
      </DetailPanel>
      {voucher.dialog}
      {dialog && <DepositDialog current={current} dialog={dialog} close={() => setDialog(null)} done={close} />}
    </>
  );
}
