import { yuan } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { FormDialog } from '../FormDialog';
import { partyKindOf, type Kind } from './shared';
import {
  applyDueRecalculation,
  changeDueDate,
  createObligation,
  writeOffBadDebt,
  type DuePreview,
  type ObligationRow,
} from './parties-api';

/* 欠款明细的窗口：手工新建应收应付、编辑到期日、坏账处理、按新账期重算到期日。多付转抵在 CreditTransferDialog.tsx。 */

export function NewObligationDialog({
  kind,
  partyId,
  close,
}: {
  kind: Kind;
  partyId: string;
  close: () => void;
}) {
  return (
    <FormDialog
      title={kind === 'receivable' ? '新建应收' : '新建应付'}
      size="md"
      note="用于没有送货单、到货单的往来。保存后生成待记账凭证。"
      sections={[{ title: '哪一笔' }, { title: '怎么记账' }]}
      fields={[
        {
          name: 'partyId',
          label: '往来单位',
          type: 'party',
          required: true,
          partyKind: partyKindOf(kind),
          section: '哪一笔',
        },
        {
          name: 'amount',
          label: '金额（元）',
          type: 'money',
          required: true,
          section: '哪一笔',
        },
        { name: 'date', label: '日期', type: 'date', required: true, section: '哪一笔' },
        {
          name: 'dueDate',
          label: '到期日',
          type: 'date',
          hint: '不填就没有到期日',
          section: '哪一笔',
        },
        {
          name: 'counterAccount',
          label: '对方科目',
          type: 'account',
          required: true,
          section: '怎么记账',
        },
        { name: 'description', label: '摘要', required: true, section: '怎么记账' },
      ]}
      initial={{ date: today(), partyId }}
      notice={(kind === 'receivable' ? '应收' : '应付') + '已新建，生成了待记账凭证。'}
      close={close}
      submit={(v) => createObligation(kind, v)}
    />
  );
}

/** label：这一笔的叫法（单据号或“手工记的应收”）；done：办完关掉详情 */
type RowDialogProps = { row: ObligationRow; label: string; close: () => void; done: () => void };

export function DueDateDialog(props: RowDialogProps) {
  const { row, label, close, done } = props;
  return (
    <FormDialog
      title="编辑到期日"
      subtitle={label + ' · 现在' + (row.due_date ? '到期日 ' + row.due_date : '没有账期')}
      size="sm"
      note="改动留审计记录。"
      fields={[
        { name: 'dueDate', label: '到期日', type: 'date', required: true },
        { name: 'reason', label: '原因', required: true, wide: true },
      ]}
      initial={{ dueDate: row.due_date }}
      notice="到期日已修改。"
      close={close}
      submit={async (v) => {
        await changeDueDate(row, v);
        done();
      }}
    />
  );
}

export function BadDebtDialog(props: RowDialogProps) {
  const { row, label, close, done } = props;
  return (
    <FormDialog
      title="坏账处理"
      subtitle={[label, row.party_name, '余额 ' + yuan(row.balance) + ' 元'].join(' · ')}
      size="md"
      danger
      submitLabel="确认处理"
      fields={[
        {
          name: 'kind',
          label: '方式',
          type: 'select',
          required: true,
          options: [
            ['writeoff', '直接核销'],
            ['provision', '计提准备'],
          ],
        },
        { name: 'date', label: '日期', type: 'date', required: true },
        { name: 'amount', label: '金额（元）', type: 'money', required: true },
        {
          name: 'counterAccount',
          label: '备抵科目',
          type: 'account',
          required: true,
          show: (v) => v.kind === 'provision',
        },
        { name: 'reason', label: '原因', required: true, wide: true },
      ]}
      initial={{ kind: 'writeoff', date: today(), amount: row.balance }}
      notice="坏账已处理。"
      close={close}
      submit={async (v) => {
        await writeOffBadDebt(row, v);
        done();
      }}
    />
  );
}

/** preview：服务端算好的会改哪些（带 digest，确认时带回去）；预览以后数据变了时 reloaded 收到最新的预览 */
export function RecalcDialog({
  kind,
  partyId,
  preview,
  reloaded,
  close,
}: {
  kind: Kind;
  partyId: string;
  preview: DuePreview;
  reloaded: (next: DuePreview) => void;
  close: () => void;
}) {
  return (
    <FormDialog
      title="按新账期重算到期日"
      size="md"
      intro={
        preview.rows.length + preview.installments.length
          ? '会改 ' +
            preview.rows.length +
            ' 张单据、' +
            preview.installments.length +
            ' 个分期的到期日。已收付的部分不变。'
          : '当前账期算出来的到期日和现有的一样，不需要重算。'
      }
      leading={
        preview.rows.length > 0 && (
          <div className="fin-ed-preview" role="region" aria-label="重算预览">
            <table>
              <thead>
                <tr>
                  <th>原到期日</th>
                  <th>新到期日</th>
                  <th className="num">余额 / 元</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.before || '没有'}</td>
                    <td>{r.dueDate || '没有'}</td>
                    <td className="num">{yuan(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      sections={[{ title: '为什么重算', columns: 1 }]}
      fields={[
        { name: 'reason', label: '原因', required: true, wide: true, section: '为什么重算' },
      ]}
      submitLabel="确认重算"
      notice="到期日已按新账期重算。"
      close={close}
      submit={(v) =>
        applyDueRecalculation(
          { kind, partyId, digest: preview.digest, reason: String(v.reason) },
          reloaded,
        )
      }
    />
  );
}
