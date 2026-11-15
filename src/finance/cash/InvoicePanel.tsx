import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, StatusChip, type RecordAction, yuan, notify, useAction } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { ErrorLine } from '../layout';
import { FormDialog } from '../FormDialog';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { invoiceStateName, invoiceStateTone } from './shared';
import {
  changeInvoiceStatus,
  confirmInvoice,
  invoiceAttachmentHref,
  saveInvoiceLinks,
} from './cash-api';

/* 发票详情：基本信息、票面金额、关联单据，和关联单据、确认红字发票、变更状态三个窗口。列表在 InvoicesTab.tsx。 */

type InvoiceDialog = 'link' | 'status' | 'red';
/** 发票详情：发票一行和它关联的往来 */
type InvoiceDetail = FinData<'GET /finance/invoices/:id'>;
type Invoice = InvoiceDetail['invoice'];
type LinkRow = InvoiceDetail['links'][number];

function LinkedDocs({ links }: { links: readonly LinkRow[] }) {
  return (
    <Section title="关联单据">
      {links.length ? (
        <table>
          <thead>
            <tr>
              <th>单据</th>
              <th className="num">单据金额</th>
              <th className="num">本票金额</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.obligation_id}>
                <td>
                  {l.source_number || '手工记的一笔'}
                  <small>单据日 {l.date}</small>
                </td>
                <td className="num">{yuan(l.obligation_amount)}</td>
                <td className="num">{yuan(l.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="fin-note">还没有关联。</p>
      )}
    </Section>
  );
}

/** 关联单据时把已有的关联原样带上，再加这一条。 */
const keptLinks = (links: readonly LinkRow[]) =>
  links.map((l) => ({
    obligationId: l.obligation_id,
    amount: l.amount_cents,
    estimateAmount: l.estimate_cents ?? undefined,
    // 数量和单位要么一起带上，要么都不带，否则后端会拒绝
    ...(l.quantity != null && l.unit ? { quantity: l.quantity, unit: l.unit } : {}),
  }));

/** 关联单据：选这个单位未结清的往来单，填本票金额、对应暂估、数量 */
function LinkDialog({ inv, links, close }: { inv: Invoice; links: readonly LinkRow[]; close: () => void }) {
  return (
    <FormDialog
      title="关联单据"
      subtitle={inv.number + ' · ' + inv.party_name + ' · ' + yuan(inv.gross) + ' 元'}
      size="md"
      note="部分到票时填对应的暂估金额。"
      sections={[{ title: '对应哪张单子' }, { title: '金额' }, { title: '数量', hint: '选填，数量和单位要一起填。' }]}
      fields={[
        {
          name: 'obligationId',
          label: '对应的单据',
          type: 'obligation',
          required: true,
          wide: true,
          section: '对应哪张单子',
          obligation: {
            kind: inv.direction === 'sale' ? 'receivable' : 'payable',
            partyId: inv.party_id,
          },
        },
        { name: 'amount', label: '本票金额 / 元', type: 'money', required: true, section: '金额' },
        { name: 'estimateAmount', label: '对应暂估 / 元', type: 'money', section: '金额' },
        { name: 'quantity', label: '数量', section: '数量' },
        { name: 'unit', label: '单位', section: '数量' },
      ]}
      initial={{ amount: inv.gross }}
      notice="已关联单据。"
      close={close}
      submit={(v) => saveInvoiceLinks(inv, [...keptLinks(links), v])}
    />
  );
}

/** 确认红字发票：部分红冲且原票已生成凭证时要填对方科目 */
function RedConfirmDialog({ inv, close }: { inv: Invoice; close: () => void }) {
  return (
    <FormDialog
      title="确认红字发票"
      subtitle={inv.number + ' · ' + yuan(inv.gross) + ' 元'}
      size="sm"
      submitLabel="确认"
      fields={[
        {
          name: 'counterAccount',
          label: '对方科目',
          type: 'account',
          wide: true,
          hint: '部分红冲且原票已生成凭证时必填',
        },
      ]}
      notice={'红字发票 ' + inv.number + ' 已确认。'}
      close={close}
      submit={(v) => confirmInvoice(inv, v.counterAccount === undefined ? undefined : String(v.counterAccount))}
    />
  );
}

/** 变更发票状态：认证、不可抵扣（进项转出）、作废 */
function StatusDialog({ inv, close }: { inv: Invoice; close: () => void }) {
  return (
    <FormDialog
      title="变更发票状态"
      subtitle={inv.number + ' · ' + invoiceStateName(inv.status)}
      size="md"
      fields={[
        {
          name: 'status',
          label: '变更为',
          type: 'select',
          required: true,
          options: [
            ['certified', '已认证'],
            ['nondeductible', '不可抵扣（进项转出）'],
            ['void', '作废'],
          ],
        },
        { name: 'date', label: '日期', type: 'date', required: true },
        {
          name: 'counterAccount',
          label: '转出科目',
          type: 'account',
          show: (v) => v.status === 'nondeductible',
        },
        { name: 'reason', label: '原因', required: true, wide: true },
      ]}
      initial={{ status: 'certified', date: today() }}
      notice="发票状态已变更。"
      close={close}
      submit={(v) => changeInvoiceStatus(inv, v)}
    />
  );
}

function InvoiceDialogs({
  inv,
  links,
  dialog,
  close,
}: {
  inv: Invoice;
  links: readonly LinkRow[];
  dialog: InvoiceDialog;
  close: () => void;
}) {
  if (dialog === 'link') return <LinkDialog inv={inv} links={links} close={close} />;
  if (dialog === 'red') return <RedConfirmDialog inv={inv} close={close} />;
  return <StatusDialog inv={inv} close={close} />;
}

/** 详情的按钮：草稿先关联单据再确认（红字发票不用关联），有原件能看，没作废的能变更状态。 */
function invoiceActions(a: {
  inv: Invoice;
  red: boolean;
  needsLink: boolean;
  perms: ReturnType<typeof useFinPerms>;
  busy: boolean;
  open: (d: InvoiceDialog) => void;
  confirm: () => void;
}) {
  const { inv, red, needsLink, perms, open } = a;
  const draft = inv.status === 'draft';
  const primary: RecordAction[] = [],
    secondary: RecordAction[] = [],
    more: RecordAction[] = [];
  if (perms.edit && draft && needsLink) primary.push({ label: '关联单据', onClick: () => open('link') });
  if (perms.edit && draft && !needsLink) {
    primary.push({ label: '确认', disabled: a.busy, onClick: () => (red ? open('red') : a.confirm()) });
    if (!red) secondary.push({ label: '关联单据', onClick: () => open('link') });
  }
  if (inv.attachment_id)
    secondary.push({ label: '查看原件', href: invoiceAttachmentHref(inv.attachment_id), external: true });
  if (perms.edit && inv.status !== 'void')
    (draft ? more : secondary).push({ label: '变更状态', onClick: () => open('status') });
  return { primary, secondary, more };
}

export default function InvoicePanel({
  id,
  close,
  previous,
  next,
}: {
  id: number;
  close: () => void;
  previous: () => void;
  next: () => void;
}) {
  const perms = useFinPerms();
  const { data } = useFinRead(['GET /finance/invoices/:id', { params: { id } }]);
  const action = useAction();
  const [dialog, setDialog] = useState<InvoiceDialog | null>(null);
  if (!data) return null;
  const inv = data.invoice;
  const draft = inv.status === 'draft';
  // 红字发票冲的是原蓝票，不关联往来单，也就不能拿“没关联”挡确认。
  const red = inv.gross < 0;
  const needsLink = draft && !red && !data.links.length;
  const actions = invoiceActions({
    inv,
    red,
    needsLink,
    perms,
    busy: action.busy,
    open: setDialog,
    confirm: () =>
      void action.run(async () => {
        await confirmInvoice(inv);
        notify('发票 ' + inv.number + ' 已确认。');
      }),
  });
  return (
    <DetailPanel
      kicker={inv.direction === 'sale' ? '销项发票' : '进项发票'}
      title={inv.number}
      status={<StatusChip tone={invoiceStateTone(inv.status)}>{invoiceStateName(inv.status)}</StatusChip>}
      subtitle={[inv.party_name, '价税合计 ' + yuan(inv.gross) + ' 元'].join(' · ')}
      actions={<ActionBar {...actions} />}
      close={close}
      previous={previous}
      next={next}
    >
      <ErrorLine text={action.error} close={action.clear} />
      {needsLink && perms.edit && <Hint>确认前要先关联这张发票对应的送货单或到货单。</Hint>}
      {red && draft && <Hint>红字发票冲的是原蓝票，不用关联单据。</Hint>}
      <Section title="基本信息">
        <Facts
          items={[
            { label: '往来单位', value: inv.party_name },
            { label: '税号', value: inv.tax_id },
            { label: '发票类型', value: inv.type },
            { label: '开票日期', value: inv.date },
          ]}
        />
      </Section>
      <Section title="票面金额">
        <Facts
          items={[
            { label: '不含税', value: yuan(inv.net) + ' 元' },
            { label: '税率', value: inv.rate + '%' },
            { label: '税额', value: yuan(inv.tax) + ' 元' },
            { label: '价税合计', value: yuan(inv.gross) + ' 元' },
          ]}
        />
      </Section>
      {(data.links.length > 0 || !red) && <LinkedDocs links={data.links} />}
      {dialog && <InvoiceDialogs inv={inv} links={data.links} dialog={dialog} close={() => setDialog(null)} />}
    </DetailPanel>
  );
}
