/**
 * 送货单、到货单的理论金额（按单据上的单价，不另加税）：逐行按单据上的数量和单价精确算，整张单子合计后四舍五入到分。
 * 经营概况的“送货金额”“到货金额”和财务的理论收入、理论支出都用这里，同一处算。
 * 算不出来的（缺数量、缺价格、单位换算不了）报出缺的是哪一样，不拿别的数顶替。
 */
import { CENTS_PER_YUAN, QUANTITY_DECIMALS, errorMessage, exactText, precisionTotal, quantityUnits, roundedQuotient } from '../core/index.js';
import { purchaseLineAmount, type SheetItem } from './operations.js';
import { MONEY_DECIMALS } from './limits.js';

/** 一行的金额：算出来是精确金额文字（元），算不出来是缺的那一样和原因 */
export type LineValue = { exact: string } | { lacking: 'quantity' | 'price'; message: string };

/** 送货单一行算金额要用的：数量、单位、单价 */
type DeliveryValueLine = { unit?: unknown; quantity?: unknown; unitPriceExact?: unknown };
/** 到货单一行算金额要用的：实际入库数量、纸板资料、单价和计价方式 */
type ArrivalValueLine = {
  stockedQuantity?: unknown;
  item?: SheetItem | null;
  /** 单价文字；老的财务快照里可能是数字 */
  unitPrice?: string | number | null;
  priceBasis?: string | null;
};
/** 报错原样当原因（中文）：单价、数量格式校验抛出的都是中文 */
const lack = (lacking: 'quantity' | 'price', message: string): LineValue => ({ lacking, message });

/** 送货的数量文字：整数部分，最多 QUANTITY_DECIMALS（三）位小数 */
const deliveryQuantityPattern = new RegExp(String.raw`^(\d+)(?:\.(\d{1,${QUANTITY_DECIMALS}}))?$`);

/** 送货一行：数量（最多三位小数）× 单价（最多四位小数），精确到七位小数 */
export function deliveryLineExact(quantity: string, unitPriceExact: string) {
  const q = deliveryQuantityPattern.exec(quantity);
  if (!q) throw new Error('数量单位无法换算。');
  const units = BigInt(q[1] + (q[2] ?? '').padEnd(QUANTITY_DECIMALS, '0'));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('数量超出可保存范围。');
  return exactText(precisionTotal([{ quantity: Number(units), unitPriceExact, unitPriceCents: 0 }]).units, MONEY_DECIMALS);
}

/** 送货单一行的金额 */
export function deliveryLineValue(line: DeliveryValueLine): LineValue {
  if (!line.unit) return lack('quantity', '数量单位无法换算。');
  try {
    quantityUnits(String(line.quantity));
  } catch (error) {
    return lack('quantity', errorMessage(error));
  }
  if (!line.unitPriceExact) return lack('price', '缺少送货价格。');
  try {
    return { exact: deliveryLineExact(String(line.quantity), String(line.unitPriceExact)) };
  } catch (error) {
    return lack('price', errorMessage(error));
  }
}

/** 到货单一行的金额：按实际入库数量和计价单位（按张或按面积）；入库 0 张的是 0 */
export function arrivalLineValue(line: ArrivalValueLine): LineValue {
  const stocked = line.stockedQuantity;
  if (stocked == null) return lack('quantity', '缺少实际入库数量。');
  let units: number;
  try {
    units = quantityUnits(String(stocked));
  } catch (error) {
    return lack('quantity', errorMessage(error));
  }
  if (units === 0) return { exact: '0' };
  const item = line.item;
  if (!item?.unit) return lack('quantity', '到货缺少计量单位。');
  if (line.unitPrice == null || !line.priceBasis) return lack('price', '缺少到货价格或计价单位。');
  let exact: string | null;
  try {
    exact = purchaseLineAmount({ ...item, quantity: String(stocked), unitPrice: String(line.unitPrice), priceBasis: line.priceBasis });
  } catch (error) {
    return lack('price', errorMessage(error));
  }
  // 按面积计价时规格缺尺寸，算不出面积：是数量（面积）的问题
  return exact === null ? lack('quantity', '到货数量单位无法换算。') : { exact };
}

/** 几行精确金额（非负的元）合计后四舍五入到分 */
export function exactSumCents(exacts: string[]) {
  const parts = exacts.map((value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error('金额格式无效：' + value);
    return { whole: match[1], fraction: match[2] ?? '' };
  });
  const scale = Math.max(0, ...parts.map((p) => p.fraction.length));
  const sum = parts.reduce((n, p) => n + BigInt(p.whole + p.fraction.padEnd(scale, '0')), 0n);
  const unit = 10n ** BigInt(scale);
  return Number(roundedQuotient(sum * CENTS_PER_YUAN, unit));
}

/** 一张送货单或到货单的理论金额（分）；有一行算不出来，整张就算不出来 */
export function documentValueCents(
  kind: 'delivery' | 'arrival',
  lines: readonly (DeliveryValueLine & ArrivalValueLine)[],
): { cents: number } | { lacking: 'quantity' | 'price' } {
  if (!lines.length) return { lacking: 'quantity' };
  const exacts: string[] = [];
  for (const line of lines) {
    const value = kind === 'delivery' ? deliveryLineValue(line) : arrivalLineValue(line);
    if ('lacking' in value) return { lacking: value.lacking };
    exacts.push(value.exact);
  }
  return { cents: exactSumCents(exacts) };
}
