import { useRef, useState } from 'react';
import { today } from '../../shared/core/index';
import { EditorFooter, FormField, FormMessage, FormSection, ManagementDialog, useAction, useLoad } from '../ui/index';
import { readReturnable, saveReturn } from './flow-api';

/** 采购退货：对已确认的到货单按明细退回。扣库存、冲减采购已到货；金额以到票或供应商红票为准。 */
export function PurchaseReturnDialog({
  arrival,
  close,
  done,
}: {
  arrival: { id: number; number: string };
  close: () => void;
  done: () => void;
}) {
  const loaded = useLoad(String(arrival.id), () => readReturnable(arrival.id));
  const lines = loaded.loading ? null : loaded.data;
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  // 请求凭据跟着内容走：同一内容重试（比如网络断了）用同一个，改了数量、日期或原因就换新的。
  const request = useRef<{ key: string; id: string } | null>(null);
  const chosen = Object.entries(quantities)
    .filter(([, q]) => q.trim() && Number(q) > 0)
    .map(([index, quantity]) => ({ lineIndex: Number(index), quantity: quantity.trim() }));
  const submit = () =>
    run(async () => {
      if (!chosen.length) throw new Error('请至少填一行退货数量。');
      if (!reason.trim()) throw new Error('请填写退货原因。');
      const payload = { arrivalId: arrival.id, date, reason: reason.trim(), lines: chosen };
      const key = JSON.stringify(payload);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      await saveReturn({ ...payload, requestId: request.current.id });
      done();
    });
  return (
    <ManagementDialog
      title="采购退货"
      subtitle={'到货单 ' + arrival.number}
      size="md"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="退货扣库存和采购已到货；金额按到票或供应商红字发票处理。">
          <button type="button" className="secondary" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy || !lines}>
            {busy ? '正在退货…' : '确认退货'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error || loaded.error}</FormMessage>
      <FormSection title="退哪些纸板" hint="只填要退的行，最多退到已入库减已退。" columns={1}>
        {!lines ? (
          <p className="wh-muted" role="status">
            {loaded.error ? '到货明细读取失败。' : '正在读取到货明细…'}
          </p>
        ) : (
          <div className="line-table wh-no-action">
            <table>
              <thead>
                <tr>
                  <th>纸板</th>
                  <th className="num">已入库</th>
                  <th className="num">已退</th>
                  <th className="num">本次退货</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const open = Number(l.returnable) > 0;
                  return (
                    <tr key={l.lineIndex}>
                      <td className="wh-cell-text">
                        {l.name}
                        {l.hint && <small>{l.hint}</small>}
                      </td>
                      <td className="num wh-cell-text">
                        {l.stocked == null ? '待核对' : l.stocked + ' ' + l.unit}
                      </td>
                      <td className="num wh-cell-text">
                        {l.returned} {l.unit}
                      </td>
                      <td className="num">
                        <div className="wh-qty">
                          <input
                            aria-label={'本次退货数量 ' + l.name}
                            inputMode="numeric"
                            disabled={!open}
                            placeholder={open ? '最多 ' + l.returnable : l.hint || '不可退'}
                            value={quantities[l.lineIndex] || ''}
                            onChange={(e) =>
                              setQuantities({ ...quantities, [l.lineIndex]: e.target.value })
                            }
                          />
                          <span>{l.unit}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </FormSection>
      <FormSection title="哪天退、为什么退" columns={3}>
        <FormField label="退货日期" required>
          <input
            type="date"
            aria-label="退货日期"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </FormField>
        <FormField label="退货原因" required span={2}>
          <input
            aria-label="退货原因"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：受潮、尺寸不对"
          />
        </FormField>
      </FormSection>
    </ManagementDialog>
  );
}
