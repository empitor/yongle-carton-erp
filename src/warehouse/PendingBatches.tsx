import { Suspense, lazy, useState } from 'react';
import { StatusChip, notify } from '../ui/index';
import { quantityString } from '../../shared/core/index';
import type { OrderBatch } from './order-batch-api';

// 点了“登记到货”才打开，按需加载
const BatchReceiveDialog = lazy(() => import('./BatchReceiveDialog'));

/** 下一段要到的日期；日期都没定的排在最后 */
const due = (b: OrderBatch) => b.progress.nextDue || '9999-12-31';
/** 逾期的在前，其余按要到的日期先后 */
const byUrgency = (a: OrderBatch, b: OrderBatch) =>
  a.progress.overdue !== b.progress.overdue ? (a.progress.overdue ? -1 : 1) : due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0;

type Props = { batches: readonly OrderBatch[]; canEdit: boolean };

/**
 * 到货页最上面的“待到货”：已经发给供应商、还没到齐的订货单，按要到的日期排，逾期的标红。
 * 每行一个“登记到货”，就是这一页的主操作：直接打开登记窗口，办完回到这里。
 */
export default function PendingBatches({ batches, canEdit }: Props) {
  const [receiving, setReceiving] = useState<number | null>(null);
  if (!batches.length) return null;
  const sorted = [...batches].sort(byUrgency);
  return (
    <section className="panel wh-pending" aria-label="待到货的订货单">
      <header>
        <h2>待到货</h2>
        <span className="wh-muted">{batches.length} 份订货单</span>
      </header>
      <ul>
        {sorted.map((b) => {
          const pending = b.rows.filter((r) => r.remainingUnits > 0);
          return (
            <li key={b.id}>
              <div className="wh-pending-main">
                <strong>{b.supplierName}</strong>
                <span>
                  订货单 {b.number}
                  {b.purchases.length > 1 ? ' · 含 ' + b.purchases.map((p) => p.number).join('、') : ''}
                </span>
              </div>
              <div className="wh-pending-rows">
                {pending.map((r) => (
                  <span key={r.key}>
                    {r.name} 还差 {quantityString(r.remainingUnits)} {r.unit}
                  </span>
                ))}
              </div>
              <div className="wh-pending-due">
                {b.progress.overdue ? (
                  <StatusChip tone="danger">逾期</StatusChip>
                ) : b.progress.nextDue ? (
                  <StatusChip tone="info">{b.progress.nextDue.slice(5)} 前要到</StatusChip>
                ) : (
                  <StatusChip tone="neutral">日期待定</StatusChip>
                )}
                {b.progress.state === '部分到货' && <StatusChip tone="accent">部分到货</StatusChip>}
              </div>
              {canEdit && (
                <button type="button" className="secondary" onClick={() => setReceiving(b.id)}>
                  登记到货
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {receiving !== null && (
        <Suspense fallback={null}>
          <BatchReceiveDialog
            batchId={receiving}
            close={() => setReceiving(null)}
            done={(m) => {
              setReceiving(null);
              notify(m);
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
