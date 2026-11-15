import { FormMessage } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { EditorShell } from '../editor';
import { FormDialog } from '../FormDialog';
import VoucherEditor from './VoucherEditor';
import { reverseVoucher, voucherStep } from './ledger-api';
import { filled } from '../submit-pick';
import type { VoucherDetail } from './VoucherPanel';

/* 凭证详情里的三个窗口：编辑、作废、红字冲销。详情在 VoucherPanel.tsx。 */

/** 编辑、作废、红字冲销三个窗口 */
export default function VoucherDialogs({
  data,
  dialog,
  close,
}: {
  data: VoucherDetail;
  dialog: 'edit' | 'reverse' | 'void' | null;
  close: () => void;
}) {
  const h = data.header;
  const id = h.id;
  const name = h.period + ' 第 ' + h.number + ' 号';
  return (
    <>
      {dialog === 'edit' && (
        <VoucherEditor voucher={data} close={close} saved={() => {}} />
      )}
      {dialog === 'void' && (
        <EditorShell
          title="作废凭证"
          subtitle={name + ' · ' + h.description}
          size="sm"
          danger
          submitLabel="确认作废"
          close={close}
          submit={async () => {
            await voucherStep({ id, version: h.version }, 'void');
            return name + '已作废。';
          }}
        >
          <FormMessage tone="warning">凭证号保留，只把状态改成已作废，作废后不能恢复。</FormMessage>
          {h.event_id !== null && (
            <FormMessage>
              这张来自业务单据：作废后单据回到“可记账”，往来和已做的收付款核销、发票关联都保留，重新生成凭证时接着用。
            </FormMessage>
          )}
        </EditorShell>
      )}
      {dialog === 'reverse' && (
        <FormDialog
          title="红字冲销"
          subtitle={name + ' · ' + h.description}
          size="sm"
          columns={1}
          intro="生成一张金额相反的新凭证，原凭证保留。"
          submitLabel="生成冲销凭证"
          fields={[
            { name: 'date', label: '冲销日期', type: 'date', required: true },
            { name: 'description', label: '摘要', required: true },
          ]}
          initial={{ date: today(), description: '冲销：' + h.description }}
          notice="已生成红字冲销凭证，记账后生效。"
          close={close}
          submit={(v) =>
            reverseVoucher(
              { id, version: h.version },
              { date: filled(v.date, '冲销日期'), description: filled(v.description, '摘要') },
            )
          }
        />
      )}
    </>
  );
}
