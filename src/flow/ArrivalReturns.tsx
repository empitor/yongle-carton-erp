import { useEffect, useRef, useState } from 'react';
import {
  EditorFooter,
  FormField,
  FormMessage,
  FormSection,
  Hint,
  ManagementDialog,
  StatusChip,
  notify,
  useAction,
  useLoad,
} from '../ui/index';
import { readReturns, reverseReturn } from './flow-api';

/** 一张退货单（到货单下的退货记录） */
type ReturnRow = Awaited<ReturnType<typeof readReturns>>[number];

/** 到货单下的退货记录；有编辑权限并进入超级管理员模式后可以撤销退货（库存加回来）。 */
export function ArrivalReturns({
  arrivalId,
  canEdit,
  superMode,
  revision,
  changed,
}: {
  arrivalId: number;
  canEdit: boolean;
  superMode: boolean;
  revision: number;
  changed: () => void;
}) {
  // 读到的记录带着是哪张到货单的：换了一张，上一张的记录不再显示，不能对着上一张的退货操作
  const loaded = useLoad(
    String(arrivalId),
    () => readReturns(arrivalId).then((list) => ({ arrivalId, list })),
    revision,
  );
  const rows = loaded.data?.arrivalId === arrivalId ? loaded.data.list : [];
  const [reversing, setReversing] = useState<ReturnRow | null>(null);
  const [reason, setReason] = useState('');
  const { busy, error, run, clear } = useAction();
  // 换了一张到货单：关掉撤销窗、清掉原因和没办成的原因（清原因的函数每次渲染是新的，放进 ref，只按到货单换没换来跑）
  const clearError = useRef(clear);
  useEffect(() => {
    clearError.current = clear;
  });
  useEffect(() => {
    setReversing(null);
    setReason('');
    clearError.current();
  }, [arrivalId]);
  if (loaded.error)
    return (
      <section className="record-section flow-returns">
        <header>
          <h3>采购退货</h3>
        </header>
        <Hint tone="danger">退货记录读取失败：{loaded.error}</Hint>
      </section>
    );
  if (!rows.length) return null;
  const reverse = () =>
    run(async () => {
      const target = reversing;
      if (!target || target.arrivalId !== arrivalId) return setReversing(null);
      await reverseReturn(target.id, { version: target.version, reason: reason.trim() });
      setReversing(null);
      setReason('');
      notify('已撤销退货 ' + target.number + '，退回的数量已加回库存。');
      changed();
    });
  return (
    <section className="record-section flow-returns">
      <header>
        <h3>采购退货</h3>
      </header>
      <div className="table-wrap">
        <table className="wh-linked">
          <thead>
            <tr>
              <th>退货单</th>
              <th>退回</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.number}
                  <small>{r.date}</small>
                </td>
                <td>
                  {r.lines.map((l) => l.name + ' ' + l.quantity + ' ' + l.unit).join('；')}
                  {r.reason && <small>{r.reason}</small>}
                </td>
                <td>
                  <div className="wh-return-state">
                    {r.status === 'reversed' ? (
                      <StatusChip tone="danger">已撤销</StatusChip>
                    ) : (
                      <StatusChip tone="success">已退货</StatusChip>
                    )}
                    {r.status !== 'reversed' && canEdit && superMode && (
                      <button
                        type="button"
                        className="wh-link danger-text"
                        onClick={() => {
                          clear();
                          setReason('');
                          setReversing(r);
                        }}
                      >
                        撤销退货
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reversing && (
        <ManagementDialog
          title="撤销这次退货"
          subtitle={'退货单 ' + reversing.number}
          size="sm"
          danger
          busy={busy}
          close={() => setReversing(null)}
          footer={
            <EditorFooter note="退回的数量加回库存和采购已到货，退货记录保留。">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setReversing(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-solid"
                disabled={busy || !reason.trim()}
                onClick={() => void reverse()}
              >
                {busy ? '正在撤销…' : '撤销退货'}
              </button>
            </EditorFooter>
          }
        >
          <FormMessage>{error}</FormMessage>
          <FormSection columns={1}>
            <FormField label="撤销原因" required>
              <input
                aria-label="撤销原因"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FormField>
          </FormSection>
        </ManagementDialog>
      )}
    </section>
  );
}
