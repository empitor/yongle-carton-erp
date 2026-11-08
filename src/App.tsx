import { api } from './app-api';
import CustomerEditor from './editors/CustomerEditor';
import ProductEditor from './editors/ProductEditor';
import OrderEditor from './editors/OrderEditor';
import { importStillOpen } from '../shared/order-draft';
import { APP_VERSION } from '../shared/version';
import { erpPageIds, normalizeAiSettingsHash } from '../shared/assistant-navigation';
import { warehouseDeliveryHash } from '../shared/warehouse-delivery';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Plus,
  ArrowUpRight,
  Menu,
  Search,
  Check,
  RefreshCw,
  FileUp,
  ShieldCheck,
  Bot,
} from 'lucide-react';
import AuthPanel from './AuthPanel';
import BrandLogo from './ui/BrandLogo';
import LoginScreen, { ForcedPasswordChange } from './LoginScreen';
import ThemeSwitcher from './ThemeSwitcher';
import {
  type ListResult,
  orderMetrics,
  productMetrics,
  productIncomplete,
} from '../shared/business-metrics';
import {
  PageHeading,
  ListFilters,
  FilterField,
  ListSummary,
  useResettingPage,
} from './ui/ListLayout';
import DateRangeFilter from './DateRangeFilter';
import DashboardPage from './DashboardPage';
import { presetRange, monthsBefore, type DatePreset, type OrderView } from '../shared/date-ranges';
import { useAuthState } from './session';
import BusinessRecords from './BusinessRecords';
import Navigation from './Navigation';
import { MobileSubNav, MobileTabBar, useMobileTables } from './mobile/MobileNav';
import { uiCapabilities } from '../shared/ui-capabilities';
import { warehouseArrivalHash } from '../shared/arrival-navigation';
import CommandPalette from './CommandPalette';
import type { RecordEntity } from '../shared/operations';
import InboxPage from './InboxPage';

// 大页面按需加载，首屏只下载用到的部分。
const FinancePages = lazy(() => import('./finance/FinancePages'));
const AiSettingsHub = lazy(() => import('./AiSettingsHub'));
const AccountManagement = lazy(() => import('./AccountManagement'));
const OperationsPage = lazy(() => import('./OperationsPage'));
const FlowPage = lazy(() => import('./FlowPage'));
const GlobalAssistant = lazy(() => import('./GlobalAssistant'));
const OrderImportPage = lazy(() => import('./OrderImportPage'));

import { PAGE_SIZE } from './BusinessRecords';
import type { RecordSort } from '../shared/record-sort';

import {
  displayOrderStatuses,
  today,
  type Customer,
  type Product,
  type Order,
  type Dashboard,
} from '../shared/domain';

function readListFilters() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const view: OrderView =
    params.get('view') === 'history'
      ? 'history'
      : params.get('view') === 'pending'
        ? 'pending'
        : 'current';
  const raw = params.get('range') || (view === 'current' ? '2' : 'all');
  const preset: DatePreset = ['1', '2', '3', 'all', 'custom'].includes(raw)
    ? (raw as DatePreset)
    : '2';
  const range = presetRange(preset);
  return {
    view,
    preset,
    start: preset === 'custom' ? params.get('start') || '' : range.start,
    end: preset === 'custom' ? params.get('end') || '' : range.end,
    status: params.get('status') || '',
    customerId: params.get('customerId') || '',
  };
}
type Page =
  | 'document-templates'
  | 'dashboard'
  | 'orders'
  | 'customers'
  | 'products'
  | 'guide'
  | 'ai-plugins'
  | 'ai-settings'
  | 'ai-import'
  | 'inbox'
  | 'accounts'
  | 'ai-prompts'
  | 'trash'
  | 'suppliers'
  | 'purchases'
  | 'warehouse'
  | 'arrivals'
  | 'production'
  | 'finance'
  | 'finance-flow'
  | 'finance-ar'
  | 'finance-cash'
  | 'finance-costs'
  | 'finance-ledger'
  | 'finance-reports'
  | 'finance-settings';
type Editor =
  | { kind: 'customers'; value?: Customer }
  | { kind: 'products'; value?: Product }
  | { kind: 'orders'; value?: Order; inboxId?: number }
  | { kind: 'suppliers'; value?: Customer }
  | null;

export default function App() {
  const session = useAuthState();
  // 还没改掉临时密码时当作未登录，下面的数据加载都不会发起。
  const passwordLocked = !!session?.actor?.mustChangePassword;
  const auth = passwordLocked ? { ...session!, actor: null } : session,
    superMode = !!auth?.actor?.superAdminMode;
  // 另一个标签页切换了账号：这里的页面和表单还是上一个账号的，重新加载。
  const shownActor = useRef<string | null>(null);
  useEffect(() => {
    const id = auth?.actor?.id || null;
    if (shownActor.current && id && id !== shownActor.current) location.reload();
    if (id) shownActor.current = id;
  }, [auth?.actor?.id]);
  useMobileTables();
  const [allRecordsView, setAllRecordsView] = useState(false),
    [trashEntity, setTrashEntity] = useState<RecordEntity>('orders');
  const [flowTrash, setFlowTrash] = useState<null | 'arrival' | 'task' | 'production' | 'delivery'>(
    null,
  );
  const validPages: Page[] = erpPageIds;
  const getPage = () => {
    const normalized = normalizeAiSettingsHash(
      warehouseArrivalHash(warehouseDeliveryHash(location.hash)),
    );
    if (normalized !== location.hash) history.replaceState(null, '', normalized);
    return location.hash.split('?')[0] === '#ai-prompts'
      ? 'ai-settings'
      : validPages.includes(location.hash.slice(1).split('?')[0] as Page)
        ? (location.hash.slice(1).split('?')[0] as Page)
        : 'dashboard';
  };
  const [page, setPage] = useState<Page>(getPage),
    [routeKey, setRouteKey] = useState(location.hash),
    [customers, setCustomers] = useState<Customer[]>([]),
    [products, setProducts] = useState<Product[]>([]),
    [orders, setOrders] = useState<Order[]>([]),
    [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [editor, setEditor] = useState<Editor>(null),
    [search, setSearch] = useState(''),
    [customerId, setCustomerId] = useState(() => readListFilters().customerId),
    [status, setStatus] = useState(() => readListFilters().status),
    [start, setStart] = useState(() => readListFilters().start),
    [end, setEnd] = useState(() => readListFilters().end),
    [revision, setRevision] = useState(0),
    [menu, setMenu] = useState(false);
  const [productAttention, setProductAttention] = useState(false);
  const [palette, setPalette] = useState(false),
    [newMenu, setNewMenu] = useState(false),
    newMenuRef = useRef<HTMLDivElement>(null),
    [inboxCount, setInboxCount] = useState(0),
    [importCount, setImportCount] = useState(0);
  const canCreate =
    !!auth?.actor && (superMode || auth.actor.permissions.includes('business:edit'));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!newMenu) return;
    const outside = (e: PointerEvent) => {
      if (!newMenuRef.current?.contains(e.target as Node)) setNewMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNewMenu(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [newMenu]);
  useEffect(() => {
    if (!auth?.actor) return;
    const load = () => {
      fetch('/api/ai/imports', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (s?.workspaces) setImportCount(s.workspaces.filter(importStillOpen).length);
        })
        .catch(() => {});
      api<any>('/inbox?page=1&pageSize=1')
        .then((v) => setInboxCount(v.counts?.pending || 0))
        .catch(() => {});
    };
    void load();
    window.addEventListener('erp-business-changed', load);
    const timer = setInterval(load, 60000);
    return () => {
      window.removeEventListener('erp-business-changed', load);
      clearInterval(timer);
    };
  }, [auth?.actor?.id]);
  const [listMetrics, setListMetrics] = useState({
    customersTotal: 0,
    productsTotal: 0,
    ordersTotal: 0,
    ordersFiltered: 0,
    ordersPage: 1,
    orders: orderMetrics([]),
    products: productMetrics([]),
  });
  const [datePreset, setDatePreset] = useState<DatePreset>(() => readListFilters().preset);
  const [orderView, setOrderView] = useState<OrderView>(() => readListFilters().view);
  const [archivedView, setArchivedView] = useState(
    () => new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1',
  );
  // 切换页面时关闭上一页的编辑窗并回到顶部；必须排在下面的 create=1 之前，否则会关掉刚打开的新建窗。
  useEffect(() => {
    setEditor(null);
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    const params = new URLSearchParams(routeKey.split('?')[1] || '');
    if (page === 'orders' && params.get('create') === '1')
      setEditor({ kind: 'orders', inboxId: Number(params.get('inbox')) || undefined });
  }, [page, routeKey]);
  useEffect(() => {
    const f = () => {
      setRouteKey(location.hash);
      setPage(getPage());
      setArchivedView(
        new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1',
      );
      const filters = readListFilters();
      setDatePreset(filters.preset);
      setStart(filters.start);
      setEnd(filters.end);
      setOrderView(filters.view);
      setStatus(filters.status);
      setCustomerId(filters.customerId);
      setAllRecordsView(false);
      setSearch(new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '');
      setProductAttention(false);
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    const changed = () => {
      setRevision((v) => v + 1);
      setEditor((current) => {
        if (current?.value?.id && ['orders', 'customers', 'products'].includes(current.kind)) {
          const kind = current.kind,
            id = current.value.id;
          void api<any>('/' + kind + '/' + id)
            .then((value) =>
              setEditor((latest) =>
                latest?.kind === kind && latest.value?.id === id
                  ? ({ ...latest, value } as Editor)
                  : latest,
              ),
            )
            .catch(() => {});
        }
        return current;
      });
    };
    window.addEventListener('erp-business-changed', changed);
    return () => window.removeEventListener('erp-business-changed', changed);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);
  const [orderSort, setOrderSort] = useState<RecordSort>('recent');
  // 筛选范围变化回第一页；统计也只在范围变化时才需要等待。
  const orderSignature = [
    page,
    search,
    customerId,
    status,
    start,
    end,
    orderView,
    archivedView,
    allRecordsView,
  ].join('|');
  const [orderPage, setOrderPage] = useResettingPage(orderSignature + '|' + orderSort);
  const loadedSignature = useRef('');
  useEffect(() => {
    if (!auth?.actor) return;
    if (
      page === 'ai-plugins' ||
      page === 'ai-settings' ||
      page === 'ai-import' ||
      page === 'inbox' ||
      page === 'accounts' ||
      page === 'ai-prompts' ||
      page === 'document-templates' ||
      page.startsWith('finance') ||
      ['suppliers', 'purchases', 'warehouse'].includes(page) ||
      (page === 'trash' && ['suppliers', 'purchases', 'stock_items'].includes(trashEntity))
    ) {
      setBusy(false);
      setError('');
      return;
    }
    let active = true;
    setBusy(true);
    setError('');
    const query = new URLSearchParams();
    if (customerId) query.set('customerId', customerId);
    if (archivedView && page === 'orders') query.set('archived', '1');
    if (superMode && allRecordsView && page === 'orders') query.set('archived', 'all');
    if (page === 'trash') query.set('archived', '1');
    if (status && page === 'orders') query.set('status', status);
    if (start) query.set('start', start);
    if (end) query.set('end', end);
    if (search && page === 'orders') query.set('q', search);
    if (page === 'orders' && !archivedView && !(superMode && allRecordsView)) {
      query.set('view', orderView);
      if (orderView === 'current' && ['1', '2', '3'].includes(datePreset))
        query.set('retainPending', '1');
    }
    if (page === 'orders' && (archivedView || (superMode && allRecordsView))) {
      query.delete('start');
      query.delete('end');
    }
    if (page === 'trash')
      for (const key of ['customerId', 'start', 'end', 'status', 'q']) query.delete(key);
    query.set('withMetrics', '1');
    if (page === 'orders') {
      query.set('page', String(orderPage));
      query.set('pageSize', String(PAGE_SIZE));
      query.set('sort', orderSort);
    }
    const customerQuery = new URLSearchParams({ withMetrics: '1' }),
      productQuery = new URLSearchParams({ withMetrics: '1' });
    if (superMode && (page !== 'customers' || allRecordsView)) customerQuery.set('archived', 'all');
    else if (page === 'trash' || (page === 'customers' && archivedView))
      customerQuery.set('archived', '1');
    if (superMode && (page !== 'products' || allRecordsView)) productQuery.set('archived', 'all');
    else if (page === 'trash' || (page === 'products' && archivedView))
      productQuery.set('archived', '1');
    if (page === 'customers' && search) customerQuery.set('q', search);
    if (page === 'products') {
      if (search) productQuery.set('q', search);
      if (productAttention) productQuery.set('incomplete', '1');
    }
    const timer = setTimeout(
      () =>
        // 每页只读自己需要的数据。订单页和归档页要客户、产品供筛选和编辑窗使用。
        Promise.all([
          ['customers', 'orders', 'trash'].includes(page)
            ? api<ListResult<Customer, null>>('/customers?' + customerQuery)
            : null,
          ['products', 'orders', 'trash'].includes(page)
            ? api<ListResult<Product, ReturnType<typeof productMetrics>>>('/products?' + productQuery)
            : null,
          ['orders', 'trash'].includes(page)
            ? api<ListResult<Order, ReturnType<typeof orderMetrics>>>('/orders?' + query)
            : null,
          page === 'dashboard' ? api<Dashboard>('/dashboard?' + query) : null,
        ])
          .then(([c, p, o, d]) => {
            if (!active) return;
            if (c) setCustomers(c.rows);
            if (p) setProducts(p.rows);
            if (o) setOrders(o.rows);
            if (o) loadedSignature.current = orderSignature;
            if (d) setDashboard(d);
            setListMetrics((m) => ({
              customersTotal: c ? c.totalRecords : m.customersTotal,
              productsTotal: p ? p.totalRecords : m.productsTotal,
              ordersTotal: o ? o.totalRecords : m.ordersTotal,
              ordersFiltered: o ? o.filteredRecords : m.ordersFiltered,
              ordersPage: o ? (o.page ?? 1) : m.ordersPage,
              orders: o ? o.metrics : m.orders,
              products: p ? p.metrics : m.products,
            }));
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setBusy(false);
          }),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    revision,
    productAttention,
    datePreset,
    orderView,
    customerId,
    status,
    start,
    end,
    search,
    page,
    archivedView,
    allRecordsView,
    superMode,
    trashEntity,
    auth?.actor?.id,
    orderPage,
    orderSort,
  ]);
  useEffect(() => {
    if (!superMode) setAllRecordsView(false);
  }, [superMode]);

  // 翻页和换排序不改变筛选范围，统计数字不用闪成占位符。
  const metricsPending = busy && loadedSignature.current !== orderSignature;
  const navigate = (v: Page) => {
    location.hash = v;
    setMenu(false);
  };
  const closeEditor = () => setEditor(null);
  const saved = () => {
    window.dispatchEvent(new Event('erp-business-changed'));
    setEditor(null);
    setRevision((v) => v + 1);
    setNotice('已保存到本机数据库');
  };
  const names: Record<Page, string> = {
    dashboard: '今日',
    orders: '订单',
    customers: '客户',
    products: '产品',
    guide: '使用说明',
    accounts: '账号管理',
    finance: '财务概览',
    'finance-flow': '月度台账',
    'finance-ar': '应收应付',
    'finance-cash': '资金发票',
    'finance-costs': '费用资产工资',
    'finance-ledger': '凭证账簿',
    'finance-reports': '报表结账',
    'finance-settings': '财务设置',
    'ai-plugins': 'AI 插件',
    'ai-settings': '设置',
    'ai-import': 'AI 导入',
    inbox: '收件箱',
    'ai-prompts': 'AI 识别提示词',
    trash: '归档记录',
    suppliers: '供应商',
    purchases: '采购单',
    warehouse: '仓储',
    'document-templates': '单据模板',
    arrivals: '采购到货',
    production: '生产管理',
  };
  const visibleRecord = (r: any) =>
    page === 'trash'
      ? !!r.archived
      : superMode && allRecordsView
        ? true
        : !!r.archived === archivedView;
  const customerRows = customers.filter(
    (c) =>
      visibleRecord(c) &&
      [c.name, c.contact, c.phone, c.address, c.notes]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const productRows = products.filter(
    (p) =>
      visibleRecord(p) &&
      (!productAttention || productIncomplete(p)) &&
      [p.name, p.material, p.flute, p.requirements]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const reset = () => {
    setProductAttention(false);
    setSearch('');
    setCustomerId('');
    setStatus('');
    const range = presetRange(orderView === 'current' ? '2' : 'all');
    setDatePreset(orderView === 'current' ? '2' : 'all');
    setStart(range.start);
    setEnd(range.end);
  };

  if (!auth) return <div className="login-screen" />;
  if (passwordLocked) return <ForcedPasswordChange name={session!.actor!.name} />;
  if (!auth.actor) return <LoginScreen auth={auth} />;
  return (
    <div className="shell">
      <aside className={menu ? 'sidebar open' : 'sidebar'}>
        <a className="brand" href="#dashboard" title="宁波甬勒包装制品有限公司">
          <BrandLogo size={28} />
          <span className="brand-name">甬勒包装</span>
        </a>
        <Navigation
          page={page}
          route={routeKey}
          navigate={(target) => navigate(target as Page)}
          inboxCount={inboxCount}
          importCount={importCount}
          finance={!!auth?.actor?.permissions.includes('finance:view')}
          accounts={auth.actor.role === 'super_admin'}
          accountRequests={auth.pendingRequests || 0}
        />
      </aside>
      {menu && <div className="mobile-backdrop" onClick={() => setMenu(false)} />}
      <div className="main">
        <header className="topbar">
          <div>
            <button
              className="mobile-menu icon-button"
              aria-label="切换导航"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
              {inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}
            </button>
            <button
              className="top-search"
              aria-label="全局搜索（Ctrl+K）"
              onClick={() => setPalette(true)}
            >
              <Search size={14} />
              搜索单号、客户、产品…
              <kbd>Ctrl K</kbd>
            </button>
          </div>
          <div className="topbar-right">
            <div className="top-new" ref={newMenuRef}>
              <button
                aria-haspopup="menu"
                aria-expanded={newMenu}
                disabled={!canCreate}
                onClick={() => setNewMenu((v) => !v)}
              >
                <Plus size={15} />
                新建
              </button>
              {newMenu && (
                <div className="top-new-menu" role="menu" onClick={() => setNewMenu(false)}>
                  <a role="menuitem" href="#orders?create=1">
                    订单
                  </a>
                  <a role="menuitem" href="#purchases?create=1">
                    采购单
                  </a>
                  <a role="menuitem" href="#ai-import">
                    AI 导入单据
                  </a>
                  <a role="menuitem" href="#production?create=1">
                    生产任务
                  </a>
                </div>
              )}
            </div>
            <button
              className="assistant-topbar-button"
              aria-label="打开全局AI助手"
              aria-haspopup="dialog"
              title="AI助手（Ctrl+J）"
              onClick={() => window.dispatchEvent(new Event('erp-open-assistant'))}
            >
              <Bot size={16} />
              AI助手
            </button>
            <ThemeSwitcher />
            <AuthPanel />
          </div>
        </header>
        <main className={page === 'ai-import' ? 'import-main' : ''}>
          <MobileSubNav page={page} route={routeKey} navigate={(target) => navigate(target as Page)} />
          <Suspense fallback={<p role="status">正在打开页面…</p>}>
          {superMode && !auth?.actor?.localAdministrator && (
            <div className="super-mode-banner" role="status">
              <ShieldCheck size={19} />
              <div>
                <strong>超级管理员模式已开启</strong>
                <span>
                  可编辑历史和归档记录；永久删除仍需逐次核对影响范围并验证密码。有效至
                  {new Date(auth!.actor!.superAdminUntil!).toLocaleTimeString('zh-CN')}。
                </span>
              </div>
            </div>
          )}
          {!page.startsWith('finance') &&
            ![
            'suppliers',
            'purchases',
            'warehouse',
            'arrivals',
            'production',
            'document-templates',
            'inbox',
            'accounts',
          ].includes(page) && (
            <>
              <PageHeading
                title={names[page]}
                meta={
                  <>
              {page === 'orders' && !error && (
                <ListSummary
                  items={[
                    {
                      label: '订单总数',
                      value: metricsPending ? '—' : listMetrics.orders.total,
                      hint: '当前筛选范围',
                    },
                    {
                      label: '待完成订单',
                      value: metricsPending ? '—' : listMetrics.orders.pending,
                      hint: '已确认、生产中、待发货',
                    },
                    {
                      label: '逾期未完成订单',
                      value: metricsPending ? '—' : listMetrics.orders.overdue,
                      hint: '交货日期早于今天且未交付',
                    },
                  ]}
                />
              )}
              {page === 'products' && !error && (
                <ListSummary
                  items={[
                    {
                      label: '产品总数',
                      value: busy ? '—' : listMetrics.products.total,
                      hint: '当前档案范围及关键词',
                    },
                    {
                      label: '已启用产品',
                      value: busy ? '—' : listMetrics.products.enabled,
                      hint: '未停用/归档的产品',
                    },
                    {
                      label: '档案待完善',
                      value: busy ? '—' : listMetrics.products.incomplete,
                      hint: '点击筛选；仅提醒，不阻止导入',
                      onClick: () => setProductAttention((v) => !v),
                      active: productAttention,
                    },
                  ]}
                />
              )}
                  </>
                }
                description={
                  <>
                    {page === 'dashboard'
                      ? '采购、生产、库存和送货，从待办直接进入下一步。'
                      : page === 'orders'
                        ? '从接单到发货，记录每一项约定。'
                        : page === 'customers'
                          ? '集中维护客户资料，让业务往来更清晰。'
                          : page === 'products'
                            ? '沉淀纸箱规格，下单时快速引用。'
                            : page === 'ai-settings'
                              ? '维护API、提示词、工具与正式单据模板。'
                              : page === 'ai-prompts'
                                ? '按客户或订单格式保存识别规则，调整条目顺序并随时切换。'
                                : page === 'ai-import'
                                  ? '上传原件，识别草稿，聊天修改并人工核对。'
                                  : page === 'purchases'
                                    ? '外购纸板订货、分批到货与原材料入库。'
                                    : page === 'suppliers'
                                      ? '维护纸板供应商，保留每次采购往来。'
                                      : page === 'warehouse'
                                        ? '原材料与成品分开记账，每一笔出入都有来源。'
                                        : page === 'guide'
                                          ? '日常业务入口和操作顺序。'
                                          : ''}
                  </>
                }
                actions={
                  ['orders', 'customers', 'products'].includes(page) ? (
                    <>
                      {page === 'orders' && (
                        <button onClick={() => navigate('ai-import')}>
                          <FileUp size={16} />
                          AI 导入
                        </button>
                      )}
                      <button disabled={busy} onClick={() => setRevision((v) => v + 1)}>
                        <RefreshCw size={15} aria-hidden="true" />
                        <span className="sr-only">刷新</span>
                      </button>
                      {page !== 'dashboard' && (
                        <button
                          className="primary"
                          disabled={
                            busy ||
                            !!error ||
                            !auth?.actor ||
                            (!superMode && !auth.actor.permissions.includes('business:edit'))
                          }
                          onClick={() =>
                            setEditor({
                              kind:
                                page === 'customers'
                                  ? 'customers'
                                  : page === 'products'
                                    ? 'products'
                                    : 'orders',
                            })
                          }
                        >
                          <Plus size={17} />
                          {page === 'customers'
                            ? '新增客户'
                            : page === 'products'
                              ? '新增产品'
                              : '新建订单'}
                        </button>
                      )}
                    </>
                  ) : undefined
                }
              />
            </>
          )}
          {notice && (
            <div className="toast" role="status">
              <Check size={18} />
              {notice}
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setRevision((v) => v + 1)}>
                <RefreshCw size={14} />
                重新加载
              </button>
            </div>
          )}
          {(page === 'ai-settings' || page === 'ai-prompts') && <AiSettingsHub />}
          {page === 'ai-import' && <OrderImportPage />}
          {page === 'inbox' && <InboxPage />}
          {page === 'accounts' && (
            <AccountManagement
              selfId={auth.actor.id}
              isAdmin={auth.actor.role === 'super_admin'}
              pending={auth.pendingRequests || 0}
            />
          )}
          {page.startsWith('finance') &&
            (auth?.actor?.permissions.includes('finance:view') ? (
              <FinancePages page={page} />
            ) : (
              <div className="error" role="alert">
                当前账号没有财务权限。需要的话请找管理员在“账号管理”里调整。
              </div>
            ))}
          {['orders', 'customers', 'products'].includes(page) && (
            <>
              <ListFilters
                search={search}
                onSearch={setSearch}
                searchLabel={page === 'orders' ? '搜索订单' : '搜索档案'}
                placeholder={
                  page === 'orders'
                    ? '搜索订单号、客户、产品'
                    : page === 'customers'
                      ? '搜索客户、联系人、电话、地址或备注'
                      : '搜索产品名称、材质、楞型、加工要求'
                }
                dates={
                  page === 'orders' && !archivedView && !allRecordsView ? (
                    <DateRangeFilter
                      preset={datePreset}
                      start={start}
                      end={end}
                      change={(preset, start, end) => {
                        setDatePreset(preset);
                        setStart(start);
                        setEnd(end);
                      }}
                    />
                  ) : undefined
                }
                onReset={reset}
                busy={busy}
                note={
                  page === 'orders'
                    ? archivedView || allRecordsView
                      ? '当前显示归档或全部记录，不应用日期分类。'
                      : orderView === 'history'
                        ? `历史归档：下单日期早于 ${monthsBefore(today(), 2)} 的已发货/已取消订单。只作日期分类，不改变归档状态。`
                        : orderView === 'pending'
                          ? '待处理包含草稿、已确认、生产中、待发货；默认不限日期。'
                          : '按下单日期，含首尾当天；快捷范围保留更早未完成订单，自定义范围严格筛选。历史归档仅作日期分类；手工归档可恢复，删除实际移除数据。'
                    : page === 'customers'
                      ? '支持客户名称、联系人、电话、地址与备注查询。'
                      : '产品名称、材质、楞型和加工要求可组合关键词搜索。'
                }
              >
          {page === 'orders' && (
            <div className="order-view-controls">
              <div className="record-view-tabs" aria-label="订单日期分类">
                {(
                  [
                    ['current', '近期与待处理'],
                    ['pending', '全部待处理'],
                    ['history', '历史归档'],
                  ] as const
                ).map(([view, label]) => (
                  <button
                    key={view}
                    className={
                      orderView === view && !archivedView && !allRecordsView ? 'selected' : ''
                    }
                    onClick={() => {
                      setOrderView(view);
                      setArchivedView(false);
                      setAllRecordsView(false);
                      const preset = view === 'current' ? '2' : 'all';
                      history.replaceState(null, '', '#orders?view=' + view + '&range=' + preset);
                      const range = presetRange(preset);
                      setDatePreset(preset);
                      setStart(range.start);
                      setEnd(range.end);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
                {page === 'products' && (
                  <FilterField label="档案资料">
                    <select
                      aria-label="筛选档案完整性"
                      value={productAttention ? 'incomplete' : 'all'}
                      onChange={(e) => setProductAttention(e.target.value === 'incomplete')}
                    >
                      <option value="all">全部资料</option>
                      <option value="incomplete">档案待完善</option>
                    </select>
                  </FilterField>
                )}
                {page === 'orders' && (
                  <>
                    <FilterField label="客户">
                      <select
                        aria-label="筛选客户"
                        value={customerId}
                        onChange={(e) => setCustomerId(e.target.value)}
                      >
                        <option value="">全部客户</option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </FilterField>
                    <FilterField label="订单状态">
                      <select
                        aria-label="筛选状态"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                      >
                        <option value="">全部状态</option>
                        {displayOrderStatuses.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </FilterField>
                  </>
                )}
              </ListFilters>
            </>
          )}
          {page === 'dashboard' && dashboard && !error && (
            <DashboardPage
              data={dashboard}
              rangeFilter={
                <div className="filter-bar">
                  <DateRangeFilter
                    label="统计日期"
                    preset={datePreset}
                    start={start}
                    end={end}
                    change={(preset, start, end) => {
                      setDatePreset(preset);
                      setStart(start);
                      setEnd(end);
                    }}
                  />
                  <button onClick={reset}>重置筛选</button>
                </div>
              }
            />
          )}
          {['orders', 'customers', 'products'].includes(page) && !error && (
            <BusinessRecords
              filterKey={[search, customerId, status, start, end, orderView, productAttention].join(
                '|',
              )}
              hideSearch
              paging={
                page === 'orders'
                  ? {
                      page: listMetrics.ordersPage,
                      total: listMetrics.ordersFiltered,
                      onPage: setOrderPage,
                      sort: orderSort,
                      onSort: setOrderSort,
                    }
                  : undefined
              }
              totalRecords={
                page === 'orders'
                  ? listMetrics.ordersTotal
                  : page === 'customers'
                    ? listMetrics.customersTotal
                    : listMetrics.productsTotal
              }
              entity={page as 'orders' | 'customers' | 'products'}
              rows={page === 'orders' ? orders : page === 'customers' ? customerRows : productRows}
              archived={archivedView}
              setArchived={setArchivedView}
              edit={(value) =>
                setEditor({ kind: page as 'orders' | 'customers' | 'products', value })
              }
              changed={(message) => {
                if (message) setNotice(message);
                setRevision((r) => r + 1);
              }}
              search={search}
              setSearch={setSearch}
              allRecords={allRecordsView && superMode}
              setAllRecords={setAllRecordsView}
            />
          )}
          {(['suppliers', 'purchases', 'warehouse'] as string[]).includes(page) && (
            <OperationsPage
              key={page + routeKey}
              mode={page as 'suppliers' | 'purchases' | 'warehouse'}
              openSupplier={(value) => setEditor({ kind: 'suppliers', value })}
            />
          )}
          {page === 'production' && <FlowPage key={page + routeKey} mode="task" />}
          {page === 'trash' && (
            <>
              <div className="recycle-heading">
                <p>
                  已归档的记录可以恢复、编辑或删除。
                </p>
                <div className="record-view-tabs">
                  {(
                    [
                      'orders',
                      'customers',
                      'products',
                      'suppliers',
                      'purchases',
                      'stock_items',
                    ] as const
                  ).map((e) => (
                    <button
                      key={e}
                      className={trashEntity === e ? 'selected' : ''}
                      onClick={() => {
                        setTrashEntity(e);
                        setFlowTrash(null);
                        setSearch('');
                      }}
                    >
                      {
                        {
                          orders: '订单',
                          customers: '客户',
                          products: '产品',
                          suppliers: '供应商',
                          purchases: '采购单',
                          stock_items: '库存品',
                        }[e]
                      }
                    </button>
                  ))}
                </div>
              <div className="record-view-tabs">
                {(['arrival', 'task', 'production', 'delivery'] as const).map((k) => (
                  <button
                    key={k}
                    className={flowTrash === k ? 'selected' : ''}
                    onClick={() => setFlowTrash(k)}
                  >
                    {
                      {
                        arrival: '到货',
                        task: '生产任务',
                        production: '完工记录',
                        delivery: '送货',
                      }[k]
                    }
                  </button>
                ))}
              </div>
              </div>
              {flowTrash ? (
                <FlowPage key={flowTrash} mode={flowTrash} recycle />
              ) : ['suppliers', 'purchases', 'stock_items'].includes(trashEntity) ? (
                <OperationsPage
                  key={trashEntity}
                  mode={
                    trashEntity === 'stock_items'
                      ? 'warehouse'
                      : (trashEntity as 'suppliers' | 'purchases')
                  }
                  recycle
                  openSupplier={(value) => setEditor({ kind: 'suppliers', value })}
                />
              ) : (
                <BusinessRecords
                  key={trashEntity}
                  entity={trashEntity}
                  rows={
                    trashEntity === 'orders'
                      ? orders
                      : trashEntity === 'customers'
                        ? customerRows
                        : productRows
                  }
                  archived
                  setArchived={() => {}}
                  recycle
                  edit={(value) =>
                    setEditor({ kind: trashEntity as 'orders' | 'customers' | 'products', value })
                  }
                  changed={(message) => {
                    if (message) setNotice(message);
                    setRevision((r) => r + 1);
                  }}
                  search={search}
                  setSearch={setSearch}
                />
              )}
            </>
          )}
          {page === 'guide' && (
            <div className="guide-grid">
              <section className="panel prose">
                <h2>日常业务功能入口</h2>
                <p>左侧按业务分组；右上角账号菜单可以切换账号、修改密码。</p>
                {uiCapabilities
                  .filter((c) => c.kind === 'business')
                  .map((c) => (
                    <p key={c.id}>
                      <a href={c.page}>{c.name}</a>
                      <br />
                      <small>{c.entry}</small>
                    </p>
                  ))}
              </section>
              <section className="panel prose">
                <h2>日常操作顺序</h2>
                <ol>
                  <li>收到客户采购单：放进“收件箱”转订单，或直接到“AI 导入”上传，核对后入账，或新建订单手工录入。</li>
                  <li>缺纸板时新建采购单，货到后在“到货”登记验收。</li>
                  <li>在订单详情安排生产，完工后登记良品和废品，成品自动入库。</li>
                  <li>在订单详情安排送货，确认发货时扣减成品库存，并导出送货单。</li>
                  <li>客户发来唛头或样稿：放进“AI 导入”，类型选唛头并识别，系统自动对应产品并把原文件挂到产品下，对不上的选一下；也可以在产品详情里直接上传。唛头不产生订单、生产或库存。</li>
                  <li>每天打开“今日”查看待处理事项。</li>
                </ol>
              </section>
              <section className="panel prose">
                <h2>业务口径</h2>
                <p>
                  明细金额由后端按数量和实际计价口径计算，单价最多四位小数。数量单位按订单原文填写，不同单位不自动换算。
                </p>
                <p>
                  尺寸可用毫米或厘米，未知时留空。规格为接单时的快照，修改产品档案不会自动修改历史订单。客户更名也不会自动改写历史客户名称。
                </p>
                <p>
                  成本录入的是整张订单的预估总费用，包括材料、加工、损耗和其他费用；请自行说明依据。系统没有内置纸箱面积、配纸或损耗公式。
                </p>
                <p>
                  生产中、待发货、已发货由生产任务和送货单自动更新，其余状态可手工选择。计划不会提前改变库存，已发货金额不等同于会计销售收入。
                </p>
              </section>
              <section className="panel prose">
                <h2>数据与备份</h2>
                <p>
                  系统每天自动做一次完整备份到 backups 目录，删除和初始化前还会自动留下业务库快照（data/snapshots）。请定期把备份另存到其他磁盘。
                </p>
                <p>
                  账号由管理员在“账号管理”页面管理，分管理员、业务人员、只读、财务、出纳五种。登录页可以申请账号和提交忘记密码，都要管理员处理。
                </p>
              </section>
              <section className="panel prose exercise">
                <span className="exercise-time">AI 服务管理</span>
                <h2>在网页上连接模型服务</h2>
                <p>
                  进入左侧“设置”，新建预设并填写地址与密钥，连接 API
                  后从列表选择模型，测试成功后保存并启用。
                </p>
                <p>
                  密钥由 Windows DPAPI
                  加密保存，重启后无需重填。AI助手沿用当前账号权限，通过与人工页面相同的业务服务执行操作，并返回真实结果。
                </p>
                <button className="text-button" onClick={() => navigate('ai-settings')}>
                  前往设置 <ArrowUpRight size={15} />
                </button>
              </section>
            </div>
          )}
          {!dashboard && busy && <div className="empty">正在连接本机数据库…</div>}
          <footer>
            宁波甬勒包装制品有限公司 · 管理系统
            <span>v{APP_VERSION}</span>
          </footer>
          </Suspense>
        </main>
      </div>
      {editor?.value && (
        <span
          data-agent-module={editor.kind}
          data-agent-record={editor.value.id}
          data-agent-label={'number' in editor.value ? editor.value.number : editor.value.name}
          style={{ position: 'fixed', width: 1, height: 1, left: 0, top: 0 }}
        />
      )}
      <MobileTabBar page={page} navigate={(target) => navigate(target as Page)} />
      <Suspense fallback={null}>
        <GlobalAssistant />
      </Suspense>
      {palette && <CommandPalette close={() => setPalette(false)} />}
      {editor?.kind === 'customers' && (
        <CustomerEditor value={editor.value} close={closeEditor} saved={saved} />
      )}{' '}
      {editor?.kind === 'products' && (
        <ProductEditor value={editor.value} close={closeEditor} saved={saved} />
      )}{' '}
      {editor?.kind === 'suppliers' && (
        <CustomerEditor entity="suppliers" value={editor.value} close={closeEditor} saved={saved} />
      )}
      {editor?.kind === 'orders' && (
        <OrderEditor
          loading={busy}
          key={editor.value ? editor.value.id + ':' + editor.value.version : 'new'}
          value={editor.value}
          inboxId={editor.inboxId}
          customers={customers}
          products={products}
          close={closeEditor}
          saved={saved}
        />
      )}
    </div>
  );
}
