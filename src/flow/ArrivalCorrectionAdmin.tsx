import { formatStockSize, specLine } from '../../shared/business/index';
import { priceBases, quantityString, RAW_UNIT } from '../../shared/core/index';
import { FormField, FormSection, RowDelete } from '../ui/index';
import type { readCatalog } from '../recordkit/catalog-api';
import { AddRow } from './CorrectionParts';
import Select from './Select';
import { dateInput } from './form-inputs';
import { newCorrectionRow, type CorrectionHead, type CorrectionRow, type PriceBasis } from './arrival-correction';

/** 管理员这一栏要对照的档案：供应商、原材料库存品、采购单 */
export type AdminCatalog = Awaited<ReturnType<typeof readCatalog<'suppliers' | 'items' | 'purchases'>>>;
/** 计价方式下拉：和到货明细的计价方式同一组取值 */
const priceBasisLabels: Record<PriceBasis, string> = { area: '按平方米', quantity: '按张' };
const priceBasisOptions = priceBases.map((b) => [b, priceBasisLabels[b]] as const);
const priceBasisOf = (value: string) => priceBasisOptions.find(([v]) => v === value)?.[0] ?? null;

/**
 * 更正到货单里只有本机管理员能改的一栏：到货日期、送货单号、供应商，每行的单价和计价方式、库存品、
 * 挂哪条采购明细，加行、删行。业务账号看不到这一栏（服务端也会拦）。新加的行选了库存品或采购明细后带出纸板。
 */
export default function ArrivalCorrectionAdmin({
  head,
  setHead,
  rows,
  setRows,
  patch,
  catalog,
  busy,
}: {
  head: CorrectionHead;
  setHead: (patch: Partial<CorrectionHead>) => void;
  rows: CorrectionRow[];
  setRows: (rows: CorrectionRow[]) => void;
  patch: (i: number, value: Partial<CorrectionRow>) => void;
  /** 读不到时是空的 */
  catalog: AdminCatalog;
  busy: boolean;
}) {
  const raw = catalog.items.filter((s) => s.kind === 'raw');
  const purchaseLines = catalog.purchases
    .filter((p) => p.supplierId === head.supplierId)
    .flatMap((p) =>
      p.lines.map((x) => ({
        ...x,
        label: [p.number, x.name, x.specification || formatStockSize(x), '还差 ' + quantityString(Math.max(0, x.quantityUnits - x.receivedUnits)) + ' 张']
          .filter(Boolean)
          .join(' · '),
      })),
    );
  return (
    <FormSection
      title="管理员还能改"
      hint="改了这里的内容也是撤销原单、另出一张更正后的到货单，库存按净变化调整"
      columns={4}
      extra={
        <AddRow busy={busy} add={() => setRows([...rows, newCorrectionRow()])}>
          加一行
        </AddRow>
      }
    >
      <FormField label="到货日期">{dateInput(head.date, (date) => setHead({ date }), '更正后的到货日期')}</FormField>
      <FormField label="供应商送货单号">
        <input aria-label="更正后的送货单号" value={head.reference} maxLength={100} onChange={(e) => setHead({ reference: e.currentTarget.value })} />
      </FormField>
      <Select
        label="供应商"
        span={2}
        value={head.supplierId}
        options={catalog.suppliers}
        onChange={(supplierId) => setHead({ supplierId })}
      />
      {rows.map((r, i) => (
        <div className="line-card" key={i} style={{ gridColumn: '1 / -1' }}>
          <header>
            <strong>{r.item?.name || '新加的纸板（先选库存品或采购明细）'}</strong>
            <RowDelete
              label={'删掉第 ' + (i + 1) + ' 行'}
              disabled={busy || rows.length === 1}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            />
          </header>
          <div className="ed-grid cols-4">
            <Select
              label="库存品"
              span={2}
              value={r.stockId}
              options={raw.map((s) => ({ ...s, label: [s.name, specLine(s)].filter(Boolean).join(' · ') }))}
              empty="核对时自动对应，没有就新建"
              onChange={(stockId) => {
                const s = raw.find((x) => x.id === stockId);
                patch(i, { stockId, ...(r.index === undefined && s ? { item: { ...s, unit: RAW_UNIT } } : {}) });
              }}
            />
            <Select
              label="挂哪条采购明细"
              span={2}
              value={r.purchaseLineId}
              options={purchaseLines}
              empty="不挂采购单"
              onChange={(purchaseLineId) => {
                const pl = purchaseLines.find((x) => x.id === purchaseLineId);
                patch(i, {
                  purchaseLineId,
                  ...(r.index === undefined && pl
                    ? { item: { ...pl, unit: RAW_UNIT }, stockId: pl.stockItemId, unitPrice: pl.unitPrice, priceBasis: pl.priceBasis }
                    : {}),
                });
              }}
            />
            <FormField label="计价方式">
              <select
                aria-label={'第 ' + (i + 1) + ' 行计价方式'}
                value={r.priceBasis || ''}
                onChange={(e) => patch(i, { priceBasis: priceBasisOf(e.currentTarget.value) })}
              >
                <option value="">待确认</option>
                {priceBasisOptions.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="单价">
              <input
                aria-label={'第 ' + (i + 1) + ' 行单价'}
                inputMode="decimal"
                value={r.unitPrice ?? ''}
                onChange={(e) => patch(i, { unitPrice: e.currentTarget.value || null })}
              />
            </FormField>
          </div>
        </div>
      ))}
    </FormSection>
  );
}
