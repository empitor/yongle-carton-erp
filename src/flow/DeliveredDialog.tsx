import { useState } from 'react';
import { EditorFooter, FormField, FormMessage, FormSection, ManagementDialog, useAction } from '../ui/index';
import type { FlowDocView } from '../../shared/business/index';
import { today } from '../../shared/core/index';
import { markDelivered } from './flow-api';
import { shipDate } from './flow-dates';

/**
 * 确认送达：日期预填今天（北京时间），客户哪天签收就改成哪天，不早于出库日、不晚于今天。
 * 只记送达，不动库存（出库在导出送货单或核对出库时已经做了）。办完关窗，由调用方提示结果。
 */
export default function DeliveredDialog({
  doc,
  close,
  done,
}: {
  /** 已出库的送货单：打开时的版本、单号、客户、出库时间 */
  doc: Pick<FlowDocView<'delivery'>, 'id' | 'version' | 'number' | 'customerName' | 'shippedAt'>;
  close: () => void;
  /** 确认送达后的送货单 */
  done: (after: FlowDocView<'delivery'>) => void;
}) {
  // 出库日和详情里的“实际发货”同一个来源：导出送货单出库的那天
  const now = today(),
    shipped = shipDate({ shippedAt: doc.shippedAt, kind: 'delivery' });
  const [date, setDate] = useState(now);
  const { busy, error, run } = useAction();
  const problem = !date
    ? '请选送达日期。'
    : date > now
      ? '送达日期不能晚于今天。'
      : shipped && date < shipped
        ? '送达日期不能早于出库日期 ' + shipped + '。'
        : '';
  const submit = () => run(async () => done(await markDelivered(doc.id, { version: doc.version, date })));
  return (
    <ManagementDialog
      title={'确认送达 · ' + doc.number}
      subtitle={[doc.customerName, shipped && shipped + ' 出库'].filter(Boolean).join(' · ')}
      size="sm"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="只记送达，不动库存。">
          <button type="button" className="secondary" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !!problem} onClick={() => void submit()}>
            {busy ? '正在确认…' : '确认送达'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error || problem}</FormMessage>
      <FormSection>
        <FormField label="送达日期" required hint="客户哪天签收就选哪天">
          <input
            type="date"
            aria-label="送达日期"
            value={date}
            min={shipped || undefined}
            max={now}
            onChange={(e) => setDate(e.currentTarget.value)}
          />
        </FormField>
      </FormSection>
    </ManagementDialog>
  );
}
