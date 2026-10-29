import type { Store } from '../db.js';

// 排版差异用于精确匹配；相似键只用于产生候选，唯一候选才复用，不直接断言身份。
export const customerNameKey = (name: string) =>
  name.normalize('NFKC').replace(/\s/g, '').toLowerCase();
const similarKey = (name: string) =>
  customerNameKey(name)
    .replace(/有限责任公司|有限公司/g, '')
    .replace(/[()]/g, '');
const companySuffix = /(?:股份有限公司|有限责任公司|有限公司|公司|厂)$/;
const regionPrefixes = ['浙江省', '浙江', '宁波市', '宁波', '中国'] as const;
/** 只有去掉地区前缀和公司后缀后主体完全一致，才允许自动复用。 */
const companyCore = (name: string) => {
  let key = customerNameKey(name).replace(/[()]/g, '').replace(companySuffix, '');
  for (const prefix of regionPrefixes)
    if (key.startsWith(prefix) && key.length > prefix.length) {
      key = key.slice(prefix.length);
      break;
    }
  return key;
};
const sameCompanyCore = (a: string, b: string) => {
  const left = companyCore(a),
    right = companyCore(b);
  return !!left && left === right;
};

/**
 * 先按排版/历史订单精确匹配；没有精确匹配但只有一个相近候选时自动复用，
 * 避免同一客户因少写地区或公司后缀被重复建档；多个相近候选仍要求人工确认。
 */
export function resolveImportCustomer(
  store: Store,
  name: string,
  confirmedCustomerIds: number[] = [],
) {
  const all = store.customers(true),
    active = new Set(store.customers().map((c) => c.id));
  const key = customerNameKey(name);
  if (!key) return { state: 'new' as const, candidates: [] };
  const historyIds = new Set(
    store
      .orders(true)
      .filter((o) => customerNameKey(o.customerName) === key)
      .map((o) => o.customerId),
  );
  const exact = all.filter((c) => customerNameKey(c.name) === key || historyIds.has(c.id));
  const fuzzy = all.filter((c) => {
    const a = similarKey(c.name),
      b = similarKey(name);
    return !!a && !!b && (a.includes(b) || b.includes(a));
  });
  const safeFuzzy = fuzzy.filter((c) => sameCompanyCore(c.name, name));
  const proven = exact.length
    ? exact
    : safeFuzzy.length === 1
      ? safeFuzzy
      : fuzzy.filter((c) => confirmedCustomerIds.includes(c.id));
  const candidates = [
    ...new Map(
      [...exact, ...fuzzy].map((c) => [
        c.id,
        {
          id: c.id,
          name: c.name,
          contact: c.contact,
          phone: c.phone,
          address: c.address,
          archived: !active.has(c.id),
          reason: exact.some((x) => x.id === c.id)
            ? '名称排版一致或历史订单身份一致'
            : '名称相近，身份尚需核对',
        },
      ]),
    ).values(),
  ];
  if (proven.length === 1) {
    const customer = proven[0];
    return {
      state: active.has(customer.id) ? ('resolved' as const) : ('archived' as const),
      customer,
      candidates,
    };
  }
  return { state: candidates.length ? ('ambiguous' as const) : ('new' as const), candidates };
}
