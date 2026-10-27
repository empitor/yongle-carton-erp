import { dateSchema } from './domain.js';
import { arrivalSchema, sheetArea } from './physical-flow.js';
import {
  normalizeDimensionUnit,
  parseDimension,
  convertDimension,
  normalizedDimensions,
} from './product-details.js';
import { sumMoney } from './operations.js';
export const blankArrivalLine = () => ({
  stockId: null,
  purchaseLineId: null,
  item: {
    name: '',
    unit: '张',
    specification: '',
    material: '',
    flute: '',
    length: null,
    width: null,
    height: null,
    dimensionUnit: null,
    notes: '',
  },
  quantity: '',
  statedQuantity: null,
  unitPrice: null,
  priceBasis: 'area',
  statedArea: null,
  differenceReason: '',
});

export function recognizedArrivalDraft(source: any, suppliers: any[], existing?: any) {
  const result = source.result,
    warnings = new Set<string>(result.warnings || []);
  const matches = suppliers.filter(
    (s) => s.name.replace(/\s+/g, '') === String(result.supplierName || '').replace(/\s+/g, ''),
  );
  if (matches.length !== 1) warnings.add('供应商未唯一匹配，请人工选择档案。');
  const parsedDate = dateSchema.safeParse(result.date),
    date = parsedDate.success ? parsedDate.data : '';
  if (!date) warnings.add('原件未识别出有效到货日期，请填写，不会自动使用今天。');
  const lines = result.lines.map((line: any) => {
    const unit = String(line.unit || '').trim();
    if (unit !== '张')
      warnings.add(
        (line.name || '纸板') +
          ' 的原文数量单位为' +
          (line.unit || '未知') +
          '，请确认实际张数，系统未换算。',
      );
    const dimensionUnit = normalizeDimensionUnit(line.dimensionUnit);
    if (line.dimensionUnit && !dimensionUnit)
      warnings.add((line.name || '纸板') + ' 尺寸单位未确认：' + line.dimensionUnit);
    const dimension = (key: string) => {
      try {
        return parseDimension(line[key]);
      } catch {
        warnings.add((line.name || '纸板') + ' 尺寸待确认：' + line[key]);
        return null;
      }
    };
    return {
      stockId: null,
      purchaseLineId: null,
      item: {
        name: line.name || '',
        specification: line.specification || '',
        material: line.material || '',
        flute: line.flute || '',
        length: dimension('length'),
        width: dimension('width'),
        height: null,
        dimensionUnit,
        unit: '张',
        notes: line.notes || '',
      },
      quantity: unit === '张' ? line.quantity || '' : '',
      statedQuantity: unit === '张' ? line.quantity : null,
      statedArea: line.area ?? null,
      unitPrice: line.unitPrice ?? null,
      priceBasis: line.priceBasis ?? null,
      differenceReason: '',
    };
  });
  return {
    warnings: [...warnings],
    draft: {
      ...(existing?.status === 'draft' ? { id: existing.id, version: existing.version } : {}),
      supplierId: matches.length === 1 ? matches[0].id : null,
      date,
      reference: result.reference || '',
      sourceId: source.id,
      correctionOf: null,
      notes: [result.notes, result.purchaseNumber ? '原单采购号：' + result.purchaseNumber : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000),
      lines,
    },
  };
}
export function arrivalDraftIssues(draft: any): string[] {
  let parsed;
  try {
    parsed = arrivalSchema.safeParse(draft);
  } catch (e) {
    // 例如单位未识别导致数量为空时，数量校验会直接抛错；不能让它冒到 render
    // 阶段把整页卸载，只返回可核对提示。
    return [
      '到货草稿字段格式待修正：' +
        (e instanceof Error ? e.message : '请核对数量、单价、面积等字段'),
    ];
  }
  return parsed.success
    ? []
    : [
        ...new Set(
          parsed.error.issues.map((i) => {
            const labels: Record<string, string> = {
              supplierId: '供应商',
              date: '到货日期',
              reference: '送货单号',
              quantity: '实收数量',
              statedQuantity: '原文数量',
              unitPrice: '单价',
              priceBasis: '计价方式',
              statedArea: '原文面积',
              name: '纸板名称',
              material: '材质',
              flute: '楞型',
              specification: '规格',
              length: '长',
              width: '宽',
              height: '高',
              dimensionUnit: '尺寸单位',
              notes: '备注',
              differenceReason: '差异说明',
              stockId: '原材料档案',
              purchaseLineId: '采购明细',
              sourceId: '来源原件',
            };
            const field = i.path
              .map((key, index) =>
                typeof key === 'number'
                  ? `第${key + 1}行`
                  : key === 'lines' || key === 'item'
                    ? ''
                    : labels[String(key)] || String(key),
              )
              .filter(Boolean)
              .join(' · ');
            return (
              field +
              '：' +
              (i.message.startsWith('Invalid input') ? '请选择或填写有效资料' : i.message)
            );
          }),
        ),
      ];
}
export function arrivalTotals(lines: any[]) {
  let quantity = 0,
    unknownArea = 0;
  const areas: string[] = [];
  for (const line of lines) {
    if (/^\d+$/.test(String(line.quantity))) quantity += Number(line.quantity);
    let value: string | null = null;
    try {
      value = sheetArea(line.item, line.quantity);
    } catch {}
    if (value === null) unknownArea++;
    else areas.push(value);
  }
  return { quantity, area: (sumMoney(areas) || '0').replace(/\.?0+$/, '') || '0', unknownArea };
}
export function convertArrivalUnit(item: any, to: 'mm' | 'cm' | null) {
  const from = normalizeDimensionUnit(item.dimensionUnit);
  return {
    ...item,
    dimensionUnit: to,
    ...Object.fromEntries(
      ['length', 'width', 'height'].map((k) => [
        k,
        from && to ? convertDimension(item[k], from, to) : item[k],
      ]),
    ),
  };
}
export function matchingArrivalStock(item: any, candidate: any) {
  return (
    candidate.kind === 'raw' &&
    candidate.unit === '张' &&
    ['material', 'flute', 'specification'].every(
      (k) => String(item[k] || '') === String(candidate[k] || ''),
    ) &&
    (item.dimensionUnit && candidate.dimensionUnit
      ? JSON.stringify(normalizedDimensions(item)) ===
        JSON.stringify(normalizedDimensions(candidate))
      : JSON.stringify([item.length, item.width, item.height, item.dimensionUnit]) ===
        JSON.stringify([
          candidate.length,
          candidate.width,
          candidate.height,
          candidate.dimensionUnit,
        ]))
  );
}
