import { DEFAULT_SITE_NAME, looseKey, type CustomerInput, type CustomerSite, type CustomerSiteInput } from '../../shared/core/index.js';
import { InputError, many, rows, type Store } from '../core/index.js';

/** 一批客户的厂区，一次查齐。非默认厂区保持建档顺序。 */
export function customerSites(store: Store, customerIds: readonly number[]) {
  const grouped = new Map<number, CustomerSite[]>();
  if (!customerIds.length) return grouped;
  const sites = many(
    store.db, rows.customer_sites,
    'SELECT * FROM customer_sites WHERE customer_id IN (SELECT value FROM json_each(?)) ORDER BY id',
    JSON.stringify(customerIds),
  );
  for (const r of sites) {
    const site = {
      id: r.id, name: r.name, contact: r.contact, phone: r.phone, address: r.address,
      isDefault: r.is_default === 1, notes: r.notes,
    };
    const list = grouped.get(r.customer_id);
    if (list) list.push(site);
    else grouped.set(r.customer_id, [site]);
  }
  return grouped;
}

/**
 * 新建客户的厂区：交了厂区用交的；没交或交了空的（数据管理、助手照模板交的就是空的），联系方式有一项不是空白就建默认厂区。
 * 只管新建；改客户时交空的是删光厂区，走 replaceCustomerSites。
 */
export function initialCustomerSites({ sites, contact, phone, address }: CustomerInput): CustomerSiteInput[] {
  if (sites?.length) return sites;
  return [contact, phone, address].some((v) => v.trim())
    ? [{ name: DEFAULT_SITE_NAME, contact, phone, address, notes: '', isDefault: true }]
    : [];
}

function validateSites(sites: CustomerSiteInput[], currentIds: Set<number>) {
  const ids = new Set<number>(), names = new Set<string>();
  for (const { id, name } of sites) {
    if (id !== undefined) {
      if (!currentIds.has(id)) throw new InputError('所选厂区不属于这个客户。');
      if (ids.has(id)) throw new InputError('同一厂区不能重复提交。');
      ids.add(id);
    }
    const key = looseKey(name);
    if (!key) throw new InputError('请填写厂区名称。');
    if (names.has(key)) throw new InputError('同一客户不能有重名厂区：' + name);
    names.add(key);
  }
  if (sites.length > 1 && sites.filter((s) => s.isDefault).length !== 1)
    throw new InputError('请为这个客户选择一个默认厂区。');
  return ids;
}

/** 调用方持有保存点。保留提交过来的厂区编号，允许在同一次保存里切换默认。 */
export function replaceCustomerSites(
  store: Store,
  customerId: number,
  sites: CustomerSiteInput[],
  at: string,
  beforeRemove?: (ids: number[]) => void,
) {
  const current = new Set(customerSites(store, [customerId]).get(customerId)?.map((s) => s.id));
  const ids = validateSites(sites, current);
  const removed = [...current].filter((id) => !ids.has(id));
  if (removed.length) {
    if (!beforeRemove) throw new Error('移除厂区前必须核对送货单引用。');
    beforeRemove(removed);
    store.db.prepare('DELETE FROM customer_sites WHERE customer_id=? AND id IN (SELECT value FROM json_each(?))')
      .run(customerId, JSON.stringify(removed));
  }
  if (current.size) {
    store.db.prepare('UPDATE customer_sites SET is_default=0 WHERE customer_id=? AND is_default=1').run(customerId);
  }
  const insert = store.db.prepare(
    'INSERT INTO customer_sites(customer_id,name,contact,phone,address,is_default,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
  );
  const update = store.db.prepare(
    'UPDATE customer_sites SET name=?,contact=?,phone=?,address=?,is_default=?,notes=?,updated_at=? WHERE id=?',
  );
  for (const s of sites) {
    const fields = [s.name, s.contact, s.phone, s.address, Number(sites.length === 1 || s.isDefault), s.notes];
    if (s.id === undefined) insert.run(customerId, ...fields, at, at);
    else update.run(...fields, at, s.id);
  }
}
