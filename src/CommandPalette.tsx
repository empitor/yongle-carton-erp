import { useEffect, useMemo, useRef, useState } from 'react';
import { readCatalog } from './recordkit/index';
import { useBackLayer, loadingText } from './ui/index';
import { catalogItems, searched, type PaletteItem as Item } from './palette-items';
/**
 * 顶栏“新建”菜单和这里的“操作”用同一份清单、同一套叫法。
 * financeOnly：纯财务账号不显示。都要业务编辑权限，只读账号不显示。
 */
export const createActions: { label: string; target: string; keywords: string }[] = [
  { label: '新建订单', target: 'orders?create=1', keywords: '新建 订单 下单' },
  { label: '新建采购单', target: 'purchases?create=1', keywords: '新建 采购 订货 订料' },
  { label: '安排生产', target: 'production?create=1', keywords: '安排 生产 任务 排产' },
  { label: 'AI 导入', target: 'ai-import', keywords: '上传 导入 识别 客户订单 送货单 唛头' },
];
const actions: Item[] = [
  ...createActions.map((a) => ({ group: '操作', ...a })),
  { group: '操作', label: '安排送货', target: 'warehouse?deliveries=1&kind=finished', keywords: '送货 发货 出库' },
  { group: '操作', label: '登记到货', target: 'warehouse?arrivals=1', keywords: '到货 收货 入库' },
];
const MAX_PER_GROUP = 8;

/** 当前账号能用的“操作”：新建、安排、登记都要业务编辑权限，只读账号一个都不给。 */
export const paletteActions = (canEdit: boolean): Item[] => (canEdit ? actions : []);

/** Ctrl+K：跨模块搜索单号、客户、产品和常用操作。打开时才读取数据。 */
export default function CommandPalette({ close, canEdit }: { close: () => void; canEdit: boolean }) {
  const [query, setQuery] = useState(''),
    [records, setRecords] = useState<Item[]>([]),
    [loading, setLoading] = useState(true),
    [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // 安卓 App 的返回键：和 Esc 一样关
  useBackLayer(close);
  // 操作在前、档案在后；操作跟着当前权限，档案只在打开时读一次
  const items = useMemo(() => [...paletteActions(canEdit), ...records], [canEdit, records]);
  useEffect(() => {
    input.current?.focus();
    let alive = true;
    readCatalog(searched)
      .then((lists) => {
        if (alive) setRecords(catalogItems(lists));
      })
      .catch(() => {
        // 档案没读到：面板照样能用操作，列表空着时写“没有找到匹配的记录”
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);  const results = useMemo(() => {
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
          placeholder={canEdit ? '搜索单号、客户、产品、PO，或输入“新建”' : '搜索单号、客户、产品、PO'}
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
            <div className="palette-empty">
              {loading ? loadingText() : query.trim() ? '没有找到匹配的记录' : '输入单号、客户或产品名称搜索'}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
