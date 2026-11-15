import { useState } from 'react';
import { Plus } from 'lucide-react';
import { FormSection, toCents, yuan, FormField } from '../../ui/index';
import { EditorShell } from '../editor';
import { today } from '../../../shared/core/index';
import { useAccounts } from '../fin-api';
import { saveVoucher } from './ledger-api';
import type { VoucherDetail } from './VoucherPanel';
import { UnitInput } from '../fields';
import { EntryRow, accountsInfo, auxLabels, type Line } from './VoucherEntryRow';

const blank = (): Line => ({
  accountCode: '',
  description: '',
  debit: '',
  credit: '',
  cashFlow: '',
  auxId: '',
  auxName: '',
});

/** 编辑时带出原来的分录，新建给两行空的 */
const linesOf = (voucher?: VoucherDetail): Line[] =>
  voucher
    ? voucher.entries.map((e) => ({
        accountCode: e.account_code,
        description: e.description,
        debit: e.debit ? yuan(e.debit).replace(/,/g, '') : '',
        credit: e.credit ? yuan(e.credit).replace(/,/g, '') : '',
        cashFlow: e.cash_flow || '',
        auxId: e.auxiliary_id ?? '',
        auxName: e.auxiliary_name || '',
      }))
    : [blank(), blank()];

/** 新建或修改手工凭证：上面日期和摘要，下面一行一条分录，底部随时显示借贷是否平衡。 */
export default function VoucherEditor({
  voucher,
  close,
  saved,
}: {
  voucher?: VoucherDetail;
  close: () => void;
  saved: (id: number) => void;
}) {
  const accountInfo = accountsInfo(useAccounts());
  const { auxKinds } = accountInfo;
  const [date, setDate] = useState(voucher?.header.date || today());
  const [description, setDescription] = useState(voucher?.header.description || '');
  const [attachmentCount, setAttachmentCount] = useState(
    String(voucher?.header.attachment_count ?? 0),
  );
  const [lines, setLines] = useState<Line[]>(() => linesOf(voucher));
  const update = (i: number, patch: Partial<Line>) =>
    setLines((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const remove = (i: number) => setLines((all) => all.filter((_, j) => j !== i));
  const total = (key: 'debit' | 'credit') =>
    lines.reduce((n, l) => {
      try {
        return n + (l[key].trim() ? toCents(l[key]) : 0);
      } catch {
        return n;
      }
    }, 0);
  const debit = total('debit'),
    credit = total('credit');
  const balanced = debit === credit && debit > 0;
  const submit = async () => {
    const entries = lines.map((l, i) => {
      const kind = auxKinds.get(l.accountCode);
      if (kind && !l.auxName.trim())
        throw new Error('第 ' + (i + 1) + ' 行的科目要填' + auxLabels[kind] + '。');
      return {
        accountCode: l.accountCode,
        description: l.description,
        debit: l.debit.trim() ? toCents(l.debit) : 0,
        credit: l.credit.trim() ? toCents(l.credit) : 0,
        auxiliary: kind ? { kind, id: l.auxId, name: l.auxName.trim() } : null,
        cashFlow: l.cashFlow || null,
      };
    });
    const body = { date, description, attachmentCount: Number(attachmentCount) || 0, entries };
    const result = await saveVoucher(body, voucher?.header);
    saved(result.header.id);
    return voucher ? '凭证已修改。' : '凭证已保存，第 ' + result.header.number + ' 号，待提交审核。';
  };
  return (
    <EditorShell
      title={voucher ? '编辑凭证' : '新建凭证'}
      subtitle={
        voucher ? voucher.header.period + ' 第 ' + voucher.header.number + ' 号' : undefined
      }
      size="xl"
      submitLabel="保存凭证"
      disabled={!balanced || !description.trim() || lines.some((l) => !l.accountCode)}
      note={
        balanced
          ? '保存后待提交审核，审核、记账后才生效。'
          : '摘要、每行科目填好，借贷平衡后才能保存。'
      }
      close={close}
      submit={submit}
    >
      <FormSection title="日期和摘要" columns={4}>
        <FormField label="日期" required>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField label="附件张数">
          <UnitInput
            unit="张"
            type="number"
            min={0}
            value={attachmentCount}
            onChange={(e) => setAttachmentCount(e.target.value)}
          />
        </FormField>
        <FormField label="摘要" required span={2}>
          <input required value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </FormSection>
      <FormSection
        title="分录"
        columns={1}
        extra={
          <button
            type="button"
            className="secondary"
            onClick={() => setLines((all) => [...all, blank()])}
          >
            <Plus size={14} aria-hidden="true" />
            加一行
          </button>
        }
      >
        <div className="line-table fb-entries">
          <table>
            <thead>
              <tr>
                <th className="fb-col-account">科目</th>
                <th>辅助项</th>
                <th>摘要</th>
                <th className="num">借方 / 元</th>
                <th className="num">贷方 / 元</th>
                <th>现金流量</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <EntryRow
                  key={i}
                  line={l}
                  index={i}
                  accounts={accountInfo}
                  update={(patch) => update(i, patch)}
                  remove={lines.length > 2 ? () => remove(i) : undefined}
                />
              ))}
            </tbody>
            <tfoot>
              <tr className="fb-total">
                <td colSpan={3}>合计</td>
                <td className="num">{yuan(debit)}</td>
                <td className="num">{yuan(credit)}</td>
                <td colSpan={2} className={balanced ? 'fb-ok' : 'fin-negative'}>
                  {balanced
                    ? '借贷平衡'
                    : debit === credit
                      ? '还没填金额'
                      : '差 ' + yuan(Math.abs(debit - credit))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </FormSection>
    </EditorShell>
  );
}
