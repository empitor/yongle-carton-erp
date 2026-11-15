import { DetailPanel, ActionBar, Facts, Hint, Section, type RecordAction, yuan } from '../../ui/index';
import { MoneyProgress, VoucherLinks } from '../detail';
import { useAccountNames } from '../editor';
import { ErrorLine } from '../layout';
import { FinStatusChip, Status } from '../status';
import { useFinPerms, type FinData } from '../fin-api';
import { isPartyKind, kindName, transferPartner } from './shared';

/* 收付款详情：基本信息、核销记录（可撤销）、凭证。窗口由收付款页签开，列表在 DocumentsTab.tsx。 */

export type CashDialog = 'new' | 'edit' | 'confirm' | 'allocate' | 'cancel';
/** 一笔收付款的详情：收付款单、它的核销和凭证 */
export type CashDoc = FinData<'GET /finance/cash/documents/:id'>;
/** 收付款列表一行：加已核销、未核销 */
export type CashListRow = FinData<'GET /finance/cash/documents'>['rows'][number];
/** 一笔核销 */
type AllocationRow = CashDoc['allocations'][number];
/** 要撤销的核销；transfer 是多付转抵（转出、转入两笔一起撤） */
export type RevokeRow = AllocationRow & { transfer: boolean };

/** 核销记录：转出、转入两笔只能一起撤，按钮只放在前一笔上 */
function AllocationsTable({
  allocations,
  canEdit,
  revoke,
}: {
  allocations: readonly AllocationRow[];
  canEdit: boolean;
  revoke: (row: RevokeRow) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>日期</th>
          <th>类型</th>
          <th className="num">金额</th>
          <th className="num">优惠</th>
          <th>状态</th>
          <th aria-label="操作" />
        </tr>
      </thead>
      <tbody>
        {allocations.map((a) => {
          const partner = transferPartner(allocations, a);
          const canRevoke = a.status === 'active' && !a.reversal_of && canEdit && !(partner && partner.id < a.id);
          return (
            <tr key={a.id}>
              <td>{a.date}</td>
              {/* 撤销核销另记的那笔：叫“撤销核销”，不标“有效”（读着像核销还算数），原来那笔标“已撤销” */}
              <td>{a.reversal_of ? '撤销核销' : partner ? '多付转抵' : '核销'}</td>
              <td className="num">{yuan(a.amount_cents)}</td>
              <td className="num">{a.discount_cents ? yuan(a.discount_cents) : '—'}</td>
              <td>{a.reversal_of ? '—' : <Status value={a.status} />}</td>
              <td className="fin-row-actions">
                {canRevoke && (
                  <button type="button" className="fin-row-action" onClick={() => revoke({ ...a, transfer: !!partner })}>
                    {partner ? '撤销转抵' : '撤销'}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 详情的按钮：待确认的确认、编辑；已确认的往来类能核销；已确认的能撤销（会红冲凭证，只进“更多”） */
function cashActions(doc: CashDoc, perms: ReturnType<typeof useFinPerms>, busy: boolean, open: (d: CashDialog) => void) {
  const party = isPartyKind(doc.kind);
  const draft = doc.status === 'draft',
    confirmed = doc.status === 'confirmed';
  const primary: RecordAction[] = [],
    secondary: RecordAction[] = [],
    more: RecordAction[] = [];
  if (draft && perms.cash) {
    primary.push({ label: '确认', disabled: busy, onClick: () => open('confirm') });
    secondary.push({ label: '编辑', onClick: () => open('edit') });
  }
  if (confirmed && party && perms.edit) primary.push({ label: '核销', onClick: () => open('allocate') });
  // 撤销会红冲凭证：危险操作只进“更多”
  if (confirmed && perms.cash) more.push({ label: '撤销', danger: true, onClick: () => open('cancel') });
  return { primary, secondary, more };
}

export default function CashPanel({
  doc,
  listRow,
  accountName,
  busy,
  error,
  clearError,
  close,
  previous,
  next,
  open,
  revoke,
}: {
  doc: CashDoc;
  listRow?: CashListRow;
  accountName: (id: unknown) => string;
  busy: boolean;
  error: string;
  clearError: () => void;
  close: () => void;
  previous: () => void;
  next: () => void;
  open: (d: CashDialog) => void;
  revoke: (row: RevokeRow) => void;
}) {
  const perms = useFinPerms();
  // 对方科目带上名称（“560202 水电费”），不只写编码
  const subjectName = useAccountNames();
  const party = isPartyKind(doc.kind);
  const confirmed = doc.status === 'confirmed';
  const allocations = doc.allocations;
  return (
    <DetailPanel
      kicker={kindName(doc.kind)}
      title={doc.party_name || doc.description}
      status={<FinStatusChip value={doc.status} />}
      subtitle={[doc.date, yuan(doc.amount_cents) + ' 元', doc.method].join(' · ')}
      actions={<ActionBar {...cashActions(doc, perms, busy, open)} />}
      close={close}
      previous={previous}
      next={next}
    >
      <ErrorLine text={error} close={clearError} />
      {doc.status === 'cancelled' && <Hint tone="warning">已撤销，凭证已红冲，实际收支里已去掉。</Hint>}
      {party && confirmed && listRow && (
        <MoneyProgress label="已核销" done={listRow.allocated} total={doc.amount_cents} />
      )}
      <Section title="基本信息">
        <Facts
          items={[
            { label: '往来单位', value: doc.party_name, hidden: !party },
            { label: '金额', value: yuan(doc.amount_cents) + ' 元' },
            { label: '日期', value: doc.date },
            { label: '方式', value: doc.method },
            { label: doc.kind === 'transfer' ? '转出账户' : '资金账户', value: accountName(doc.account_id) },
            { label: '转入账户', value: accountName(doc.target_account_id), hidden: !doc.target_account_id },
            { label: '对方科目', value: subjectName(doc.counter_account), hidden: !doc.counter_account },
            { label: '现金流量项目', value: doc.cash_flow, hidden: !doc.cash_flow },
            { label: '说明', value: doc.description, wide: true },
          ]}
        />
      </Section>
      {allocations.length > 0 && (
        <Section title="核销">
          <AllocationsTable allocations={allocations} canEdit={perms.edit} revoke={revoke} />
        </Section>
      )}
      {doc.vouchers.length > 0 && (
        <Section title="凭证">
          <VoucherLinks vouchers={doc.vouchers} />
        </Section>
      )}
    </DetailPanel>
  );
}
