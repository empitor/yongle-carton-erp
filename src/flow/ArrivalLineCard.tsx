import { RAW_UNIT, convertDimension, type DimensionUnit } from '../../shared/core/index';
import { specLine } from '../../shared/business/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { FormField, RowDelete } from '../ui/index';
import Select from './Select';
import { lineAmount, lineArea } from './DocLines';
import type { ArrivalEditLine } from './flow-prefill';

/* 到货单编辑窗里一种纸板的卡片（ArrivalForm 一行一张）：纸板资料、数量和金额、送货单上的标注。 */

type StockItem = CatalogLists['items'][number];
type Item = ArrivalEditLine['item'];

/** 尺寸单位下拉的取值：未确认是空串 */
const dimensionUnitOf = (value: string): DimensionUnit | null => (value === 'mm' || value === 'cm' ? value : null);

/** 一行纸板的资料：入哪个库存、名称、材质、楞型、长宽和尺寸单位（换单位时长宽跟着换算）、规格说明 */
function BoardFields({
  l,
  raw,
  patch,
  item,
}: {
  l: ArrivalEditLine;
  raw: StockItem[];
  patch: (p: Partial<ArrivalEditLine>) => void;
  item: (p: Partial<Item>) => void;
}) {
  const unitText = l.item.dimensionUnit ? '（' + l.item.dimensionUnit + '）' : '';
  return (
    <>
      <Select
        label="入哪个库存"
        span={2}
        hint="选已有的要规格一致；不选时，核对入库按名称和规格对应已有的（不分大小写），没有才新建"
        value={l.stockId}
        options={raw.map((s) => ({
          ...s,
          label: [s.name, specLine(s)].filter(Boolean).join(' · '),
        }))}
        empty="核对入库时自动对应，没有就新建"
        onChange={(stockId) => {
          const s = raw.find((x) => x.id === stockId);
          patch({ stockId, ...(s ? { item: { ...s, unit: RAW_UNIT } } : {}) });
        }}
      />
      <FormField label="纸板名称" required span={2}>
        <input aria-label="纸板名称" value={l.item.name} onChange={(e) => item({ name: e.target.value })} />
      </FormField>
      <FormField label="材质 / 配纸">
        <input aria-label="材质 / 配纸" value={l.item.material} onChange={(e) => item({ material: e.target.value })} />
      </FormField>
      <FormField label="楞型">
        <input aria-label="楞型" value={l.item.flute} onChange={(e) => item({ flute: e.target.value })} />
      </FormField>
      <FormField label={'长' + unitText}>
        <input
          aria-label="纸板长"
          type="number"
          step="any"
          value={l.item.length ?? ''}
          onChange={(e) => item({ length: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </FormField>
      <FormField label={'宽' + unitText}>
        <input
          aria-label="纸板宽"
          type="number"
          step="any"
          value={l.item.width ?? ''}
          onChange={(e) => item({ width: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </FormField>
      <FormField label="尺寸单位" hint={l.item.dimensionUnit ? undefined : '不确定就先不选，不会换算'}>
        <select
          aria-label="尺寸单位"
          value={l.item.dimensionUnit || ''}
          onChange={(e) => {
            const unit = dimensionUnitOf(e.target.value),
              from = l.item.dimensionUnit;
            item({
              dimensionUnit: unit,
              ...(unit && from
                ? {
                    length: convertDimension(l.item.length, from, unit),
                    width: convertDimension(l.item.width, from, unit),
                  }
                : {}),
            });
          }}
        >
          <option value="">未确认</option>
          <option value="mm">毫米</option>
          <option value="cm">厘米</option>
        </select>
      </FormField>
      <FormField label="规格说明">
        <input
          aria-label="规格说明"
          value={l.item.specification || ''}
          onChange={(e) => item({ specification: e.target.value })}
        />
      </FormField>
    </>
  );
}

/** 一行纸板的数量和金额：实到（合格、入库还是默认时跟着改）、合格、不合格、入库、计价方式、单价、差异原因 */
function CountFields({ l, patch }: { l: ArrivalEditLine; patch: (p: Partial<ArrivalEditLine>) => void }) {
  return (
    <>
      <FormField label="实到数量（张）" required>
        <input
          aria-label="本批实际到货数量"
          inputMode="numeric"
          value={l.quantity}
          onChange={(e) =>
            patch({
              quantity: e.target.value,
              ...(l.acceptedQuantity === l.quantity && l.rejectedQuantity === '0' && l.stockedQuantity === l.quantity
                ? { acceptedQuantity: e.target.value, stockedQuantity: e.target.value }
                : {}),
            })
          }
        />
      </FormField>
      <FormField label="合格" hint="空着就是全部合格">
        <input
          aria-label="验收合格数量"
          inputMode="decimal"
          value={l.acceptedQuantity ?? ''}
          onChange={(e) => patch({ acceptedQuantity: e.target.value || null })}
        />
      </FormField>
      <FormField label="不合格" hint="空着按实到减合格">
        <input
          aria-label="不合格数量"
          inputMode="decimal"
          value={l.rejectedQuantity ?? ''}
          onChange={(e) => patch({ rejectedQuantity: e.target.value || null })}
        />
      </FormField>
      <FormField label="入库" hint="空着就是合格数">
        <input
          aria-label="实际入库数量"
          inputMode="decimal"
          value={l.stockedQuantity ?? ''}
          onChange={(e) => patch({ stockedQuantity: e.target.value || null })}
        />
      </FormField>
      <FormField label="计价方式">
        <select
          aria-label="计价方式"
          value={l.priceBasis || ''}
          onChange={(e) => patch({ priceBasis: e.target.value || null })}
        >
          <option value="">待确认</option>
          <option value="area">按平方米</option>
          <option value="quantity">按张</option>
        </select>
      </FormField>
      <FormField label={'单价' + (l.priceBasis ? '（元/' + (l.priceBasis === 'area' ? 'm²' : '张') + '）' : '')}>
        <input
          aria-label="单价"
          inputMode="decimal"
          value={l.unitPrice ?? ''}
          onChange={(e) => patch({ unitPrice: e.target.value || null })}
        />
      </FormField>
      <FormField label="差异原因" span={2} hint="数量和采购不一致、或没有采购单时写明">
        <input
          aria-label="到货差异原因 / 无采购单说明"
          value={l.differenceReason || ''}
          onChange={(e) => patch({ differenceReason: e.target.value })}
        />
      </FormField>
    </>
  );
}

/** 一种纸板的卡片：头上是名称、面积和金额、移除；下面资料和数量，送货单上的标注收在“更多”里 */
export default function ArrivalLineCard({
  l,
  index: i,
  only,
  raw,
  patch,
  remove,
}: {
  l: ArrivalEditLine;
  index: number;
  /** 只剩这一行时不能移除 */
  only: boolean;
  raw: StockItem[];
  patch: (p: Partial<ArrivalEditLine>) => void;
  remove: () => void;
}) {
  const item = (p: Partial<Item>) => patch({ item: { ...l.item, ...p } });
  return (
    <div className="line-card">
      <header>
        <strong>
          纸板 {i + 1}
          {l.item.name ? ' · ' + l.item.name : ''}
        </strong>
        <span className="line-card-sum">
          {lineArea(l) || '待确认'} m² · {lineAmount(l) || '待确认'} 元
        </span>
        <RowDelete label={'移除纸板 ' + (i + 1)} disabled={only} onClick={remove} />
      </header>
      <div className="ed-grid cols-4">
        <BoardFields l={l} raw={raw} patch={patch} item={item} />
        <CountFields l={l} patch={patch} />
      </div>
      <details className="line-card-more">
        <summary>送货单上的标注和纸板备注</summary>
        <div className="ed-grid cols-4">
          <FormField label="标注张数">
            <input
              aria-label="送货单标注张数"
              value={l.statedQuantity ?? ''}
              onChange={(e) => patch({ statedQuantity: e.target.value || null })}
            />
          </FormField>
          <FormField label="标注面积（m²）">
            <input
              aria-label="送货单标注面积"
              value={l.statedArea ?? ''}
              onChange={(e) => patch({ statedArea: e.target.value || null })}
            />
          </FormField>
          <FormField label="纸板备注" span={2}>
            <input aria-label="纸板备注" value={l.item.notes || ''} onChange={(e) => item({ notes: e.target.value })} />
          </FormField>
        </div>
      </details>
    </div>
  );
}
