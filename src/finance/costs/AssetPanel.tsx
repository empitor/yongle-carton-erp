import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, yuan } from '../../ui/index';
import { pageHref, today } from '../../../shared/core/index';
import { useAccountNames } from '../editor';
import { bpText } from '../percent';
import { useSourceVoucher } from '../source-voucher';
import { useFinPerms } from '../fin-api';
import { FinStatusChip } from '../status';
import { FormDialog } from '../FormDialog';
import { changeAsset, disposeAsset, type AssetRow } from './costs-api';

/* 固定资产详情：基本信息，调部门或科目、处置，处置凭证的撤回。列表在 AssetsTab.tsx。 */

function AssetDialog({
  row,
  dialog,
  close,
  done,
}: {
  row: AssetRow;
  dialog: 'change' | 'dispose';
  close: () => void;
  done: () => void;
}) {
  if (dialog === 'change')
    return (
      <FormDialog
        title="调部门或科目"
        subtitle={row.number + ' ' + row.name}
        size="md"
        fields={[
          { name: 'date', label: '生效日期', type: 'date', required: true },
          { name: 'department', label: '部门', required: true },
          {
            name: 'expenseAccount',
            label: '折旧费用科目',
            type: 'account',
            required: true,
            span: 'full',
          },
          { name: 'reason', label: '原因', type: 'textarea', required: true },
        ]}
        initial={{
          date: today(),
          department: row.department,
          expenseAccount: row.expense_account,
        }}
        submitLabel="保存调整"
        notice="资产的部门和折旧科目已调整。"
        close={close}
        submit={async (v) => {
          await changeAsset(row, v);
          done();
        }}
      />
    );
  return (
    <FormDialog
      title="处置固定资产"
      subtitle={row.number + ' ' + row.name}
      size="sm"
      danger
      columns={1}
      note="处置后不能恢复，会生成一张待记账凭证。"
      submitLabel="确认处置"
      fields={[
        { name: 'date', label: '日期', type: 'date', required: true },
        {
          name: 'proceeds',
          label: '处置收入',
          type: 'money',
          hint: '没有收入不用填',
        },
        {
          name: 'accountId',
          label: '资金账户',
          type: 'cash-account',
          hint: '有处置收入时必选',
        },
        { name: 'reason', label: '原因', type: 'textarea', required: true },
      ]}
      initial={{ date: today() }}
      notice={row.name + ' 已处置，凭证待记账。'}
      close={close}
      submit={async (v) => {
        await disposeAsset(row, v);
        done();
      }}
    />
  );
}

export default function AssetPanel({
  row,
  close,
  previous,
  next,
}: {
  row: AssetRow;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  const perms = useFinPerms();
  const accountName = useAccountNames();
  const [dialog, setDialog] = useState<'change' | 'dispose' | null>(null);
  const disposal = useSourceVoucher(row.status === 'disposed' ? row.disposal_voucher_id : null, close, '处置');
  const editable = perms.edit && row.status !== 'disposed';
  return (
    <>
      <DetailPanel
        kicker="固定资产"
        title={row.name}
        subtitle={[row.number, row.category, yuan(row.original_cents) + ' 元'].join(' · ')}
        status={<FinStatusChip value={row.status} />}
        close={close}
        previous={previous}
        next={next}
        actions={
          <ActionBar
            secondary={[{ label: '调部门或科目', hidden: !editable, onClick: () => setDialog('change') }]}
            more={[
              { label: '处置', danger: true, hidden: !editable, onClick: () => setDialog('dispose') },
              ...(disposal.action ? [disposal.action] : []),
            ]}
          />
        }
      >
        {row.status === 'disposed' && <Hint tone="warning">已处置，不再计提折旧。</Hint>}
        <Section title="基本信息">
          <Facts
            items={[
              { label: '编号', value: row.number },
              { label: '类别', value: row.category },
              { label: '使用部门', value: row.department },
              { label: '入账日期', value: row.date },
              { label: '原值', value: yuan(row.original_cents) + ' 元' },
              { label: '残值率', value: bpText(row.residual_bp) + '%' },
              { label: '使用月数', value: row.months + ' 个月' },
              {
                label: '折旧费用科目',
                value: accountName(row.expense_account),
              },
              {
                label: '入账凭证',
                value: <a href={pageHref('finance-ledger', { voucher: row.voucher_id ?? undefined })}>查看凭证</a>,
                hidden: !row.voucher_id,
              },
            ]}
          />
        </Section>
      </DetailPanel>
      {disposal.dialog}
      {dialog && <AssetDialog row={row} dialog={dialog} close={() => setDialog(null)} done={close} />}
    </>
  );
}
