import { useState } from 'react';
import { FormMessage, StatusChip, yuan, stepper, col, mon, type Col } from '../../ui/index';
import { errorMessage } from '../../../shared/core/index';
import { AgingSection, HeldSection } from './BalanceSections';
import CreditTransferDialog from './CreditTransferDialog';
import { obligationSource, partyKindOf, type Kind } from './shared';
import ObligationPanel, { type Dialog } from './ObligationPanel';
import { FinSection, type HeadFn } from '../layout';
import { FinList } from '../table';
import { PartyPicker } from '../fields';
import { RedInk, Status } from '../status';
import { useFinPerms } from '../fin-api';
import { listObligations, previewDueRecalculation, type DuePreview, type ObligationRow } from './parties-api';
import { BadDebtDialog, DueDateDialog, NewObligationDialog, RecalcDialog } from './ObligationDialogs';

/** 单据一栏：冲销那行的日期列是冲销日，小字写明冲的是哪天的原单，不和日期列混 */
const sourceCell = (r: ObligationRow) =>
  r.reversal_state === 'reversal' ? (
    <span className="fin-pair">
      {r.pair_source_number || r.source_number || '手工'}
      <RedInk />
      <small>
        冲的是 {r.pair_date} {Number(r.pair_rerecorded) ? '重记的那笔' : '的原单'}
      </small>
    </span>
  ) : Number(r.rerecorded) || r.reversal_state === 'reversed' || r.tax_status === 'pending' ? (
    // 标签各管各的，可以同时出现，按这个先后：
    // - “重记”：单据改过、红字冲销后按新内容重记的那笔；
    // - “已冲销”：被红字冲销了（多层时重记的那笔又被冲销，“重记”在前，和它在链里的先后一致）；
    // - 待补税率：只有它值得占位置，“已明确”是常态，不单开一列（右侧详情打开时表格窄，少一列金额就看得到）。
    //   重记的那笔照样会缺税率，要标；已冲销的不用再补，不标。
    <span className="fin-pair">
      {obligationSource(r, '手工')}
      {!!Number(r.rerecorded) && <StatusChip tone="neutral">重记</StatusChip>}
      {r.reversal_state === 'reversed' && <StatusChip tone="neutral">已冲销</StatusChip>}
      {r.tax_status === 'pending' && r.reversal_state !== 'reversed' && <Status value="info_pending" />}
    </span>
  ) : (
    // 期初往来、压款利息写叫法（利息带日期和金额），手工新建的写“手工”
    obligationSource(r, '手工')
  );

const obligationCols: Col<ObligationRow>[] = [
  col('date', '日期'),
  col('source_number', '单据', { wrap: true, render: sourceCell }),
  // 右侧详情打开时：1440 宽收到期日，1280 宽再收往来单位（详情标题下写着）
  col('party_name', '往来单位', { wrap: true, priority: 'mid' }),
  col('due_date', '到期日', {
    priority: 'low',
    render: (r) => (r.reversal_state ? '—' : r.due_date || '没有账期'),
  }),
  col('amount_cents', '金额（元）', {
    money: true,
    render: (r) =>
      Number(r.amount_cents) < 0 ? (
        <span className="fin-negative">{yuan(r.amount_cents)}</span>
      ) : (
        yuan(r.amount_cents)
      ),
  }),
  mon('allocated', '已收付'),
  mon('balance', '还欠'),
];

/** 欠款明细：按单位汇总、逐笔明细（右侧详情）、账龄三节。手工新建应收应付、按新账期重算到期日在页头“更多”。 */
export default function ObligationsTab({ kind, head }: { kind: Kind; head: HeadFn }) {
  const perms = useFinPerms();
  const [partyId, setPartyId] = useState('');
  const [row, setRow] = useState<ObligationRow | null>(null);
  const [rows, setRows] = useState<ObligationRow[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [preview, setPreview] = useState<DuePreview | null>(null);
  const [error, setError] = useState('');
  const openRecalc = async () => {
    setError('');
    try {
      setPreview(await previewDueRecalculation(kind, partyId));
      setDialog('recalc');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const label = row
    ? obligationSource(row, '手工记的' + (kind === 'receivable' ? '应收' : '应付'))
    : '';
  const word = kind === 'receivable' ? '应收' : '应付';
  const closeDialog = () => setDialog(null);
  return (
    <>
      {head({
        more: perms.edit
          ? [
              { label: '新建' + word, onClick: () => setDialog('new') },
              {
                label: '按新账期重算到期日',
                disabled: !partyId,
                title: partyId ? undefined : '先在下面选一个单位',
                onClick: () => void openRecalc(),
              },
            ]
          : [],
      })}
      <FormMessage close={() => setError('')}>{error}</FormMessage>
      <HeldSection kind={kind} party={partyId} onParty={setPartyId} />
      <FinSection
        id="items"
        title="逐笔"
        note={partyId ? undefined : '全部单位'}
        extra={
          <PartyPicker kind={partyKindOf(kind)} value={partyId} onChange={setPartyId} allowAll />
        }
      >
        <FinList
          list={listObligations}
          label={word + '逐笔'}
          query={{ kind, partyId: partyId || undefined }}
          onRow={setRow}
          onData={(d) => setRows(d.rows)}
          selected={row?.id}
          empty={kind === 'receivable' ? '没有客户欠款' : '没有欠供应商的货款'}
          cols={obligationCols}
        />
      </FinSection>
      <AgingSection kind={kind} />
      {row && (
        <ObligationPanel
          kind={kind}
          row={row}
          open={setDialog}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {dialog === 'new' && <NewObligationDialog kind={kind} partyId={partyId} close={closeDialog} />}
      {dialog === 'due' && row && (
        <DueDateDialog row={row} label={label} close={closeDialog} done={() => setRow(null)} />
      )}
      {dialog === 'bad' && row && (
        <BadDebtDialog row={row} label={label} close={closeDialog} done={() => setRow(null)} />
      )}
      {dialog === 'credit' && row && (
        <CreditTransferDialog
          kind={kind}
          from={row}
          close={() => setDialog(null)}
          done={() => {
            setDialog(null);
            setRow(null);
          }}
        />
      )}
      {dialog === 'recalc' && preview && (
        <RecalcDialog
          kind={kind}
          partyId={partyId}
          preview={preview}
          reloaded={setPreview}
          close={closeDialog}
        />
      )}
    </>
  );
}
