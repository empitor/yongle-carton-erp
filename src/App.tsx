import { APP_VERSION } from '../shared/version';
import { erpPageIds, normalizeAiSettingsHash } from '../shared/assistant-navigation';
import { legacyCents, precisionTotal } from '../shared/precision';
import { warehouseDeliveryHash } from '../shared/warehouse-delivery';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Package,
  Plus,
  X,
  ArrowUpRight,
  PanelLeftClose,
  Search,
  Check,
  RefreshCw,
  Save,
  FileUp,
  ShieldCheck,
  Bot,
} from 'lucide-react';
import AuthPanel, { LoginForm } from './AuthPanel';
import ThemeSwitcher from './ThemeSwitcher';
import {
  type ListResult,
  orderMetrics,
  productMetrics,
  productIncomplete,
} from '../shared/business-metrics';
import { PageHeading, ListFilters, FilterField, ListSummary, useResettingPage } from './ui/ListLayout';
import DateRangeFilter from './DateRangeFilter';
import DashboardPage from './DashboardPage';
import { presetRange, monthsBefore, type DatePreset, type OrderView } from '../shared/date-ranges';
import { authChanged, managementRequest, useAuthState } from './session';
import BusinessRecords from './BusinessRecords';
import Navigation from './Navigation';
import { uiCapabilities } from '../shared/ui-capabilities';
import { userError } from '../shared/user-errors';
import { warehouseArrivalHash } from '../shared/arrival-navigation';
import CommandPalette from './CommandPalette';
import type { RecordEntity } from '../shared/operations';
import DimensionUnitSelect from './DimensionUnitSelect';
import Combobox from './ui/Combobox';
import { convertDimension, normalizeDimensionUnit, dimensionKeys } from '../shared/product-details';
import InboxPage from './InboxPage';
// 大页面按需加载，首屏只下载用到的部分。
const FinancePages = lazy(() => import('./finance/FinancePages'));
const AiSettingsHub = lazy(() => import('./AiSettingsHub'));
const OperationsPage = lazy(() => import('./OperationsPage'));
const FlowPage = lazy(() => import('./FlowPage'));
const GlobalAssistant = lazy(() => import('./GlobalAssistant'));
const OrderImportPage = lazy(() => import('./OrderImportPage'));
import OrderLineTable from './OrderLineTable';
import { PAGE_SIZE } from './BusinessRecords';
import type { RecordSort } from '../shared/record-sort';
import { displayAmount } from '../shared/display-amount';
import {
  statuses,
  derivedOrderStatuses,
  specification,
  today,
  type Customer,
  type Product,
  type ProductInput,
  type Order,
  type Dashboard,
  type OrderInput,
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
const money = (cents: number) =>
  new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(cents / 100);

function cents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('金额需为非负数，最多两位小数');
  const [a, b = ''] = value.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
}
async function api<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  let authToken = '';
  if (body !== undefined) {
    const auth = await fetch('/api/auth/state', { cache: 'no-store' });
    if (auth.ok) {
      const state = await auth.json();
      if (!state.actor) throw new Error('请先在右上角登录管理账号。');
      authToken = state.csrf;
    }
  }
  const res = await fetch(
    '/api' + url,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': authToken },
          body: JSON.stringify(body),
        },
  );
  if (!res.ok) {
    // 会话失效时回到登录页，不把401显示成业务错误。
    if (res.status === 401) authChanged();
    const error = await res.json().catch(() => ({ message: '服务响应异常' }));
    throw new Error(userError(error.message || '操作失败'));
  }
  return res.json();
}

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Modal({
  wide = false,
  title,
  children,
  close,
}: {
  wide?: boolean;
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const root = ref.current!;
    (
      (root.querySelector('input,select,textarea') as HTMLElement) || root.querySelector('button')
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (
        [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
          .filter((d) => d.getClientRects().length)
          .at(-1) !== root
      )
        return;
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const els = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ),
        );
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      prior?.focus();
    };
  }, [close]);
  const dialog = (
    <div className="overlay">
      <div
        ref={ref}
        className={'modal' + (wide ? ' modal-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <div>
            <small>业务记录</small>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭表单" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

export default function App() {
  const auth = useAuthState(),
    superMode = !!auth?.actor?.superAdminMode;
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
    if (!auth?.actor) return;
    const load = () => {
      fetch('/api/ai/imports', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (s?.workspaces) setImportCount(s.workspaces.filter((w: any) => !w.imported).length);
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
  if (!auth.actor)
    return (
      <main className="login-screen">
        <section className="login-card">
          <span className="brand-mark">
            <Package size={24} />
          </span>
          <h1>宁波甬勒包装制品有限公司</h1>
          <p>{auth.configured ? '登录管理系统' : '首次使用，请建立管理员账号'}</p>
          <LoginForm configured={auth.configured} csrf={auth.csrf} proxyAccess={auth.proxyAccess} />
        </section>
      </main>
    );
  return (
    <div className="shell">
      <aside className={menu ? 'sidebar open' : 'sidebar'}>
        <a className="brand" href="#dashboard" title="宁波甬勒包装制品有限公司">
          <span className="brand-mark">
            <Package size={18} />
          </span>
          <span className="brand-name">甬勒包装</span>
        </a>
        <Navigation
          page={page}
          route={routeKey}
          navigate={(target) => navigate(target as Page)}
          inboxCount={inboxCount}
          importCount={importCount}
          finance={!!auth?.actor?.permissions.includes('finance:view')}
        />
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <button
              className="mobile-menu icon-button"
              aria-label="切换导航"
              onClick={() => setMenu(!menu)}
            >
              <PanelLeftClose size={20} />
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
            <div className="top-new">
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
          {page.startsWith('finance') &&
            (auth?.actor?.permissions.includes('finance:view') ? (
              <FinancePages page={page} />
            ) : (
              <div className="error" role="alert">
                当前账号没有财务权限。需要的话请找管理员在“设置 → 账号”里调整。
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
                        {statuses.map((s) => (
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
                <p>左侧按业务分组；右上角账号菜单提供本机数据管理。</p>
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
                  <li>客户发来唛头或样稿：放进“AI 导入”，类型选唛头，逐款对应产品后存入产品档案；也可以在产品详情里直接上传。唛头不产生订单、生产或库存。</li>
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
                  账号在右上角账号菜单管理，分管理员、业务人员、只读三级。服务目前只监听本机，其他电脑和手机暂不能连接。
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

function CustomerEditor({
  value,
  close,
  saved,
  entity = 'customers',
}: {
  value?: Customer;
  close: () => void;
  saved: (record?: any) => void;
  entity?: 'customers' | 'suppliers';
}) {
  const [form, setForm] = useState(
      value || { name: '', contact: '', phone: '', address: '', notes: '' },
    ),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const change = (key: string, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const record = await api(
        '/' + entity + (value ? '/' + value.id : ''),
        form,
        value ? 'PUT' : 'POST',
      );
      saved(record);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={(value ? '编辑' : '新增') + (entity === 'suppliers' ? '供应商' : '客户')}
      close={saving ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <div className="form-grid">
            <Field label={(entity === 'suppliers' ? '供应商' : '客户') + '名称 *'} wide>
              <input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => change('name', e.target.value)}
              />
            </Field>
            <Field label="联系人">
              <input
                maxLength={60}
                value={form.contact}
                onChange={(e) => change('contact', e.target.value)}
              />
            </Field>
            <Field label="联系方式">
              <input
                maxLength={50}
                value={form.phone}
                onChange={(e) => change('phone', e.target.value)}
              />
            </Field>
            <Field label="联系地址" wide>
              <input
                maxLength={300}
                value={form.address}
                onChange={(e) => change('address', e.target.value)}
              />
            </Field>
            <Field label="备注" wide>
              <textarea
                maxLength={1000}
                rows={3}
                value={form.notes}
                onChange={(e) => change('notes', e.target.value)}
              />
            </Field>
          </div>
        </div>
        <FormFooter error={error} saving={saving} close={close} />
      </form>
    </Modal>
  );
}
function ProductEditor({
  value,
  close,
  saved,
}: {
  value?: Product;
  close: () => void;
  saved: (record?: any) => void;
}) {
  const [form, setForm] = useState<ProductInput & { id?: number; version?: number }>(
      value || {
        name: '',
        length: null,
        width: null,
        height: null,
        dimensionUnit: null,
        material: '',
        flute: '',
        requirements: '',
        priceCents: 0,
      },
    ),
    [price, setPrice] = useState(value?.priceExact ?? String((value?.priceCents || 0) / 100)),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const change = (key: string, v: string | number | null) => setForm((f) => ({ ...f, [key]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const record = await api(
        '/products' + (value ? '/' + value.id : ''),
        {
          ...form,
          priceCents: price.trim() ? legacyCents(price) : 0,
          priceExact: price.trim() ? price : undefined,
        },
        value ? 'PUT' : 'POST',
      );
      saved(record);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={value ? '编辑产品' : '新增产品'} close={saving ? () => {} : close}>
      <form onSubmit={submit}>
        <div className="form-body">
          <p className="form-intro">只有名称必填，其余可以后补，不影响保存或导入订单。</p>
          <div className="product-form">
            <div className="span-4">
              <Field label="产品名称 / 型号 *">
                <input
                  required
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => change('name', e.target.value)}
                />
              </Field>
            </div>
            <div className="span-2">
              <Field label="客户料号">
                <input
                  maxLength={100}
                  value={form.customerProductCode || ''}
                  onChange={(e) => change('customerProductCode', e.target.value)}
                />
              </Field>
            </div>
            {(['length', 'width', 'height'] as const).map((k, i) => (
              <div className="span-1" key={k}>
                <Field label={['长', '宽', '高'][i]}>
                  <input
                    type="number"
                    min={Number.MIN_VALUE}
                    max={form.dimensionUnit === 'cm' ? 1000 : 10000}
                    step="any"
                    value={form[k] || ''}
                    onChange={(e) =>
                      change(k, e.target.value === '' ? null : Number(e.target.value))
                    }
                  />
                </Field>
              </div>
            ))}
            <div className="span-3">
              <Field label="尺寸单位">
                <DimensionUnitSelect
                  unit={form.dimensionUnit ?? form.dimensionUnitRaw}
                  // 只有已保存的旧尺寸才需要确认单位；刚填的数字本来就按所选单位理解。
                  hasValues={!!value && dimensionKeys.some((k) => value[k] !== null)}
                  onChange={(to) => {
                    const from = normalizeDimensionUnit(form.dimensionUnit);
                    setForm((f) => ({
                      ...f,
                      dimensionUnit: to,
                      dimensionUnitRaw: to ? '' : f.dimensionUnitRaw,
                      ...(from && to
                        ? Object.fromEntries(
                            dimensionKeys.map((k) => [k, convertDimension(f[k], from, to)]),
                          )
                        : {}),
                    }));
                  }}
                />
              </Field>
            </div>
            <div className="span-2">
              <Field label="材质 / 配纸">
                <input
                  maxLength={100}
                  value={form.material}
                  onChange={(e) => change('material', e.target.value)}
                />
              </Field>
            </div>
            <div className="span-2">
              <Field label="楞型">
                <input
                  maxLength={50}
                  value={form.flute}
                  onChange={(e) => change('flute', e.target.value)}
                  list="flutes"
                />
                <datalist id="flutes">
                  {['B 楞', 'C 楞', 'E 楞', 'BC 楞', 'BE 楞'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </datalist>
              </Field>
            </div>
            <div className="span-2">
              <Field label="参考单价（元）">
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.0001"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
            </div>
            <div className="span-6">
              <Field label="加工要求">
                <textarea
                  rows={2}
                  maxLength={500}
                  value={form.requirements}
                  onChange={(e) => change('requirements', e.target.value)}
                  placeholder="印刷、开槽、模切、钉箱或粘箱等"
                />
              </Field>
            </div>
          </div>
          <p className="product-spec-preview">规格预览：{specification(form)}</p>
        </div>
        <FormFooter error={error} saving={saving} close={close} />
      </form>
    </Modal>
  );
}
function FormFooter({
  error,
  saving,
  close,
}: {
  error: string;
  saving: boolean;
  close: () => void;
}) {
  return (
    <>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>* 为必填项</span>
        <button type="button" disabled={saving} onClick={close}>
          取消
        </button>
        <button type="submit" className="primary" disabled={saving}>
          <Save size={16} />
          {saving ? '正在保存…' : '保存'}
        </button>
      </div>
    </>
  );
}

function OrderEditor({
  value,
  customers,
  products,
  close,
  saved,
  loading = false,
  inboxId,
}: {
  value?: Order;
  loading?: boolean;
  inboxId?: number;
  customers: Customer[];
  products: Product[];
  close: () => void;
  saved: () => void;
}) {
  // 从收件箱新建时只把原文放在表单上方对照，不解析、不发给模型。
  const [inboxItem, setInboxItem] = useState<any>(null);
  useEffect(() => {
    if (!inboxId) return;
    let live = true;
    managementRequest<any>('/inbox/' + inboxId)
      .then((item) => live && setInboxItem(item))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [inboxId]);
  const [availableCustomers, setAvailableCustomers] = useState(customers),
    [availableProducts, setAvailableProducts] = useState(products),
    [quickCreate, setQuickCreate] = useState<null | {
      kind: 'customer' | 'product';
      line?: number;
    }>(null);
  useEffect(() => setAvailableCustomers(customers), [customers]);
  useEffect(() => setAvailableProducts(products), [products]);
  const [customerId, setCustomerId] = useState(String(value?.customerId || '')),
    [orderDate, setOrderDate] = useState(value?.orderDate || today()),
    [deliveryDate, setDeliveryDate] = useState(value?.deliveryDate || today()),
    [status, setStatus] = useState<OrderInput['status']>(value?.status || '草稿'),
    [notes, setNotes] = useState(value?.notes || '');
  const [orderExtras, setOrderExtras] = useState({
    externalPurchaseOrder: value?.externalPurchaseOrder || '',
    supplierName: value?.supplierName || '',
    currency: 'CNY' as const,
    taxRate: value?.taxRate || '',
    taxMode: value?.taxMode || '未明确',
    terms: value?.terms || '',
    roundingPolicy: value?.roundingPolicy || ('exact-cents' as 'exact-cents' | 'half-up-cent'),
  });
  const blank = () => ({
    id: undefined as number | undefined,
    productId: '',
    productName: '',
    unit: '只',
    notes: '',
    specification: '',
    customerProductCode: '',
    taxRate: '',
    taxMode: '',
    deliveryDate: '',
    quantity: '1',
    price: '0',
  });
  const [lines, setLines] = useState(
    value?.lines.map((l) => ({
      customerProductCode: l.customerProductCode || '',
      taxRate: l.taxRate || '',
      taxMode: l.taxMode || '',
      deliveryDate: l.deliveryDate || '',
      id: l.id,
      productId: String(l.productId),
      productName: l.productName,
      unit: l.unit || '只',
      notes: l.notes || '',
      specification: l.specification,
      quantity: String(l.quantity),
      price: l.unitPriceExact ?? String(l.unitPriceCents / 100),
    })) || [blank()],
  );
  const [costed, setCosted] = useState(value?.costs != null),
    [costs, setCosts] = useState({
      material: String((value?.costs?.material || 0) / 100),
      processing: String((value?.costs?.processing || 0) / 100),
      waste: String((value?.costs?.waste || 0) / 100),
      other: String((value?.costs?.other || 0) / 100),
      basis: value?.costs?.basis || '',
    }),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const changeLine = (index: number, key: string, v: string) =>
    setLines((rows) => rows.map((l, i) => (i === index ? { ...l, [key]: v } : l)));
  const chooseProduct = (index: number, id: string) => {
    const p = availableProducts.find((x) => x.id === Number(id));
    setLines((rows) =>
      rows.map((l, i) =>
        i === index
          ? {
              ...l,
              productId: id,
              productName: p?.name || '',
              customerProductCode: p?.customerProductCode || '',
              specification: p ? specification(p) : '',
              price: p ? (p.priceExact ?? String(p.priceCents / 100)) : '0',
            }
          : l,
      ),
    );
  };
  let total = 0,
    totalExact = '0',
    costTotal = 0;
  try {
    const calculation = precisionTotal(
      lines.map((l) => ({
        quantity: Number(l.quantity),
        unitPriceCents: legacyCents(l.price),
        unitPriceExact: l.price,
      })),
    );
    total = calculation.cents;
    totalExact = calculation.exact;
    costTotal = ['material', 'processing', 'waste', 'other'].reduce(
      (s, k) => s + cents(costs[k as keyof typeof costs]),
      0,
    );
  } catch {
    /* 输入过程中的不完整数值由保存校验处理 */
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload: OrderInput & { version?: number } = {
        ...value,
        ...orderExtras,
        customerId: Number(customerId),
        orderDate,
        deliveryDate,
        status,
        notes,
        version: value?.version,
        lines: lines.map((l) => ({
          id: l.id,
          productId: Number(l.productId),
          productName: l.productName,
          notes: l.notes,
          specification: l.specification,
          quantity: Number(l.quantity),
          unitPriceCents: legacyCents(l.price),
          unitPriceExact: l.price,
          customerProductCode: l.customerProductCode,
          taxRate: l.taxRate,
          taxMode: l.taxMode,
          deliveryDate: l.deliveryDate || undefined,
          unit: l.unit,
        })),
        costs: costed
          ? {
              material: cents(costs.material),
              processing: cents(costs.processing),
              waste: cents(costs.waste),
              other: cents(costs.other),
              basis: costs.basis,
            }
          : null,
      };
      await api('/orders' + (value ? '/' + value.id : ''), payload, value ? 'PUT' : 'POST');
      // 订单已保存；收件状态没改成时不影响订单，收件箱里仍可手动标记已处理。
      if (inboxItem?.status === 'pending')
        await managementRequest('/inbox/' + inboxItem.id + '/status', {
          status: 'converted',
          convertedKind: 'order',
          expectedVersion: inboxItem.version,
        }).catch(() => {});
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      wide
      title={value ? `订单 ${value.number}` : '新建订单'}
      close={saving ? () => {} : close}
    >
      <form onSubmit={submit}>
        <div className="form-body order-entry">
          <p className="form-intro">
            选择客户 → 添加产品与本次数量 → 核对交期和金额。标 * 为必填，其余按实际业务选填。
          </p>
          {inboxItem && (
            <aside className="order-inbox-source" aria-label="收件箱原文">
              <header>
                <strong>收件箱原文</strong>
                <span>
                  {[inboxItem.senderName, inboxItem.conversation].filter(Boolean).join(' · ') ||
                    '手动添加'}
                </span>
                {inboxItem.status === 'pending' && <small>保存订单后标记为已转单</small>}
              </header>
              {inboxItem.text && <p>{inboxItem.text}</p>}
              {inboxItem.fileName && (
                <a href={'/api/inbox/' + inboxItem.id + '/file'} download>
                  下载 {inboxItem.fileName}
                </a>
              )}
            </aside>
          )}
          {!loading &&(!availableCustomers.length || !availableProducts.length) && (
            <div className="inline-warning">
              尚无客户或产品时，可使用下方快捷建档，已填写订单内容会保留。
            </div>
          )}
          <div className="form-section-heading">
            <h3>客户与交期</h3>
            <span>订单编号由系统保存时生成</span>
          </div>
          <div className="form-grid">
            <div className="field wide">
              <div className="field-label-row">
                <span>客户 *</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setQuickCreate({ kind: 'customer' })}
                >
                  新增客户
                </button>
              </div>
              <Combobox
                required
                ariaLabel="订单客户"
                placeholder="搜索客户"
                value={String(customerId || '')}
                options={availableCustomers.map((c) => ({
                  value: String(c.id),
                  label: c.name,
                  hint: c.contact,
                  keywords: c.phone,
                }))}
                onChange={setCustomerId}
              />
              {value && <small>下单时客户名称：{value.customerName}</small>}
            </div>
            <Field label="下单日期 *">
              <input
                required
                type="date"
                value={orderDate}
                onInput={(e) => setOrderDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="交货日期 *">
              <input
                required
                type="date"
                min={orderDate}
                value={deliveryDate}
                onInput={(e) => setDeliveryDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="订单状态 *">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as OrderInput['status'])}
              >
                {statuses
                  .filter((s) => !derivedOrderStatuses.includes(s) || s === value?.status)
                  .map((s) => (
                    <option key={s}>{s}</option>
                  ))}
              </select>
            </Field>
          </div>
          <details className="order-business-extra">
            <summary>客户采购单号、税费与结算规则</summary>
            <div className="form-grid">
              {(
                [
                  ['externalPurchaseOrder', '客户采购订单号'],
                  ['supplierName', '供应方'],
                  ['taxRate', '税率（%）'],
                  ['taxMode', '含税 / 未税口径'],
                  ['terms', '合同条件'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    value={orderExtras[key]}
                    maxLength={key === 'terms' ? 4000 : 100}
                    onChange={(e) => setOrderExtras((v) => ({ ...v, [key]: e.target.value }))}
                  />
                </Field>
              ))}
              <Field label="金额结算规则">
                <select
                  value={orderExtras.roundingPolicy}
                  onChange={(e) =>
                    setOrderExtras((v) => ({
                      ...v,
                      roundingPolicy: e.target.value as 'exact-cents' | 'half-up-cent',
                    }))
                  }
                >
                  <option value="exact-cents">精确到分，不自动舍入</option>
                  <option value="half-up-cent">明确采用整单四舍五入到分</option>
                </select>
              </Field>
            </div>
            <p className="help-text">
              四位单价原样保存。精确总金额包含不足一分的尾数时，必须明确结算规则；不会自动加减税。
            </p>
          </details>
          <div className="form-section-heading">
            <h3>订单明细</h3>
            <span>数量与单位独立保存 · 单价最多四位小数，保留原始精度</span>
          </div>
          <OrderLineTable
            lines={lines}
            products={availableProducts}
            orderDate={orderDate}
            change={changeLine}
            choose={chooseProduct}
            quick={(i) => setQuickCreate({ kind: 'product', line: i })}
            remove={(i) => setLines((rows) => rows.filter((_, n) => n !== i))}
          />
          <datalist id="order-quantity-units">
            {['只', '张', '箱', '套'].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </datalist>
          <button
            type="button"
            className="add-line"
            disabled={lines.length >= 50}
            onClick={() => setLines((rows) => [...rows, blank()])}
          >
            <Plus size={16} />
            添加明细
          </button>
          <div className="order-total">
            <span>订单合计</span>
            <strong>¥{displayAmount(totalExact)}</strong>
          </div>
          <div className="form-section-heading">
            <h3>预估成本</h3>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={costed}
                onChange={(e) => setCosted(e.target.checked)}
              />
              录入预估成本
            </label>
          </div>
          <p className="help-text">
            填写整张订单的费用总额与估算依据。暂不套用统一纸箱公式；未录入的订单不计入毛利汇总。
          </p>
          {costed && (
            <>
              <div className="form-grid">
                {(
                  [
                    { key: 'material', label: '材料费用 / 元' },
                    { key: 'processing', label: '加工费用 / 元' },
                    { key: 'waste', label: '损耗费用 / 元' },
                    { key: 'other', label: '其他费用 / 元' },
                  ] as const
                ).map((x) => (
                  <Field key={x.key} label={x.label + ' *'}>
                    <input
                      required
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={costs[x.key]}
                      onChange={(e) => setCosts((c) => ({ ...c, [x.key]: e.target.value }))}
                    />
                  </Field>
                ))}
                <Field label="估算依据 *" wide>
                  <textarea
                    required
                    maxLength={1000}
                    rows={2}
                    placeholder="例如：本单实际配纸报价、加工报价、单独确认的损耗及运费"
                    value={costs.basis}
                    onChange={(e) => setCosts((c) => ({ ...c, basis: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="cost-summary">
                <span>预估成本 {money(costTotal)}</span>
                <strong>预估毛利 {money(total - costTotal)}</strong>
              </div>
            </>
          )}
          <Field label="订单备注">
            <textarea
              rows={2}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>
        <FormFooter error={error} saving={saving} close={close} />
      </form>
      {quickCreate?.kind === 'customer' && (
        <CustomerEditor
          close={() => setQuickCreate(null)}
          saved={(record) => {
            setAvailableCustomers((v) => [...v.filter((x) => x.id !== record.id), record]);
            setCustomerId(String(record.id));
            setQuickCreate(null);
            window.dispatchEvent(new Event('erp-business-changed'));
          }}
        />
      )}
      {quickCreate?.kind === 'product' && (
        <ProductEditor
          close={() => setQuickCreate(null)}
          saved={(record) => {
            setAvailableProducts((v) => [...v.filter((x) => x.id !== record.id), record]);
            setLines((v) =>
              v.map((l, i) =>
                i === quickCreate.line
                  ? {
                      ...l,
                      productId: String(record.id),
                      productName: record.name,
                      specification: specification(record),
                      price: record.priceExact ?? String(record.priceCents / 100),
                    }
                  : l,
              ),
            );
            setQuickCreate(null);
            window.dispatchEvent(new Event('erp-business-changed'));
          }}
        />
      )}
    </Modal>
  );
}
