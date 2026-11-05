import { useEffect, useMemo, useRef, useState } from 'react';
import { managementRequest } from './session';

type Item = { group: string; label: string; hint?: string; target: string; keywords: string };
const actions: Item[] = [
  { group: '操作', label: '新建订单', target: 'orders?create=1', keywords: '新建 订单 下单' },
  { group: '操作', label: '新建采购单', target: 'purchases?create=1', keywords: '新建 采购 订货' },
  { group: '操作', label: '上传客户采购单', target: 'ai-import', keywords: '上传 导入 识别 收件箱' },
  {
    group: '操作',
    label: '今日送货',
    target: 'warehouse?deliveries=1&kind=finished',
    keywords: '送货 发货',
  },
  { group: '操作', label: '登记到货', target: 'warehouse?arrivals=1', keywords: '到货 收货 入库' },
];
const MAX_PER_GROUP = 8;

/** Ctrl+K：跨模块搜索单号、客户、产品和常用操作。打开时才读取数据。 */
export default function CommandPalette({ close }: { close: () => void }) {
  const [query, setQuery] = useState(''),
    [items, setItems] = useState<Item[]>(actions),
    [loading, setLoading] = useState(true),
    [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    let alive = true;
    Promise.all([
      managementRequest<any[]>('/orders'),
      managementRequest<any[]>('/customers'),
      managementRequest<any[]>('/products'),
      managementRequest<any[]>('/purchases'),
      managementRequest<any[]>('/suppliers'),
    ])
      .then(([orders, customers, products, purchases, suppliers]) => {
        if (!alive) return;
        setItems([
          ...actions,
          ...orders.map((o) => ({
            group: '订单',
            label: o.number,
            hint: o.customerName + ' · ' + o.status,
            target: 'orders?order=' + o.id,
            keywords: [
              o.number,
              o.customerName,
              o.externalPurchaseOrder,
              ...o.lines.map((l: any) => l.productName + ' ' + (l.customerProductCode || '')),
            ].join(' '),
          })),
          ...purchases.map((p) => ({
            group: '采购单',
            label: p.number,
            hint: p.supplierName + ' · ' + p.status,
            target: 'purchases?record=' + p.id,
            keywords: [p.number, p.supplierName, ...p.lines.map((l: any) => l.name)].join(' '),
          })),
          ...customers.map((c) => ({
            group: '客户',
            label: c.name,
            hint: c.contact || c.phone,
            target: 'customers?q=' + encodeURIComponent(c.name),
            keywords: [c.name, c.contact, c.phone, c.address].join(' '),
          })),
          ...products.map((p) => ({
            group: '产品',
            label: p.name,
            hint: [p.material, p.flute].filter(Boolean).join(' / '),
            target: 'products?q=' + encodeURIComponent(p.name),
            keywords: [p.name, p.material, p.flute, p.customerProductCode].join(' '),
          })),
          ...suppliers.map((s) => ({
            group: '供应商',
            label: s.name,
            hint: s.contact || s.phone,
            target: 'suppliers?q=' + encodeURIComponent(s.name),
            keywords: [s.name, s.contact, s.phone].join(' '),
          })),
        ]);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean),
      counts = new Map<string, number>();
    return items.filter((item) => {
      if (!terms.length && item.group !== '操作') return false;
      const text = (item.label + ' ' + item.keywords).toLowerCase();
      if (!terms.every((t) => text.includes(t))) return false;
      const n = counts.get(item.group) || 0;
      counts.set(item.group, n + 1);
      return n < MAX_PER_GROUP;
    });
  }, [items, query]);
  useEffect(() => setActive(0), [query]);
  const open = (item?: Item) => {
    if (!item) return;
    close();
    location.hash = item.target;
  };
  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <input
          ref={input}
          aria-label="搜索单号、客户、产品或操作"
          placeholder="搜索单号、客户、产品、PO，或输入“新建”"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') open(results[active]);
          }}
        />
        <div className="palette-list">
          {results.map((item, index) => (
            <div key={item.group + item.target}>
              {(index === 0 || results[index - 1].group !== item.group) && (
                <div className="palette-group">{item.group}</div>
              )}
              <button
                className={'palette-item' + (index === active ? ' active' : '')}
                onMouseEnter={() => setActive(index)}
                onClick={() => open(item)}
              >
                {item.label}
                {item.hint && <small>{item.hint}</small>}
              </button>
            </div>
          ))}
          {!results.length && (
            <div className="palette-empty">{loading ? '正在读取…' : '没有找到匹配的记录'}</div>
          )}
        </div>
      </section>
    </div>
  );
}
