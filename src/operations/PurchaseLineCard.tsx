import { RAW_UNIT, priceBases } from '../../shared/core/index';
import { formatStockSize, requiredPurchaseSize, type StockItemView } from '../../shared/business/index';
import { Combobox, FormField, RowDelete } from '../ui/index';
import { DimensionFields, SizeInput, lineAmountText } from './fields';
import type { PurchaseLineForm } from './purchase-seed';

type Props = {
  line: PurchaseLineForm;
  index: number;
  /** 一共几种纸板：只剩一种时不能移除 */
  count: number;
  frozen: boolean;
  orders: readonly { id: number; number: string }[];
  /** 库存品（只列原材料） */
  items: readonly StockItemView[];
  /** 打开窗口时已存的这一行（新建的是 null）：尺寸单位要不要先确认看它 */
  saved: PurchaseLineForm | null;
  change: (patch: Partial<PurchaseLineForm>) => void;
  remove: () => void;
};

/** 选库存里已有的纸板：带出这个库存品的内容（名称、规格、尺寸、材质、楞型等），这一行原来的编号、张数、单价留着 */
function pickStock(l: PurchaseLineForm, items: Props['items'], v: string): Partial<PurchaseLineForm> {
  const stock = items.find((s) => s.id === Number(v));
  return stock ? { ...stock, id: l.id, stockItemId: stock.id, quantity: l.quantity, unitPrice: l.unitPrice, reference: undefined } : { stockItemId: null };
}

/**
 * 采购单编辑窗里的一种纸板：库存里已有的纸板、名称、材质楞型、尺寸、数量、计价和单价；
 * 高、规格说明和备注收进“更多”。frozen 时（已有到货、不是本机管理员）只能看。
 */
export default function PurchaseLineCard({ line: l, index: i, count, frozen, orders, items, saved, change, remove }: Props) {
  const n = '纸板' + (i + 1) + ' ';
  return (
    <div className="line-card pur-line" key={i}>
      <header>
        <strong>
          纸板 {i + 1}
          {l.name ? ' · ' + l.name : ''}
        </strong>
        {l.reference && <span className="pur-reference">{l.reference}</span>}
        {l.customerOrderId && (
          <span className="pur-reference">
            给订单{' '}
            {orders.find((o) => o.id === Number(l.customerOrderId))?.number || l.customerOrderNumber || '#' + l.customerOrderId}
          </span>
        )}
        <span className="line-card-sum">{lineAmountText(l)}</span>
        {!frozen && <RowDelete label={'移除纸板 ' + (i + 1)} disabled={count === 1} onClick={remove} />}
      </header>
      <fieldset className="pur-line-fields" disabled={frozen}>
        <div className="ed-grid cols-4">
          <FormField label="库存里已有的纸板" span={2} hint="不选的话，到货核对入库时先对应库存里一样的纸板，没有才新建">
            <Combobox
              ariaLabel={'采购明细' + (i + 1) + ' 库存品'}
              placeholder="到货时自动对应，没有就新建"
              disabled={frozen}
              value={l.stockItemId ? String(l.stockItemId) : ''}
              onChange={(v) => change(pickStock(l, items, v))}
              options={[
                { value: '', label: '不选（到货时自动对应，没有就新建）' },
                ...items
                  .filter((s) => s.kind === 'raw' && !s.archived)
                  .map((s) => ({
                    value: String(s.id),
                    label: s.name,
                    hint: [s.specification || formatStockSize(s), s.unit].filter(Boolean).join(' · '),
                  })),
              ]}
            />
          </FormField>
          <FormField label="纸板名称" required span={2}>
            <input aria-label={n + '纸板名称'} required maxLength={100} value={l.name} onChange={(e) => change({ name: e.target.value })} />
          </FormField>
          <FormField label="材质 / 配纸">
            <input aria-label={n + '材质 / 配纸'} maxLength={100} value={l.material} onChange={(e) => change({ material: e.target.value })} />
          </FormField>
          <FormField label="楞型">
            <input aria-label={n + '楞型'} maxLength={50} value={l.flute} onChange={(e) => change({ flute: e.target.value })} />
          </FormField>
          <DimensionFields value={l} change={change} disabled={frozen} height={false} prefix={n} saved={saved} required={requiredPurchaseSize(l)} />
          <FormField label="订货数量" required>
            <div className="form-inline">
              <input aria-label={n + '订货数量'} required inputMode="decimal" value={l.quantity} onChange={(e) => change({ quantity: e.target.value })} />
              <span className="unit-fixed" aria-label={n + '数量单位'}>
                {RAW_UNIT}
              </span>
            </div>
          </FormField>
          <FormField label="计价方式">
            <select
              aria-label={n + '计价方式'}
              value={l.priceBasis || 'quantity'}
              onChange={(e) => {
                const basis = priceBases.find((b) => b === e.target.value);
                if (basis) change({ priceBasis: basis });
              }}
            >
              <option value="area">按平方米</option>
              <option value="quantity">按{RAW_UNIT}</option>
            </select>
          </FormField>
          <FormField
            label={'单价' + (l.priceBasis === 'area' ? '（元/m²）' : l.unit ? '（元/' + l.unit + '）' : '（元）')}
            hint="不知道可以先空着"
          >
            <input aria-label={n + '单价'} inputMode="decimal" value={l.unitPrice ?? ''} onChange={(e) => change({ unitPrice: e.target.value || null })} />
          </FormField>
        </div>
        <details className="line-card-more" open={!!(l.height != null || l.specification || l.notes) || undefined}>
          <summary>高、规格说明和备注</summary>
          <div className="ed-grid cols-4">
            <FormField label={'高' + (l.dimensionUnit ? '（' + l.dimensionUnit + '）' : '')}>
              <SizeInput value={l} k="height" change={change} disabled={frozen} label={n + '高'} />
            </FormField>
            <FormField label="规格说明">
              <input aria-label={n + '规格说明'} maxLength={2000} value={l.specification} onChange={(e) => change({ specification: e.target.value })} />
            </FormField>
            <FormField label="明细备注" span={2}>
              <input aria-label={n + '明细备注'} maxLength={1000} value={l.notes} onChange={(e) => change({ notes: e.target.value })} />
            </FormField>
          </div>
        </details>
      </fieldset>
    </div>
  );
}
