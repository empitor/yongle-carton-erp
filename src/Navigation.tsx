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
import {
  financePageIds,
  isFinancePage,
  pageHref,
  pageTitle,
  pagesInGroup,
  productionViews,
  warehouseViews,
  type PageGroup,
  type PageId,
} from '../shared/core/index';

type NavEntry = {
  page: PageId;
  label: string;
  href: string;
  icon: LucideIcon;
  /** 页面相同时按地址参数区分高亮；不带条件的入口按页面编号匹配。 */
  active?: (route: string) => boolean;
};

const pageIcons: Record<PageId, LucideIcon> = {
  dashboard: CalendarCheck,
  inbox: Inbox,
  'ai-import': FileUp,
  orders: ClipboardList,
  customers: Users,
  products: Package,
  purchases: ShoppingCart,
  suppliers: Building2,
  production: Factory,
  warehouse: Warehouse,
  finance: Landmark,
  'finance-flow': ListChecks,
  'finance-ar': HandCoins,
  'finance-cash': Wallet,
  'finance-costs': Receipt,
  'finance-ledger': BookOpen,
  'finance-reports': FileBarChart,
  'finance-settings': SlidersHorizontal,
  accounts: UserCog,
  'ai-settings': Settings,
  trash: Archive,
  guide: CircleHelp,
};
const productionIcons: Record<(typeof productionViews)[number]['id'], LucideIcon> = {
  task: Factory,
  production: CheckSquare,
};
const warehouseIcons: Record<(typeof warehouseViews)[number]['id'], LucideIcon> = {
  stock: Warehouse,
  arrivals: PackagePlus,
  deliveries: Truck,
  flow: ArrowLeftRight,
};

const pageEntry = (page: PageId): NavEntry => ({
  page,
  label: pageTitle(page),
  href: pageHref(page),
  icon: pageIcons[page],
});
const groupEntries = (group: PageGroup): NavEntry[] => pagesInGroup(group).map(pageEntry);

const groups: { title?: string; items: NavEntry[] }[] = [
  { items: groupEntries('工作台') },
  { title: '销售', items: groupEntries('销售') },
  { title: '采购', items: groupEntries('采购') },
  {
    title: '生产',
    items: productionViews.map((v) => ({
      page: 'production',
      label: v.label,
      href: v.href,
      icon: productionIcons[v.id],
      active: v.active,
    })),
  },
  {
    title: '仓储',
    items: warehouseViews.map((v) => ({
      page: 'warehouse',
      label: v.label,
      href: v.href,
      icon: warehouseIcons[v.id],
      active: v.active,
    })),
  },
];
/** 只给有财务权限的账号看。 */
const financeGroup: { title: string; items: NavEntry[] } = {
  title: '财务',
  items: financePageIds.map(pageEntry),
};
/** 有财务权限的业务账号：侧栏只放一个“财务”，进去用页签切换。 */
const financeEntry: NavEntry = { page: 'finance', label: '财务', href: pageHref('finance'), icon: Landmark };
/** 只给管理员看。 */
const accountsEntry: NavEntry = pageEntry('accounts');
const footer: NavEntry[] = pagesInGroup('系统')
  .filter((id) => id !== 'accounts')
  .map(pageEntry);

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
  const item = (entry: NavEntry) => {
    const selected =
      entry === financeEntry
        ? isFinancePage(page)
        : entry.page === page && (entry.active ? entry.active(route) : true);
    const Icon = entry.icon;
    return (
      <button
        key={entry.href}
        className={'erp-nav-item' + (selected ? ' selected' : '')}
        aria-current={selected ? 'page' : undefined}
        onClick={() => navigate(entry.href)}
      >
        <Icon size={16} />
        {entry.label}
        {entry.page === 'inbox' && inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}
        {entry.page === 'ai-import' && importCount > 0 && <span className="nav-count ai">{importCount}</span>}
        {entry.page === 'accounts' && accountRequests > 0 && <span className="nav-count">{accountRequests}</span>}
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
        <div className="nav-footer">{footer.filter((e) => e.page === 'guide').map(item)}</div>
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
        {footer.filter((e) => settings || e.page !== 'ai-settings').map(item)}
      </div>
    </>
  );
}
