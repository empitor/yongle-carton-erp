import { quantityString, quantityUnits } from '../../shared/core/index';

/** 领用减退料，按千分整数算，不出浮点尾差；读不出来写“—”。 */
export function netQuantity(issued: string, returned: string) {
  try {
    return quantityString(quantityUnits(String(issued || '0')) - quantityUnits(String(returned || '0')));
  } catch {
    return '—';
  }
}
