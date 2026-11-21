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
  FileUp,
  Landmark,
  ListChecks,
  HandCoins,
  Wallet,
  Receipt,
  BookOpen,
  FileBarChart,
  SlidersHorizontal,
  UserCog,
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
      { label: '收件箱', target: 'inbox', icon: Inbox },
      { label: 'AI 导入', target: 'ai-import', icon: FileUp },
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
          !['arrivals', 'deliveries', 'flow'].some((k) => p.get(k) === '1'),
      },
      {
        label: '到货',
        target: 'warehouse?arrivals=1',
        icon: PackagePlus,
        when: (p) => p.get('arrivals') === '1',
      },
      {
        label: '送货',
        target: 'warehouse?deliveries=1&kind=finished',
        icon: Truck,
        when: (p) => p.get('deliveries') === '1',
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
/** 只给有财务权限的账号看。 */
const financeGroup: { title?: string; items: NavEntry[] } = {
  title: '财务',
  items: [
    { label: '财务概览', target: 'finance', icon: Landmark },
    { label: '月度台账', target: 'finance-flow', icon: ListChecks },
    { label: '应收应付', target: 'finance-ar', icon: HandCoins },
    { label: '资金发票', target: 'finance-cash', icon: Wallet },
    { label: '费用资产工资', target: 'finance-costs', icon: Receipt },
    { label: '凭证账簿', target: 'finance-ledger', icon: BookOpen },
    { label: '报表结账', target: 'finance-reports', icon: FileBarChart },
    { label: '财务设置', target: 'finance-settings', icon: SlidersHorizontal },
  ],
};
/** 有财务权限的业务账号：侧栏只放一个“财务”，进去用页签切换。 */
const financeEntry: NavEntry = { label: '财务', target: 'finance', icon: Landmark };
/** 只给管理员看。 */
const accountsEntry: NavEntry = { label: '账号管理', target: 'accounts', icon: UserCog };
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
  importCount = 0,
  finance = false,
  financeOnly = false,
  accounts = false,
  settings = false,
  accountRequests = 0,
}: {
  page: string;
  route?: string;
  navigate: (target: string) => void;
  inboxCount?: number;
  importCount?: number;
  finance?: boolean;
  /** 出纳这类纯财务账号：只显示财务和使用说明。 */
  financeOnly?: boolean;
  accounts?: boolean;
  /** 设置里有这个账号看得到的页签（app-shell.ts 的 settingsTabsOf）：只读账号没有 */
  settings?: boolean;
  accountRequests?: number;
}) {
  const params = new URLSearchParams(route.split('?')[1] || '');
  const item = (entry: NavEntry) => {
    const selected =
      entry === financeEntry
        ? page.startsWith('finance')
        : entry.target.split('?')[0] === page && (entry.when ? entry.when(params) : true);
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
        {entry.target === 'inbox' && inboxCount > 0 && (
          <span className="nav-count">{inboxCount}</span>
        )}
        {entry.target === 'ai-import' && importCount > 0 && (
          <span className="nav-count ai">{importCount}</span>
        )}
        {entry.target === 'accounts' && accountRequests > 0 && (
          <span className="nav-count">{accountRequests}</span>
        )}
      </button>
    );
  };
  if (financeOnly)
    return (
      <>
        <nav className="erp-nav" aria-label="主导航">
          <div className="nav-section">
            <div className="nav-section-title">{financeGroup.title}</div>
            {financeGroup.items.map(item)}
          </div>
        </nav>
        <div className="nav-footer">{footer.filter((e) => e.target === 'guide').map(item)}</div>
      </>
    );
  return (
    <>
      <nav className="erp-nav" aria-label="主导航">
        {groups.map((group, index) => (
          <div className={group.title ? 'nav-section' : undefined} key={group.title || index}>
            {group.title && <div className="nav-section-title">{group.title}</div>}
            {group.items.map(item)}
          </div>
        ))}
        {/* 财务在侧栏只占一个入口，8 个页面在财务页顶部的页签里切换：侧栏不用滚动，当前页一直看得到 */}
        {finance && <div className="nav-section">{item(financeEntry)}</div>}
      </nav>
      <div className="nav-footer">
        {accounts && item(accountsEntry)}
        {footer.filter((e) => settings || e.target !== 'ai-settings').map(item)}
      </div>
    </>
  );
}
