import { useState } from 'react';
import { stepper, col, mon, type Col } from '../../ui/index';
import { noteKind, noteStatusName } from './shared';
import NotePanel, { type NoteRow } from './NotePanel';
import { today } from '../../../shared/core/index';
import { type HeadFn } from '../layout';
import { FinList } from '../table';
import { FormDialog } from '../FormDialog';
import { useFinPerms } from '../fin-api';
import { listNotes, saveNote } from './cash-api';

/** 票据列表的列 */
const noteColumns: Col<NoteRow>[] = [
  col('number', '票号'),
  // 票号可能有 30 位，右侧详情打开时：1440 宽收类型、承兑行、出票日，1280 宽再收往来单位（详情里有）。
  // 出票日可以收：票据要看的是哪天到期、哪天能兑，到期日一直留着；出票日详情里有
  col('kind', '类型', { render: noteKind, priority: 'low' }),
  col('party_name', '往来单位', { wrap: true, priority: 'mid' }),
  col('bank', '承兑行', { priority: 'low' }),
  col('date', '出票日', { priority: 'low' }),
  col('due_date', '到期日'),
  col('status', '状态', { render: (r) => noteStatusName(r.status) }),
  mon('amount_cents', '金额（元）'),
];

/** 新建票据：保存后按到期先后冲这个单位的欠款 */
function NoteDialog({ close }: { close: () => void }) {
  return (
    <FormDialog
      title="新建票据"
      size="md"
      sections={[{ title: '哪张票' }, { title: '金额和日期', columns: 3 }]}
      fields={[
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          required: true,
          section: '哪张票',
          options: [
            ['receivable', '应收票据'],
            ['payable', '应付票据'],
          ],
        },
        {
          name: 'partyId',
          label: '往来单位',
          type: 'party',
          required: true,
          section: '哪张票',
          partyKind: (v) => (v.kind === 'receivable' ? 'customer' : 'supplier'),
        },
        {
          name: 'number',
          label: '票号',
          required: true,
          section: '哪张票',
        },
        {
          name: 'bank',
          label: '承兑行',
          required: true,
          section: '哪张票',
        },
        {
          name: 'date',
          label: '出票日',
          type: 'date',
          required: true,
          section: '金额和日期',
        },
        {
          name: 'dueDate',
          label: '到期日',
          type: 'date',
          required: true,
          section: '金额和日期',
        },
        {
          name: 'amount',
          label: '金额（元）',
          type: 'money',
          required: true,
          section: '金额和日期',
        },
      ]}
      initial={{ kind: 'receivable', date: today() }}
      intro="保存后按到期先后冲这个单位的欠款：应收票据冲应收，应付票据冲应付，冲不完的记预收或预付。"
      submitLabel="保存票据"
      notice="票据已登记。"
      close={close}
      submit={saveNote}
    />
  );
}

/**
 * 承兑票据：新建；点一行看详情，持有中的票据在详情里背书、贴现、到期承兑或退票。
 * 收票冲这个客户的应收、开票和背书冲供应商的应付，按到期先后冲，冲不完的记预收或预付；
 * 以后这个单位有了新欠款，在详情里“核销到欠款”。
 */
export default function NotesTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [dialog, setDialog] = useState(false);
  const [row, setRow] = useState<NoteRow | null>(null);
  const [rows, setRows] = useState<NoteRow[]>([]);
  return (
    <>
      {head({
        primary: perms.cash ? { label: '新建票据', onClick: () => setDialog(true) } : null,
      })}
      <FinList
        list={listNotes}
        query={{}}
        label="承兑票据"
        empty={perms.cash ? '还没有票据，收到或开出承兑汇票时点页面上方的“新建票据”' : '还没有票据'}
        onRow={setRow}
        onData={(d) => setRows(d.rows)}
        selected={row?.id}
        cols={noteColumns}
      />
      {row && (
        <NotePanel
          key={row.id}
          row={row}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {dialog && <NoteDialog close={() => setDialog(false)} />}
    </>
  );
}
