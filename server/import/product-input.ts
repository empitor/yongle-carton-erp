import type { DraftField, LineField } from '../../shared/import/index.js';
import { parseDimension, normalizeDimensionUnit } from '../../shared/core/index.js';
export function productFieldsFromDraft(f: Record<LineField, DraftField>) {
  const raw = f.dimensionUnit.value?.trim() || '',
    dimensionUnit = normalizeDimensionUnit(raw);
  return {
    name: f.productName.value || '',
    length: parseDimension(f.length.value),
    width: parseDimension(f.width.value),
    height: parseDimension(f.height.value),
    dimensionUnit,
    dimensionUnitRaw: dimensionUnit ? '' : raw,
    material: f.material.value || '',
    flute: f.flute.value || '',
    requirements: f.requirements.value || '',
    customerProductCode: f.productCode.value || '',
  };
}
