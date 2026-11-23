import type { Customer } from '../../shared/core/index.js';
import type { Rows } from './schema/rows.js';

/** 客户、供应商的共用视图；采购库存再补归档和采购历史。 */
export function partyView(r: Rows['customers'] | Rows['suppliers']): Customer {
  return {
    id: r.id,
    name: r.name,
    contact: r.contact,
    phone: r.phone,
    address: r.address,
    notes: r.notes,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
