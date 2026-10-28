import { APP_VERSION } from '../shared/version';
import { erpPageIds, normalizeAiSettingsHash } from '../shared/assistant-navigation';
import { legacyCents, precisionTotal } from '../shared/precision';
import { warehouseDeliveryHash } from '../shared/warehouse-delivery';
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import {
  Package,
  Plus,
  X,
  ArrowUpRight,
  PanelLeftClose,
  CircleHelp,
  Check,
  RefreshCw,
  Trash2,
  Save,
  Database,
  FileUp,
  ShieldCheck,
} from 'lucide-react';
import AiSettingsHub from './AiSettingsHub';
import AuthPanel from './AuthPanel';
import ThemeSwitcher from './ThemeSwitcher';
import {
  type ListResult,
  orderMetrics,
  productMetrics,
  productIncomplete,
} from '../shared/business-metrics';
import { PageHeading, LocalNotice, ListFilters, FilterField, ListSummary } from './ui/ListLayout';
import DateRangeFilter from './DateRangeFilter';
import DashboardPage from './DashboardPage';
import { presetRange, monthsBefore, type DatePreset, type OrderView } from '../shared/date-ranges';
import { useAuthState } from './session';
import BusinessRecords from './BusinessRecords';
import Navigation from './Navigation';
import OperationsPage from './OperationsPage';
import FlowPage from './FlowPage';
import GlobalAssistant from './GlobalAssistant';
import type { RecordEntity } from '../shared/operations';
import DimensionUnitSelect from './DimensionUnitSelect';
import { convertDimension, normalizeDimensionUnit, dimensionKeys } from '../shared/product-details';
import OrderImportPage from './OrderImportPage';
import {
  statuses,
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
  | 'dashboard'
  | 'orders'
  | 'customers'
  | 'products'
  | 'guide'
  | 'ai-plugins'
  | 'ai-settings'
  | 'ai-import'
  | 'ai-prompts'
  | 'trash'
  | 'suppliers'
  | 'purchases'
  | 'warehouse'
  | 'arrivals'
  | 'production';
type Editor =
  | { kind: 'customers'; value?: Customer }
  | { kind: 'products'; value?: Product }
  | { kind: 'orders'; value?: Order }
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
    const error = await res.json().catch(() => ({ message: '服务响应异常' }));
    throw new Error(error.message || '操作失败');
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
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const root = ref.current!;
    (root.querySelector('input,select,button') as HTMLElement)?.focus();
    const onKey = (e: KeyboardEvent) => {
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
  return (
    <div className="overlay">
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}>
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
    const normalized = normalizeAiSettingsHash(warehouseDeliveryHash(location.hash));
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
  const [listMetrics, setListMetrics] = useState({
    customersTotal: 0,
    productsTotal: 0,
    ordersTotal: 0,
    orders: orderMetrics([]),
    products: productMetrics([]),
  });
  const [datePreset, setDatePreset] = useState<DatePreset>(() => readListFilters().preset);
  const [orderView, setOrderView] = useState<OrderView>(() => readListFilters().view);
  const [archivedView, setArchivedView] = useState(
    () => new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1',
  );
  useEffect(() => {
    if (page !== 'orders') return;
    const id = new URLSearchParams(location.hash.split('?')[1] || '').get('order');
    if (id && /^\d+$/.test(id)) {
      api<Order>('/orders/' + id)
        .then((value) => setEditor({ kind: 'orders', value }))
        .catch((e) => setError(e.message));
      history.replaceState(null, '', '#orders');
    }
  }, [page]);
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
  useEffect(() => {
    if (
      page === 'ai-plugins' ||
      page === 'ai-settings' ||
      page === 'ai-import' ||
      page === 'ai-prompts' ||
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
        Promise.all([
          api<ListResult<Customer, null>>('/customers?' + customerQuery),
          api<ListResult<Product, ReturnType<typeof productMetrics>>>('/products?' + productQuery),
          api<ListResult<Order, ReturnType<typeof orderMetrics>>>('/orders?' + query),
          api<Dashboard>('/dashboard?' + query),
        ])
          .then(([c, p, o, d]) => {
            if (![c, p, o].every((v) => Array.isArray(v?.rows)))
              throw new Error('后端仍为旧版本，请重启系统后刷新。');
            if (active) {
              setCustomers(c.rows);
              setProducts(p.rows);
              setOrders(o.rows);
              setDashboard(d);
              setListMetrics({
                customersTotal: c.totalRecords,
                productsTotal: p.totalRecords,
                ordersTotal: o.totalRecords,
                orders: o.metrics,
                products: p.metrics,
              });
            }
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
  ]);
  useEffect(() => {
    if (!superMode) setAllRecordsView(false);
  }, [superMode]);

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
    dashboard: '经营概览',
    orders: '客户订单',
    customers: '客户管理',
    products: '产品管理',
    guide: '使用与验收',
    'ai-plugins': 'AI 插件',
    'ai-settings': 'AI 设置',
    'ai-import': 'AI 智能订单导入',
    'ai-prompts': 'AI 识别提示词',
    trash: '归档记录',
    suppliers: '供应商管理',
    purchases: '采购订货',
    warehouse: '仓库管理',
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

  return (
    <div className="shell">
      <aside className={menu ? 'sidebar open' : 'sidebar'}>
        <a className="brand" href="#dashboard">
          <span className="brand-mark">
            <Package size={24} />
          </span>
          <div>
            宁波甬勒包装制品有限公司<span>管理系统</span>
          </div>
        </a>
        <div className="workspace">
          <i />
          本机工作台<span>开发验收版 v{APP_VERSION}</span>
        </div>
        <Navigation page={page} navigate={(id) => navigate(id as Page)} />
        <div className="sidebar-bottom">
          <div className="phase">
            <span>当前阶段</span>
            <strong>让每一张订单有据可查</strong>
            <p>客户、产品、订单与预估成本，先把核心流程串起来。</p>
          </div>
          <button
            className={page === 'guide' ? 'nav-item selected' : 'nav-item'}
            onClick={() => navigate('guide')}
          >
            <CircleHelp size={19} />
            使用与验收
          </button>
          <div className="database-label">
            <Database size={15} />
            SQLite 本地持久化
          </div>
        </div>
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
            <span className="breadcrumb">
              工作台 <span>/</span> <strong>{names[page]}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <ThemeSwitcher />
            {page !== 'ai-import' && <AuthPanel />}
            <span className="local-indicator">
              <span className="local-dot" />
              本机模式
            </span>
            <span className="top-date">{today()}</span>
          </div>
        </header>
        <main className={page === 'ai-import' ? 'import-main' : ''}>
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
          {!['suppliers', 'purchases', 'warehouse', 'arrivals', 'production'].includes(page) && (
            <>
              <PageHeading
                title={page === 'dashboard' ? '宁波甬勒包装制品有限公司' : names[page]}
                kicker={page === 'dashboard' ? '经营概览 · 日常经营' : '宁波甬勒包装制品有限公司'}
                description={
                  <>
                    {page === 'dashboard'
                      ? '客户订单、采购与库存，掌握工厂每日业务。'
                      : page === 'orders'
                        ? '从接单到发货，记录每一项约定。'
                        : page === 'customers'
                          ? '集中维护客户资料，让业务往来更清晰。'
                          : page === 'products'
                            ? '沉淀纸箱规格，下单时快速引用。'
                            : page === 'ai-settings'
                              ? '保存连接预设，选择模型，让每次启动都更简单。'
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
                                        : '先验证流程，再逐步接入真实经营。'}
                  </>
                }
                actions={
                  ['dashboard', 'orders', 'customers', 'products'].includes(page) ? (
                    <>
                      {page === 'orders' && (
                        <button onClick={() => navigate('ai-import')}>
                          <FileUp size={16} />
                          AI 智能导入
                        </button>
                      )}
                      <button disabled={busy} onClick={() => setRevision((v) => v + 1)}>
                        <RefreshCw size={15} />
                        刷新
                      </button>
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
                    </>
                  ) : undefined
                }
              />
              {!['orders', 'customers', 'products'].includes(page) && (
                <LocalNotice onGuide={() => navigate('guide')} />
              )}
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
          {['orders', 'customers', 'products'].includes(page) && (
            <>
              {page === 'orders' && !error && (
                <ListSummary
                  items={[
                    {
                      label: '订单总数',
                      value: busy ? '—' : listMetrics.orders.total,
                      hint: '当前筛选范围',
                    },
                    {
                      label: '待完成订单',
                      value: busy ? '—' : listMetrics.orders.pending,
                      hint: '已确认、生产中、待发货',
                    },
                    {
                      label: '逾期未完成订单',
                      value: busy ? '—' : listMetrics.orders.overdue,
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
          {page === 'dashboard' && (
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
          )}
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
          {page === 'dashboard' && dashboard && !error && <DashboardPage data={dashboard} />}
          {['orders', 'customers', 'products'].includes(page) && !error && (
            <BusinessRecords
              filterKey={[search, customerId, status, start, end, orderView, productAttention].join(
                '|',
              )}
              hideSearch
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
              onGuide={() => navigate('guide')}
              openSupplier={(value) => setEditor({ kind: 'suppliers', value })}
            />
          )}
          {(['arrivals', 'production'] as string[]).includes(page) && (
            <FlowPage key={page + routeKey} mode={page === 'arrivals' ? 'arrival' : 'task'} />
          )}
          {page === 'trash' && (
            <>
              <div className="recycle-heading">
                <p>
                  这里仅显示仍保存在数据库中的归档记录。历史软删除数据继续保留，可编辑、恢复或真正删除；物理删除的数据不会进入此列表。
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
                        arrival: '采购到货',
                        task: '生产任务',
                        production: '生产登记',
                        delivery: '客户送货',
                      }[k]
                    }
                  </button>
                ))}
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
                <h2>第一版验收顺序</h2>
                <ol>
                  <li>新增一个虚构客户，填写联系人、电话和地址。</li>
                  <li>新增一款纸箱产品，填写尺寸、材质、楞型和参考价格。</li>
                  <li>新建订单，选择客户和产品，填写数量与交期。</li>
                  <li>添加第二项明细，检查订单合计，再保存。</li>
                  <li>编辑订单，开启“录入预估成本”，填写费用与估算依据。</li>
                  <li>按客户、状态和下单日期筛选订单，回到首页核对金额。</li>
                  <li>关闭服务再启动，确认记录依然存在。</li>
                </ol>
              </section>
              <section className="panel prose">
                <h2>本版业务口径</h2>
                <p>
                  每项明细的金额由后端按数量 × 单价计算。单价精度暂为两位小数，数量单位暂为“只”。
                </p>
                <p>
                  尺寸可用毫米或厘米，未知时留空。规格为接单时的快照，修改产品档案不会自动修改历史订单。客户更名也不会自动改写历史客户名称。
                </p>
                <p>
                  成本录入的是整张订单的预估总费用，包括材料、加工、损耗和其他费用；请自行说明依据。本版没有内置纸箱面积、配纸或损耗公式。
                </p>
                <p>
                  订单状态由人工维护，尚不等同于生产、出库或收款记录。已发货金额不是会计销售收入。
                </p>
              </section>
              <section className="panel prose">
                <h2>数据与使用范围</h2>
                <p>
                  数据保存在项目 data/erp.sqlite 文件内，关闭网页不会清空。运行 npm run backup
                  可生成一致性备份，恢复步骤见项目 README。
                </p>
                <p>
                  本版服务仅监听本机。已具备本机管理身份、受控导入及业务审计；员工角色管理、自动备份和正式部署仍待完善，手机、平板暂不能连接本机服务。
                </p>
                <p>
                  请先使用虚构数据验收。投入真实业务前，还需确认计价精度、税费、作废规则、客户归属及历史数据修改权限。
                </p>
              </section>
              <section className="panel prose exercise">
                <span className="exercise-time">AI 服务管理</span>
                <h2>在网页上连接模型服务</h2>
                <p>
                  进入左侧“AI 设置”，新建预设并填写地址与密钥，连接 API
                  后从列表选择模型，测试成功后保存并启用。
                </p>
                <p>
                  密钥由 Windows DPAPI
                  加密保存，重启后无需重填。订单识别和聊天核对已开放，正式业务写入保持关闭。
                </p>
                <button className="text-button" onClick={() => navigate('ai-settings')}>
                  前往 AI 设置 <ArrowUpRight size={15} />
                </button>
              </section>
            </div>
          )}
          {!dashboard && busy && <div className="empty">正在连接本机数据库…</div>}
          <footer>
            宁波甬勒包装制品有限公司 · 管理系统
            <span>本机验收版 v{APP_VERSION} · 为纸箱加工的日常工作而建</span>
          </footer>
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
      <GlobalAssistant />
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
          key={editor.value ? editor.value.id + ':' + editor.value.version : 'new'}
          value={editor.value}
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
  saved: () => void;
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
      await api('/' + entity + (value ? '/' + value.id : ''), form, value ? 'PUT' : 'POST');
      saved();
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
                placeholder={
                  entity === 'suppliers' ? '填写外购纸板供应商名称' : '例如：示例客户 · 某某包装'
                }
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
  saved: () => void;
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
      await api(
        '/products' + (value ? '/' + value.id : ''),
        {
          ...form,
          priceCents: price.trim() ? legacyCents(price) : 0,
          priceExact: price.trim() ? price : undefined,
        },
        value ? 'PUT' : 'POST',
      );
      saved();
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
          <div className="form-grid">
            <Field label="产品名称 *" wide>
              <input
                required
                maxLength={100}
                value={form.name}
                onChange={(e) => change('name', e.target.value)}
              />
            </Field>
            <Field label="尺寸单位（可后续确认）" wide>
              <DimensionUnitSelect
                unit={form.dimensionUnit ?? form.dimensionUnitRaw}
                hasValues={dimensionKeys.some((k) => form[k] !== null)}
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
            <p className="wide help-text">
              长、宽、高、配纸和楞型可暂时留空，不影响保存产品或导入订单。
            </p>
            <div className="wide dimensions">
              {(['length', 'width', 'height'] as const).map((k, i) => (
                <Field
                  key={k}
                  label={
                    ['长', '宽', '高'][i] +
                    (form.dimensionUnit ? ' / ' + form.dimensionUnit : '（可后补）')
                  }
                >
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
              ))}
            </div>
            <Field label="材质 / 配纸（可后补）">
              <input
                maxLength={100}
                value={form.material}
                onChange={(e) => change('material', e.target.value)}
                placeholder="按实际配纸填写"
              />
            </Field>
            <Field label="类型 / 楞型（可后补）">
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
            <Field label="参考单价 / 元每只（可后补）">
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
            <Field label="加工要求" wide>
              <textarea
                rows={3}
                maxLength={500}
                value={form.requirements}
                onChange={(e) => change('requirements', e.target.value)}
                placeholder="印刷、开槽、模切、钉箱或粘箱等"
              />
            </Field>
          </div>
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
          {saving ? '正在保存…' : '保存记录'}
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
}: {
  value?: Order;
  customers: Customer[];
  products: Product[];
  close: () => void;
  saved: () => void;
}) {
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
    quantity: '1',
    price: '0',
  });
  const [lines, setLines] = useState(
    value?.lines.map((l) => ({
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
    const p = products.find((x) => x.id === Number(id));
    setLines((rows) =>
      rows.map((l, i) =>
        i === index
          ? {
              ...l,
              productId: id,
              productName: p?.name || '',
              specification: p ? specification(p) : '',
              price: p ? (p.priceExact ?? String(p.priceCents / 100)) : '0',
            }
          : l,
      ),
    );
  };
  let total = 0,
    costTotal = 0;
  try {
    total = precisionTotal(
      lines.map((l) => ({
        quantity: Number(l.quantity),
        unitPriceCents: legacyCents(l.price),
        unitPriceExact: l.price,
      })),
    ).cents;
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
          customerProductCode: value?.lines.find((old) => old.id === l.id)?.customerProductCode,
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
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={value ? `订单 ${value.number}` : '新建订单'} close={saving ? () => {} : close}>
      <form onSubmit={submit}>
        <div className="form-body">
          {(!customers.length || !products.length) && (
            <div className="inline-warning">请先新增至少一个客户和一个产品，再录入订单。</div>
          )}
          <div className="form-grid">
            <Field label="客户 *" wide>
              <select required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">请选择客户</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {value && <small>下单时客户名称：{value.customerName}</small>}
            </Field>
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
                {statuses.map((s) => (
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
          {lines.map((l, i) => (
            <div className="line-editor" key={i}>
              <div className="line-heading">
                <strong>明细 {i + 1}</strong>
                <button
                  type="button"
                  className="text-button danger"
                  disabled={lines.length === 1}
                  onClick={() => setLines((rows) => rows.filter((_, n) => n !== i))}
                >
                  <Trash2 size={14} />
                  移除
                </button>
              </div>
              <div className="form-grid">
                <Field label="产品档案 *" wide>
                  <select
                    required
                    value={l.productId}
                    onChange={(e) => chooseProduct(i, e.target.value)}
                  >
                    <option value="">选择产品，带入规格和参考价</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="本单产品名称 *" wide>
                  <textarea
                    required
                    rows={2}
                    maxLength={2000}
                    value={l.productName}
                    onChange={(e) => changeLine(i, 'productName', e.target.value)}
                  />
                </Field>
                <Field label="规格型号（可后补）" wide>
                  <textarea
                    maxLength={2000}
                    rows={2}
                    value={l.specification}
                    onChange={(e) => changeLine(i, 'specification', e.target.value)}
                  />
                </Field>
                <Field label="明细备注" wide>
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={l.notes}
                    onChange={(e) => changeLine(i, 'notes', e.target.value)}
                  />
                </Field>
                <Field label="数量 *">
                  <input
                    required
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    value={l.quantity}
                    onChange={(e) => changeLine(i, 'quantity', e.target.value)}
                  />
                </Field>
                <Field label="数量单位 *">
                  <input
                    required
                    maxLength={20}
                    value={l.unit}
                    onChange={(e) => changeLine(i, 'unit', e.target.value)}
                  />
                </Field>
                <Field label="单价 / 元 *">
                  <input
                    required
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.0001"
                    value={l.price}
                    onChange={(e) => changeLine(i, 'price', e.target.value)}
                  />
                </Field>
              </div>
            </div>
          ))}
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
            <strong>{money(total)}</strong>
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
    </Modal>
  );
}
