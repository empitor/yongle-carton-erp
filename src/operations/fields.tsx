import DimensionUnitSelect from '../editors/DimensionUnitSelect';
import { FormField } from '../ui/index';
import { convertDimension, normalizeDimensionUnit, dimensionKeys, type DimensionUnit } from '../../shared/core/index';
import { lineMoney, sumMoney } from '../../shared/business/index';
import { UNPRICED_TEXT, purchaseLineAmount } from '../../shared/business/index';
import { displayAmount } from '../../shared/core/index';

/** 采购、库存编辑窗共用的小件：尺寸字段、金额计算。空白档案在 purchase-seed.ts。 */

/** 一行采购算金额要的：数量、单价、计价方式，按面积时还要纸板的单位和尺寸 */
type PricedLine = Parameters<typeof purchaseLineAmount>[0] & { unitPrice: string | null };
type DimensionKey = (typeof dimensionKeys)[number];
/** 尺寸字段读的：长、宽、高和尺寸单位（库存品编辑窗的表单里单位可能还是没认出来的原文） */
type Sized = { length?: number | null; width?: number | null; height?: number | null; dimensionUnit?: string | null };
/** 尺寸字段改的：一个边长，或者换单位时连同换算后的三个边长 */
type SizePatch = { length?: number | null; width?: number | null; height?: number | null; dimensionUnit?: DimensionUnit | null };

/** 一行采购的金额；按面积计价时尺寸或单价不全就是“待定”。 */
function purchaseLineMoney(l: PricedLine): string | null {
  return l.priceBasis === 'area' ? purchaseLineAmount(l) : lineMoney(l.quantity, l.unitPrice);
}

export function lineAmountText(l: PricedLine) {
  try {
    const v = purchaseLineMoney(l);
    return v ? displayAmount(v) + ' 元' : '金额待定';
  } catch {
    return '金额待定';
  }
}

export function purchaseTotalText(lines: readonly PricedLine[]) {
  try {
    const v = sumMoney(lines.map(purchaseLineMoney));
    return v ? displayAmount(v) + ' 元' : UNPRICED_TEXT;
  } catch {
    return '待完善明细';
  }
}

const sizeLabels: Record<DimensionKey, string> = { length: '长', width: '宽', height: '高' };
/** 改一个边长 */
const sizePatch = (k: DimensionKey, v: number | null): SizePatch =>
  k === 'length' ? { length: v } : k === 'width' ? { width: v } : { height: v };

/**
 * 长、宽（可选高）和尺寸单位，每个一格，放进编辑窗的网格里。
 * 切换 mm/cm 时按 1cm=10mm 换算；原单位不明时不换算（由 DimensionUnitSelect 先让人确认）。
 */
export function DimensionFields({
  value,
  change,
  disabled = false,
  height = true,
  prefix = '',
  saved,
  required = [],
}: {
  value: Sized;
  change: (patch: SizePatch) => void;
  disabled?: boolean;
  /** 纸板一般不填高，收进“更多”时传 false，另外单独放高 */
  height?: boolean;
  /** 一窗多行时区分输入框的读屏名称，例如“纸板1 ” */
  prefix?: string;
  /**
   * 打开窗口时已存的这一项（新建的传 null）。只有已存的尺寸单位没确认时，选单位才要先确认；
   * 刚填的数字本来就按所选单位理解，先填长再选毫米不弹确认窗（和产品编辑窗同一口径）。
   */
  saved?: Sized | null;
  /** 必填的几栏（采购明细按 shared/business 的 requiredPurchaseSize） */
  required?: readonly string[];
}) {
  const savedUnknown =
    saved === undefined
      ? dimensionKeys.some((k) => value[k] != null)
      : !!saved && !normalizeDimensionUnit(saved.dimensionUnit) && dimensionKeys.some((k) => saved[k] != null);
  const unit = value.dimensionUnit ? '（' + value.dimensionUnit + '）' : '';
  return (
    <>
      {dimensionKeys
        .filter((k) => height || k !== 'height')
        .map((k) => (
          <FormField key={k} label={sizeLabels[k] + unit} required={required.includes(k)}>
            <SizeInput
              value={value}
              k={k}
              change={change}
              disabled={disabled}
              label={prefix + sizeLabels[k]}
              required={required.includes(k)}
            />
          </FormField>
        ))}
      <FormField label="尺寸单位" hint={value.dimensionUnit ? undefined : '不确定先不选，不会换算'}>
        <span className="pur-unit-select">
          <DimensionUnitSelect
            unit={value.dimensionUnit}
            label={prefix + '尺寸单位'}
            hasValues={savedUnknown}
            disabled={disabled}
            onChange={(to) => {
              const from = normalizeDimensionUnit(value.dimensionUnit);
              const convert = (k: DimensionKey) => (from && to ? sizePatch(k, convertDimension(value[k] ?? null, from, to)) : {});
              change({ dimensionUnit: to, ...convert('length'), ...convert('width'), ...convert('height') });
            }}
          />
        </span>
      </FormField>
    </>
  );
}

export function SizeInput({
  value,
  k,
  change,
  disabled,
  label,
  required,
}: {
  value: Sized;
  k: DimensionKey;
  change: (patch: SizePatch) => void;
  disabled?: boolean;
  label: string;
  required?: boolean;
}) {
  return (
    <input
      type="number"
      required={required}
      step="any"
      min="0.0000001"
      max={value.dimensionUnit === 'cm' ? 1000 : 10000}
      aria-label={label}
      disabled={disabled}
      value={value[k] ?? ''}
      onChange={(e) => change(sizePatch(k, e.target.value === '' ? null : Number(e.target.value)))}
    />
  );
}
