import type { Store } from '../db.js';
import { accountCodeSchema } from '../../shared/finance.js';
import { financeError } from './core.js';

export function financeTemplate(store: Store, name: string) {
  const row = store.db.prepare('SELECT mapping FROM fin_templates WHERE name=?').get(name);
  if (!row) financeError('凭证模板不存在。', 409);
  const mapping = JSON.parse(String(row.mapping)) as Record<string, string>;
  return (field: string) => accountCodeSchema.parse(mapping[field]);
}
