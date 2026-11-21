import { useState } from 'react';
import { FormMessage, DetailPanel, ActionBar, Facts, Section, StatusChip, yuan, notify, useAction } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { useSourceVoucher } from '../source-voucher';
import { FormDialog } from '../FormDialog';
import { useFinPerms, type FinData } from '../fin-api';
import { noteKind, noteStates, noteStatusName } from './shared';
import { allocateNote, changeNoteStatus } from './cash-api';

/* 承兑票据详情：变更状态（背书、贴现、到期承兑、退票）、核销到欠款、收票和变更凭证的撤回。列表在 NotesTab.tsx。 */

/** 票据列表一行：票据加还记在预收、预付里的金额和变更凭证 */
export type NoteRow = FinData<'GET /finance/notes'>['rows'][number];

/** 一行写票号、单位、金额、到期日 */
const noteSummary = (row: NoteRow) =>
  [row.number, row.party_name, yuan(row.amount_cents) + ' 元', '到期 ' + row.due_date].join(' · ');

/** 变更票据状态：背书转让、贴现、到期承兑、退票；成功后关掉详情 */
function NoteStatusDialog({ row, close, done }: { row: NoteRow; close: () => void; done: () => void }) {
  return (
    <FormDialog
      title="变更票据状态"
      subtitle={noteSummary(row)}
      size="md"
      fields={[
        {
          name: 'status',
          label: '变更为',
          type: 'select',
          required: true,
          options: noteStates,
        },
        { name: 'date', label: '日期', type: 'date', required: true },
        {
          name: 'accountId',
          label: '资金账户',
          type: 'cash-account',
          show: (v) => v.status === 'discounted' || v.status === 'matured',
        },
        {
          name: 'proceeds',
          label: '实收 / 元',
          type: 'money',
          hint: '贴现后实际到账的金额',
          show: (v) => v.status === 'discounted',
        },
        {
          name: 'counterPartyId',
          label: '背书给',
          type: 'party',
          partyKind: 'supplier',
          show: (v) => v.status === 'endorsed',
        },
        { name: 'counterAccount', label: '对方科目', type: 'account' },
        { name: 'reason', label: '原因', required: true, wide: true },
      ]}
      initial={{ status: 'matured', date: today() }}
      submitLabel="确认变更"
      notice={'票据 ' + row.number + ' 已变更。'}
      close={close}
      submit={async (v) => {
        await changeNoteStatus(row, v);
        done();
      }}
    />
  );
}

export default function NotePanel({
  row,
  close,
  previous,
  next,
}: {
  row: NoteRow;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  const perms = useFinPerms();
  const voucher = useSourceVoucher(row.voucher_id, close, '收票');
  const change = useSourceVoucher(row.change_voucher_id, close, noteStatusName(row.status));
  const [changing, setChanging] = useState(false);
  const allocate = useAction();
  const unsettled = row.unsettled_cents;
  return (
    <>
      <DetailPanel
        kicker={noteKind(row)}
        title={row.number}
        subtitle={[row.party_name, yuan(row.amount_cents) + ' 元', '到期 ' + row.due_date].join(' · ')}
        status={<StatusChip tone={row.status === 'held' ? 'accent' : 'neutral'}>{noteStatusName(row.status)}</StatusChip>}
        close={close}
        previous={previous}
        next={next}
        actions={
          <ActionBar
            primary={[
              {
                label: '变更状态',
                hidden: !(row.status === 'held' && perms.cash),
                onClick: () => setChanging(true),
              },
            ]}
            secondary={[
              {
                label: '核销到欠款',
                hidden: !(unsettled > 0 && perms.cash && row.status !== 'cancelled'),
                disabled: allocate.busy,
                onClick: () =>
                  void allocate.run(async () => {
                    await allocateNote(row, today() < row.date ? row.date : today());
                    close();
                    notify('票据 ' + row.number + ' 已按到期先后冲到这个单位的欠款上。');
                  }),
              },
            ]}
            more={[change.action, voucher.action].filter((a) => !!a)}
          />
        }
      >
        <FormMessage close={allocate.clear}>{allocate.error}</FormMessage>
        <Section title="基本信息">
          <Facts
            items={[
              { label: '类型', value: noteKind(row) },
              { label: '往来单位', value: row.party_name },
              { label: '票号', value: row.number },
              { label: '承兑行', value: row.bank },
              { label: '出票日', value: row.date },
              { label: '到期日', value: row.due_date },
              { label: '金额', value: yuan(row.amount_cents) + ' 元' },
              { label: '状态', value: noteStatusName(row.status) },
              {
                label: '还没冲到欠款',
                value: yuan(unsettled) + ' 元（先记在预收或预付）',
                hidden: !unsettled,
              },
            ]}
          />
        </Section>
      </DetailPanel>
      {voucher.dialog}
      {change.dialog}
      {changing && <NoteStatusDialog row={row} close={() => setChanging(false)} done={close} />}
    </>
  );
}
