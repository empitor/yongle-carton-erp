import {
  CalendarCheck,
  Inbox,
  ClipboardList,
  Users,
  Package,
  ShoppingCart,
  Building2,
  Factory,
  CheckSquare,
  Warehouse,
  PackagePlus,
  Truck,
  ArrowLeftRight,
  Settings,
  Archive,
  CircleHelp,
  type LucideIcon,
} from 'lucide-react';

type NavEntry = {
  label: string;
  target: string;
  icon: LucideIcon;
  /** 页面相同时用查询参数区分入口；不带条件的入口是该页的默认项。 */
  when?: (params: URLSearchParams) => boolean;
};
const groups: { title?: string; items: NavEntry[] }[] = [
  {
    items: [
      { label: '今日', target: 'dashboard', icon: CalendarCheck },
      { label: '收件箱', target: 'ai-import', icon: Inbox },
    ],
  },
  {
    title: '销售',
    items: [
      { label: '订单', target: 'orders', icon: ClipboardList },
      { label: '客户', target: 'customers', icon: Users },
      { label: '产品', target: 'products', icon: Package },
    ],
  },
  {
    title: '采购',
    items: [
      { label: '采购单', target: 'purchases', icon: ShoppingCart },
      { label: '供应商', target: 'suppliers', icon: Building2 },
    ],
  },
  {
    title: '生产',
    items: [
      {
        label: '生产任务',
        target: 'production',
        icon: Factory,
        when: (p) => p.get('view') !== 'production',
      },
      {
        label: '完工记录',
        target: 'production?view=production',
        icon: CheckSquare,
        when: (p) => p.get('view') === 'production',
      },
    ],
  },
  {
    title: '仓储',
    items: [
      {
        label: '库存',
        target: 'warehouse',
        icon: Warehouse,
        when: (p) =>
          !['arrivals', 'arrivalPlans', 'deliveries', 'deliveryPlans', 'flow'].some((k) => p.get(k) === '1'),
      },
      {
        label: '到货',
        target: 'warehouse?arrivals=1',
        icon: PackagePlus,
        when: (p) => p.get('arrivals') === '1' || p.get('arrivalPlans') === '1',
      },
      {
        label: '送货',
        target: 'warehouse?deliveries=1&kind=finished',
        icon: Truck,
        when: (p) => p.get('deliveries') === '1' || p.get('deliveryPlans') === '1',
      },
      {
        label: '流水',
        target: 'warehouse?flow=1',
        icon: ArrowLeftRight,
        when: (p) => p.get('flow') === '1',
      },
    ],
  },
];
const footer: NavEntry[] = [
  { label: '设置', target: 'ai-settings', icon: Settings },
  { label: '归档', target: 'trash', icon: Archive },
  { label: '使用说明', target: 'guide', icon: CircleHelp },
];

export default function Navigation({
  page,
  route = '',
  navigate,
  inboxCount = 0,
}: {
  page: string;
  route?: string;
  navigate: (target: string) => void;
  inboxCount?: number;
}) {
  const params = new URLSearchParams(route.split('?')[1] || '');
  const item = (entry: NavEntry) => {
    const selected =
      entry.target.split('?')[0] === page && (entry.when ? entry.when(params) : true);
    const Icon = entry.icon;
    return (
      <button
        key={entry.target}
        className={'erp-nav-item' + (selected ? ' selected' : '')}
        aria-current={selected ? 'page' : undefined}
        onClick={() => navigate(entry.target)}
      >
        <Icon size={16} />
        {entry.label}
        {entry.target === 'ai-import' && inboxCount > 0 && (
          <span className="nav-count">{inboxCount}</span>
        )}
      </button>
    );
  };
  return (
    <>
      <nav className="erp-nav" aria-label="主导航">
        {groups.map((group, index) => (
          <div className={group.title ? 'nav-section' : undefined} key={group.title || index}>
            {group.title && <div className="nav-section-title">{group.title}</div>}
            {group.items.map(item)}
          </div>
        ))}
      </nav>
      <div className="nav-footer">{footer.map(item)}</div>
    </>
  );
}
