import type { inventoryMetrics, purchaseMetrics } from '../../shared/business/index';
import { ListSummary } from '../ui/index';

type InventoryMetrics = ReturnType<typeof inventoryMetrics>;
type Common = { kind: string; flowTab: boolean; error: string; busy: boolean; metricsPending: boolean; zeroOnly?: boolean };
/** 各页给的数据：供应商页是供应商列表，采购单页是采购统计，库存页是原材料、成品两份库存统计 */
type Props = Common &
  (
    | { mode: 'suppliers'; data: { suppliers: readonly unknown[] } }
    | { mode: 'purchases'; data: { purchaseMetrics: ReturnType<typeof purchaseMetrics> } }
    | { mode: 'warehouse'; data: { inventoryMetrics: { raw: InventoryMetrics; finished: InventoryMetrics } } }
  );

/** 采购单页：当前范围的采购单、待到货、逾期 */
function PurchaseSummary({ metrics, pending }: { metrics: ReturnType<typeof purchaseMetrics>; pending: boolean }) {
  return (
    <ListSummary
      items={[
        { label: '采购单', value: pending ? '—' : metrics.total, hint: '当前范围' },
        { label: '待到货', value: pending ? '—' : metrics.pending, hint: '还没到齐，含待订货和部分到货' },
        { label: '逾期', value: pending ? '—' : metrics.overdue, hint: '过了预计到货日还没到齐' },
      ]}
    />
  );
}

/** 原材料：有库存的纸板几种、总面积（尺寸或单位不全的没算进去时一定要写出来） */
function RawSummary({ raw, busy }: { raw: InventoryMetrics; busy: boolean }) {
  return (
    <ListSummary
      items={[
        { label: '有库存的纸板', value: busy ? '—' : raw.varieties + ' 种', hint: '按实际规格分组' },
        {
          label: '总面积',
          value: busy ? '—' : raw.areaExcluded && !raw.areaConverted ? '算不出' : raw.areaSquareMetres + ' m²',
          hint: '按长宽和数量算',
          // 有纸板没算进总面积时一定要让人看见，不然像是全算进去了
          note: !busy && raw.areaExcluded ? `另有 ${raw.areaExcluded} 种尺寸或单位不全，没算进去` : undefined,
        },
      ]}
    />
  );
}

/** 成品：有库存的几种、数量（不同单位分开写） */
function FinishedSummary({ finished, busy }: { finished: InventoryMetrics; busy: boolean }) {
  return (
    <ListSummary
      items={[
        { label: '有库存的成品', value: busy ? '—' : finished.varieties + ' 种' },
        {
          label: '数量',
          value: busy ? (
            '—'
          ) : finished.quantities.length ? (
            <span className="quantity-groups">
              {finished.quantities.map((g) => (
                <span key={g.unit}>
                  {g.quantity} <small>{g.unit}</small>
                </span>
              ))}
            </span>
          ) : (
            0
          ),
          hint: '不同单位分开写',
        },
      ]}
    />
  );
}

/** 供应商、采购单、库存页标题旁的统计数字。统计只在页头出现一次。 */
export default function OperationsSummary(o: Props) {
  if (o.error) return null;
  if (o.mode === 'suppliers') return <ListSummary items={[{ label: '供应商', value: o.busy ? '—' : o.data.suppliers.length }]} />;
  if (o.mode === 'purchases') return <PurchaseSummary metrics={o.data.purchaseMetrics} pending={o.metricsPending} />;
  if (o.flowTab || o.zeroOnly) return null;
  const { raw, finished } = o.data.inventoryMetrics;
  return o.kind === 'raw' ? <RawSummary raw={raw} busy={o.busy} /> : <FinishedSummary finished={finished} busy={o.busy} />;
}
