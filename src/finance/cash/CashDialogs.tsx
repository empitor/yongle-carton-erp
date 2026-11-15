import { yuan } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { FormDialog } from '../FormDialog';
import { cashFields, kindName } from './shared';
import { cancelCashDocument, revokeAllocation, saveCashDocument } from './cash-api';
import AllocateDialog from './AllocateDialog';
import type { CashDialog, CashDoc, RevokeRow } from './CashPanel';

/* 收付款页签的几个窗口：新建或编辑收付款、撤销收付款、撤销核销（或转抵）。确认和核销在 AllocateDialog.tsx。 */

/** 新建（不给 doc）或编辑一笔待确认的收付款；保存后打开它的详情 */
function CashForm({
  doc,
  defaultAccount,
  close,
  saved,
}: {
  doc?: CashDoc;
  defaultAccount?: number;
  close: () => void;
  saved: (id: number) => void;
}) {
  return (
    <FormDialog
      title={doc ? '编辑收付款' : '新建收付款'}
      subtitle={doc ? kindName(doc.kind) + ' · ' + doc.date : undefined}
      note="保存后待确认，确认才入账。"
      size="md"
      fields={cashFields}
      initial={
        doc
          ? {
              kind: doc.kind,
              date: doc.date,
              accountId: doc.account_id,
              targetAccountId: doc.target_account_id,
              partyId: doc.party_id,
              amount: doc.amount_cents,
              method: doc.method,
              counterAccount: doc.counter_account,
              cashFlow: doc.cash_flow,
              description: doc.description,
            }
          : { kind: 'receipt', date: today(), method: '银行', accountId: defaultAccount }
      }
      submitLabel="保存收付款"
      notice={doc ? '收付款已保存。' : '收付款已保存，待确认，确认后才入账。'}
      close={close}
      submit={async (v) => saved((await saveCashDocument(v, doc)).id)}
    />
  );
}

function CancelCashDialog({ doc, close }: { doc: CashDoc; close: () => void }) {
  return (
    <FormDialog
      title="撤销这笔收付款"
      subtitle={[kindName(doc.kind), doc.party_name || doc.description, yuan(doc.amount_cents) + ' 元']
        .filter(Boolean)
        .join(' · ')}
      intro="已记账的凭证会红冲，实际收支同步去掉。有核销的要先撤销核销。"
      danger
      size="sm"
      submitLabel="确认撤销"
      fields={[
        { name: 'date', label: '撤销日期', type: 'date', required: true },
        { name: 'reason', label: '原因', required: true, wide: true, placeholder: '例如：金额录错' },
      ]}
      initial={{ date: today() }}
      notice="这笔收付款已撤销。"
      close={close}
      submit={(v) => cancelCashDocument(doc, v)}
    />
  );
}

/** 撤销一笔核销；多付转抵的转出、转入两笔一起撤（row.transfer） */
export function RevokeAllocationDialog({ row, close }: { row: RevokeRow; close: () => void }) {
  return (
    <FormDialog
      title={row.transfer ? '撤销转抵' : '撤销核销'}
      subtitle={(row.transfer ? '多付转抵 ' : '核销 ') + yuan(row.amount_cents) + ' 元 · ' + row.date}
      intro={row.transfer ? '转出和转入两笔一起撤销，多付的钱回到原来那笔往来上。' : '那张单子的欠款会恢复。'}
      note="已结账月份保留原记录，另生成反向核销。"
      danger
      size="sm"
      submitLabel="确认撤销"
      fields={[
        { name: 'date', label: '撤销日期', type: 'date', required: true },
        { name: 'reason', label: '原因', required: true, wide: true },
      ]}
      initial={{ date: today() }}
      notice={row.transfer ? '转抵已撤销。' : '核销已撤销。'}
      close={close}
      submit={(v) => revokeAllocation(row, v)}
    />
  );
}

/** 收付款页签当前开着的窗口；确认（往来类）和核销走 AllocateDialog，编辑、确认、核销、撤销都要先读到这笔收付款 */
export function CashDocDialogs({
  dialog,
  doc,
  defaultAccount,
  close,
  saved,
}: {
  dialog: CashDialog;
  doc: CashDoc | null;
  defaultAccount?: number;
  close: () => void;
  saved: (id: number) => void;
}) {
  if (dialog === 'new') return <CashForm defaultAccount={defaultAccount} close={close} saved={saved} />;
  if (!doc) return null;
  if (dialog === 'edit') return <CashForm doc={doc} close={close} saved={saved} />;
  if (dialog === 'cancel') return <CancelCashDialog doc={doc} close={close} />;
  return <AllocateDialog doc={doc} mode={dialog} close={close} />;
}
