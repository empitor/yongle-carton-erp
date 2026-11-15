import type { OrderBatchView } from '../../shared/business/index';
import { quantityString } from '../../shared/core/index';
import { FormField } from '../ui/index';

/** 挂哪份订货单：选了订货单是它的编号；选“不挂采购单”时 withoutPurchase 为真、编号清掉 */
type BatchPatch = { orderBatchId: number | undefined; withoutPurchase: boolean };

/**
 * AI 识别的送货单挂哪份订货单：这家供应商还没到齐的订货单，或“不挂采购单”（多送、样品）。
 * 选了订货单，入库时按订货单分到各张采购单（服务端 registerArrival），不再一行行挑采购明细。
 * withoutPurchase 只在核对时用，不存进单据。
 */
export default function BatchChoice({
  value: v,
  batches,
  change,
}: {
  value: { supplierId?: number | null; orderBatchId?: number; withoutPurchase?: boolean };
  /** 还没到齐的订货单（/api/order-batches） */
  batches: OrderBatchView[];
  change: (patch: BatchPatch) => void;
}) {
  const own = batches.filter((b) => b.supplierId === v.supplierId);
  const left = (b: OrderBatchView) =>
    b.rows
      .filter((r) => r.remainingUnits > 0)
      .map((r) => r.name + ' 还差 ' + quantityString(r.remainingUnits) + ' ' + r.unit)
      .join('、');
  return (
    <FormField
      label="订货单"
      required
      span={2}
      hint={
        v.supplierId
          ? own.length
            ? '这批货是哪份订货单的；入库时按订货单分到各张采购单'
            : '这家供应商没有还没到齐的订货单'
          : '先选供应商'
      }
    >
      <select
        aria-label="这批货对应的订货单"
        value={v.withoutPurchase ? 'none' : (v.orderBatchId ?? '')}
        onChange={(e) => {
          const value = e.currentTarget.value;
          change(
            value === 'none'
              ? { orderBatchId: undefined, withoutPurchase: true }
              : { orderBatchId: value ? Number(value) : undefined, withoutPurchase: false },
          );
        }}
      >
        <option value="">请选择</option>
        {own.map((b) => (
          <option key={b.id} value={b.id}>
            {b.number + (left(b) ? ' · ' + left(b) : '')}
          </option>
        ))}
        <option value="none">不挂采购单（多送、样品）</option>
      </select>
    </FormField>
  );
}
