import { useEffect, useState } from 'react';
import ManagementDialog from './ManagementDialog';
import { managementRequest, useAuthState } from './session';
import StatusBadge from './StatusBadge';
import { displayAmount } from '../shared/display-amount';

export default function ReceiptCorrectionDialog({
  purchase,
  receipt,
  close,
  done,
}: {
  purchase: any;
  receipt: any;
  close: () => void;
  done: (result: any) => void;
}) {
  const lines = receipt.correctionLines;
  const auth = useAuthState();
  const [mode, setMode] = useState<'business' | 'data-edit'>('business');
  const [quantities, setQuantities] = useState<string[]>(lines.map((l: any) => l.quantity));
  const [inspections, setInspections] = useState<any[]>(
    lines.map((l: any) => ({
      acceptedQuantity: l.acceptedQuantity ?? '',
      rejectedQuantity: l.rejectedQuantity ?? '',
      stockedQuantity: l.stockedQuantity ?? '',
      touched: false,
    })),
  );
  const mixed = (l: any) =>
    Number(l.rejectedQuantity || 0) > 0 ||
    (l.stockedQuantity != null &&
      Number(l.stockedQuantity) !== Number(l.recordedQuantity ?? l.quantity));
  const inspection = (i: number) =>
    !inspections[i].touched &&
    !mixed(lines[i]) &&
    lines[i].acceptedQuantity != null &&
    mode === 'business'
      ? { acceptedQuantity: quantities[i], rejectedQuantity: '0', stockedQuantity: quantities[i] }
      : inspections[i];
  const [reason, setReason] = useState(''),
    [plan, setPlan] = useState<any>(null);
  const [busy, setBusy] = useState(false),
    [previewing, setPreviewing] = useState(false),
    [error, setError] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const input = {
    mode,
    expectedVersion: receipt.version,
    expectedPurchaseVersion: purchase.version,
    reason,
    items: lines.map((l: any, index: number) => ({
      index,
      lineId: l.lineId,
      quantity: quantities[index],
      ...(mode === 'business' && (inspections[index].touched || mixed(l))
        ? Object.fromEntries(
            ['acceptedQuantity', 'rejectedQuantity', 'stockedQuantity']
              .filter((k) => inspection(index)[k] !== '')
              .map((k) => [k, inspection(index)[k]]),
          )
        : {}),
    })),
  };
  const inputKey = JSON.stringify(input);
  const path = '/purchases/' + purchase.id + '/receipts/' + encodeURIComponent(receipt.id);
  useEffect(() => {
    let active = true;
    setPlan(null);
    setError('');
    setPreviewing(false);
    setRequestId(crypto.randomUUID());
    if (
      !reason.trim() ||
      (!inspections.some((x) => x.touched) &&
        quantities.every((q, i) => q === lines[i].quantity) &&
        (mode === 'data-edit' || !receipt.discrepancies?.length))
    )
      return;
    setPreviewing(true);
    const timer = window.setTimeout(() => {
      managementRequest(path + '/correction-preview', JSON.parse(inputKey))
        .then((p) => {
          if (active) setPlan({ ...p, inputKey });
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setPreviewing(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [inputKey, path]);
  async function submit() {
    if (!plan || plan.inputKey !== inputKey) return;
    setBusy(true);
    setError('');
    try {
      const result = await managementRequest(path + '/correct', {
        ...JSON.parse(inputKey),
        previewDigest: plan.previewDigest,
        requestId,
      });
      window.dispatchEvent(new Event('erp-business-changed'));
      done(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ManagementDialog title="更正到货单" close={close} busy={busy}>
      <div className="receipt-correction">
        <p>
          <strong>{receipt.reference}</strong> · {receipt.date} · {purchase.supplierName}
        </p>
        <p>
          采购单：{purchase.number}。只修改录错的数量，其余明细保留。原始到货及更正历史会完整保存。
        </p>
        <label className="correction-reason">
          操作方式
          <select
            aria-label="到货更正方式"
            value={mode}
            disabled={busy}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="business">正常业务更正 · 同步库存</option>
            {auth?.actor?.localAdministrator && (
              <option value="data-edit">管理员数据编辑 · 仅改到货统计，库存不变</option>
            )}
          </select>
        </label>
        <p className={mode === 'data-edit' ? 'reconciliation-warning' : ''}>
          {mode === 'data-edit'
            ? '仅修正有效到货统计及采购进度，保留原单与库存流水。与原入库数量不同的部分将登记为待核对差异。'
            : '冲销原入库并登记正确到货，采购统计与库存同步调整。'}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  '采购明细 / 规格',
                  '当前有效数量',
                  '正确数量',
                  '合格数量',
                  '不合格数量',
                  '实际入库数量',
                ].map((t) => (
                  <th key={t}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td>
                    {l.item.name}
                    <span className="sub">
                      {l.item.specification || '规格未填写'}
                      {l.purchaseId !== purchase.id && ` · 关联采购 #${l.purchaseId ?? '无'}`}
                    </span>
                  </td>
                  <td>
                    {l.quantity} {l.item.unit}
                    {l.recordedQuantity !== undefined && l.recordedQuantity !== l.quantity && (
                      <span className="sub">
                        原始实收 {l.recordedQuantity} {l.item.unit}
                      </span>
                    )}
                  </td>
                  <td>
                    <label>
                      <input
                        aria-label={l.item.name + '正确数量'}
                        inputMode="decimal"
                        value={quantities[i]}
                        disabled={busy}
                        onChange={(e) =>
                          setQuantities((q) =>
                            q.map((v, index) => (index === i ? e.target.value : v)),
                          )
                        }
                      />{' '}
                      {l.item.unit}
                    </label>
                  </td>
                  {(['acceptedQuantity', 'rejectedQuantity', 'stockedQuantity'] as const).map(
                    (k, j) => (
                      <td key={k}>
                        <label>
                          <small>{['合格', '不合格', '入库'][j]}</small>
                          <input
                            aria-label={
                              l.item.name + ['正确合格数量', '正确不合格数量', '正确入库数量'][j]
                            }
                            inputMode="decimal"
                            placeholder="未记录"
                            disabled={busy || mode === 'data-edit'}
                            value={inspection(i)[k]}
                            onChange={(e) =>
                              setInspections((v) =>
                                v.map((x, index) =>
                                  index === i
                                    ? { ...inspection(i), [k]: e.target.value, touched: true }
                                    : x,
                                ),
                              )
                            }
                          />
                        </label>
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label className="correction-reason">
          更正原因
          <textarea
            value={reason}
            disabled={busy}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：实际到货5000张，原登记误填10000张"
          />
        </label>
        {previewing && <p role="status">正在核验更正影响…</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {plan && plan.inputKey === inputKey && (
          <div className="correction-impact" aria-label="更正影响">
            <h3>本次更正影响</h3>
            {plan.purchaseImpact.map((p: any) => (
              <div key={p.id}>
                <p>
                  {p.number} <StatusBadge status={p.arrivalProgress} />
                </p>
                {p.lines.map((l: any) => (
                  <p key={l.lineId}>
                    {l.name}：累计到货 {l.before} →{' '}
                    <strong>
                      {l.after} {l.unit}
                    </strong>
                    ；待到货 {l.remaining} {l.unit}
                  </p>
                ))}
              </div>
            ))}
            {plan.stockImpact.map((s: any) => (
              <p key={s.stockId}>
                {s.name}库存：{s.before} →{' '}
                <strong>
                  {s.after} {s.unit}
                </strong>
                ；净变化 {s.delta} {s.unit}
              </p>
            ))}
            {plan.discrepancies?.length > 0 && (
              <div className="reconciliation-warning">
                <strong>待核对差异</strong>
                {plan.discrepancies.map((d: any) => (
                  <p key={d.index}>
                    {d.name}：原入库 {d.recordedQuantity} {d.unit}，有效到货 {d.effectiveQuantity}{' '}
                    {d.unit}。当前库存不变。
                  </p>
                ))}
              </div>
            )}
            <p>
              本次到货金额：{plan.beforeAmount == null ? '待定' : displayAmount(plan.beforeAmount)}{' '}
              → {plan.afterAmount == null ? '待定' : displayAmount(plan.afterAmount)}{' '}
              元；采购订购金额保持{' '}
              {purchase.totalAmount == null ? '待定' : displayAmount(purchase.totalAmount)} 元。
            </p>
          </div>
        )}
        <div className="management-dialog-actions">
          <button disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || previewing || !plan || plan.inputKey !== inputKey}
            onClick={() => void submit()}
          >
            {busy ? '正在更正…' : '提交更正'}
          </button>
        </div>
      </div>
    </ManagementDialog>
  );
}
