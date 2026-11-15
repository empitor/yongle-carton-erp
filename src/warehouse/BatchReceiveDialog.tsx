import { useEffect, useRef, useState } from 'react';
import { UNITS_PER_QUANTITY, errorMessage, safeUnits } from '../../shared/core/index';
import { ManagementDialog } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { Hint, Section, StatusChip } from '../ui/index';
import { quantityString } from '../../shared/core/index';
import { today } from '../../shared/core/index';
import { sumByUnit } from '../ui/index';
import { emit } from '../ui/index';
import { batchForPurchase, readOrderBatch, receiveOrderBatch, type OrderBatch } from './order-batch-api';

/** 订货单上合成的一行 */
type BatchRow = OrderBatch['rows'][number];
/** 一行填的数：实到、其中不合格；实际入库平时收起（null，等于合格数），合格了没全部入库时才展开填 */
type RowInput = { quantity: string; rejected: string; stocked: string | null };
type Inputs = Record<string, RowInput>;

/** 读不出来的数是 NaN，后面的校验会拦下 */
const units = (v: string) => safeUnits(v, NaN);
/** 实到都是 0 时的那句：按钮不能点，刚打开还没填时不提示 */
const NOTHING_FILLED = '请填这次到了多少。';

/**
 * 这一行本次实到的数量会分到哪几张采购单（按下单先后，和服务端同一个算法）。
 * 订货单的行都来自采购单、一定有采购单号；万一是空的，只写数量，不在前面留空白。
 */
function split(parts: BatchRow['parts'], quantity: number) {
  const out: string[] = [];
  let left = quantity;
  for (const p of parts) {
    if (left <= 0) break;
    const q = Math.min(left, p.remainingUnits);
    if (q > 0) out.push([p.purchaseNumber, quantityString(q)].filter(Boolean).join(' '));
    left -= q;
  }
  return out;
}

/** 按订货单读；只给了采购单的，读它所在的订货单（还没订过货的按这张采购单现排一份） */
function loadBatch(batchId?: number, purchaseId?: number) {
  if (batchId) return readOrderBatch(batchId);
  if (purchaseId) return batchForPurchase(purchaseId);
  return Promise.reject(new Error('没有指定订货单或采购单，打不开登记到货。'));
}

/** 还没到齐的行 */
const openRows = (batch: OrderBatch | null) => (batch?.rows || []).filter((r) => r.remainingUnits > 0);

/** 填的数有什么不对（第一处）；都对是空串，一行都没填数是 NOTHING_FILLED */
function receiveProblem(pending: readonly BatchRow[], rows: Inputs) {
  let filled = false;
  for (const r of pending) {
    const v = rows[r.key] || { quantity: '', rejected: '', stocked: null },
      q = units(v.quantity),
      bad = units(v.rejected),
      stocked = v.stocked === null ? 0 : units(v.stocked);
    if (!Number.isFinite(q)) return r.name + '：本次实到数量格式不对。';
    if (!Number.isFinite(bad)) return r.name + '：不合格数量格式不对。';
    if (!Number.isFinite(stocked)) return r.name + '：实际入库数量格式不对。';
    if (q > r.remainingUnits) return r.name + '：比还没到的多，多送的部分请在“更多”里登记没有采购单的到货。';
    if (bad > q) return r.name + '：不合格不能比实到多。';
    if (stocked > q - bad) return r.name + '：实际入库不能比合格的多。';
    if (q % UNITS_PER_QUANTITY) return r.name + '：纸板按整张登记。';
    if (q > 0) filled = true;
  }
  return filled ? '' : NOTHING_FILLED;
}

/** 交给服务端的行：只交这次到了的（实到大于 0），实际入库展开填了才带 */
const receiveRows = (pending: readonly BatchRow[], rows: Inputs) =>
  pending
    .filter((r) => units(rows[r.key]?.quantity || '0') > 0)
    .map((r) => {
      const v = rows[r.key];
      return {
        key: r.key,
        quantity: v.quantity.trim(),
        rejectedQuantity: v.rejected.trim() || '0',
        ...(v.stocked !== null ? { stockedQuantity: v.stocked.trim() || '0' } : {}),
      };
    });

type Props = {
  batchId?: number;
  purchaseId?: number;
  close: () => void;
  done: (message: string) => void;
};

/**
 * 按一张供应商送货单登记到货：每行填本次实到和不合格，确认后直接入库。
 * 一份订货单可以分几次送货，没到齐的继续留在待到货里。
 */
export default function BatchReceiveDialog({ batchId, purchaseId, close, done }: Props) {
  const [batch, setBatch] = useState<OrderBatch | null>(null),
    [date, setDate] = useState(today()),
    [time, setTime] = useState(''),
    [reference, setReference] = useState(''),
    [notes, setNotes] = useState(''),
    [rows, setRows] = useState<Inputs>({}),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    loadBatch(batchId, purchaseId)
      .then((b) => {
        if (!active) return;
        setBatch(b);
        // 默认整行都到了，没到齐的改成实际数量就行
        setRows(
          Object.fromEntries(
            openRows(b).map((r) => [r.key, { quantity: quantityString(r.remainingUnits), rejected: '0', stocked: null }]),
          ),
        );
      })
      .catch((e: unknown) => active && setError(errorMessage(e)))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [batchId, purchaseId]);
  const pending = openRows(batch);
  const problem = batch ? receiveProblem(pending, rows) : '';
  // 合计写成“N 张”（采购的纸板只有“张”，采购保存时拦别的单位）
  const total = sumByUnit(pending.map((r) => ({ value: rows[r.key]?.quantity || '', unit: r.unit || '' })));
  const submit = (b: OrderBatch) =>
    void (async () => {
      setBusy(true);
      setError('');
      try {
        const result = await receiveOrderBatch(b, {
          expectedVersion: b.version,
          requestId: requestId.current,
          date,
          actualTime: time || null,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          notes,
          rows: receiveRows(pending, rows),
        });
        emit('erp-business-changed');
        done(result.summary);
      } catch (e) {
        setError(errorMessage(e));
        setBusy(false);
      }
    })();
  return (
    <ManagementDialog
      title={batch ? '登记到货 · 订货单 ' + batch.number : '登记到货'}
      subtitle={batch ? batch.supplierName + ' · ' + batch.purchases.map((p) => p.number).join('、') : undefined}
      size="lg"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="合格的直接入库，弄错了可以撤销；没到齐的继续留在待到货里。">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !batch || !!problem} onClick={() => batch && submit(batch)}>
            {busy && batch ? '正在入库…' : '登记到货'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      {!batch ? (
        <p className="help-text" role="status">
          {busy ? '正在读取订货单…' : ''}
        </p>
      ) : !pending.length ? (
        <Hint tone="info">这份订货单已经全部到齐了。</Hint>
      ) : (
        <>
          <FormSection title="哪天到的" columns={3}>
            <FormField label="到货日期" required>
              <input type="date" aria-label="到货日期" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
            <FormField label="到货时间" hint="选填">
              <input type="time" aria-label="到货时间" value={time} onChange={(e) => setTime(e.target.value)} />
            </FormField>
            <FormField label="供应商送货单号" hint="选填，同一张送货单不能登记两次">
              <input aria-label="供应商送货单号" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
            </FormField>
          </FormSection>
          <Section title={'这次到了多少 · 合计 ' + total}>
            <div className="ob-rows">
              {pending.map((r) => (
                <ReceiveRow
                  key={r.key}
                  r={r}
                  v={rows[r.key] || { quantity: '', rejected: '0', stocked: null }}
                  set={(v) => setRows((s) => ({ ...s, [r.key]: v }))}
                />
              ))}
            </div>
          </Section>
          <FormSection title="备注" columns={1}>
            <FormField label="备注" span="full">
              <textarea aria-label="到货备注" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </FormSection>
          <FormMessage>
            {problem !== NOTHING_FILLED
              ? problem
              : // 刚打开、还没填时不提示；填了但全是 0 时说清按钮为什么不能点
                pending.some((r) => (rows[r.key]?.quantity ?? '').trim() !== '')
                ? '实到数量都是 0：至少给一种纸板填上这次到了多少，才能登记。'
                : ''}
          </FormMessage>
        </>
      )}
    </ManagementDialog>
  );
}

/** 一行纸板：还差多少、到货安排里还没到的几段、本次实到 / 不合格 / 实际入库，会分到哪几张采购单 */
function ReceiveRow({ r, v, set }: { r: BatchRow; v: RowInput; set: (v: RowInput) => void }) {
  const q = units(v.quantity),
    accepted = q - units(v.rejected || '0');
  const patch = (p: Partial<RowInput>) => set({ ...v, ...p });
  const dated = r.schedule.flatMap((s) => (s.remainingUnits > 0 && s.dueDate ? [{ ...s, dueDate: s.dueDate }] : []));
  return (
    <div className="ob-row">
      <div className="ob-row-head">
        <div>
          <strong>{r.name}</strong>
          <small>{r.specification}</small>
        </div>
        <div className="ob-row-qty">
          <strong>
            还差 {quantityString(r.remainingUnits)} {r.unit}
          </strong>
          <small>
            订 {quantityString(r.orderedUnits)} · 已到 {quantityString(r.receivedUnits)}
          </small>
        </div>
      </div>
      {dated.length > 0 && (
        <div className="ob-due">
          {dated.map((s, i) => (
            <StatusChip key={i} tone={s.state === 'overdue' ? 'danger' : 'neutral'}>
              {s.dueDate.slice(5)} 前 {quantityString(s.remainingUnits)}
              {s.state === 'overdue' ? ' · 逾期' : ''}
            </StatusChip>
          ))}
        </div>
      )}
      <div className="ob-receive-line">
        <label>
          <span>本次实到</span>
          <input aria-label={r.name + ' 本次实到'} inputMode="decimal" value={v.quantity} onChange={(e) => patch({ quantity: e.target.value })} />
          <span>{r.unit}</span>
        </label>
        <label>
          <span>其中不合格</span>
          <input aria-label={r.name + ' 不合格'} inputMode="decimal" value={v.rejected} onChange={(e) => patch({ rejected: e.target.value })} />
          <span>{r.unit}</span>
        </label>
        {v.stocked === null ? (
          <button
            type="button"
            className="text-button"
            title="合格的都入库时不用填"
            onClick={() => patch({ stocked: Number.isFinite(accepted) ? quantityString(Math.max(0, accepted)) : '' })}
          >
            合格的没全部入库？
          </button>
        ) : (
          <label>
            <span>实际入库</span>
            <input aria-label={r.name + ' 实际入库'} inputMode="decimal" value={v.stocked} onChange={(e) => patch({ stocked: e.target.value })} />
            <span>{r.unit}</span>
            <button type="button" className="text-button" onClick={() => patch({ stocked: null })}>
              全部入库
            </button>
          </label>
        )}
        {Number.isFinite(q) && q > 0 && r.parts.length > 1 && <small className="ob-split">分到 {split(r.parts, q).join('、')}</small>}
      </div>
    </div>
  );
}
