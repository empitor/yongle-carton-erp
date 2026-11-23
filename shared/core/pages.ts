import { flowKinds, stockKinds, type FlowKind } from './business-kinds.js';
import { dateSchema, displayOrderStatuses } from './domain.js';
import { datePresets, orderViews } from './date-ranges.js';

/**
 * 全站页面地址一本册子：页面编号、中文名、所在分组、允许的查询参数和参数类型。
 * 导航、手机导航、财务页签、命令面板、页头标题和助手页面表都从这里派生；
 * 页面链接只由 pageHref / flowDocHref 生成，读参数用 pageParams。
 */

export const pageGroups = ['工作台', '销售', '采购', '生产', '仓储', '财务', '系统'] as const;
export type PageGroup = (typeof pageGroups)[number];

type PageMeta = { readonly title: string; readonly short?: string; readonly group: PageGroup };

/** 页面表：编号、中文名（short 是手机底部导航的短名）、所在分组；顺序即导航和财务页签的顺序 */
export const pages = {
  dashboard: { title: '今日', group: '工作台' },
  inbox: { title: '收件箱', group: '工作台' },
  'ai-import': { title: 'AI 导入', group: '工作台' },
  orders: { title: '订单', group: '销售' },
  customers: { title: '客户', group: '销售' },
  products: { title: '产品', group: '销售' },
  purchases: { title: '采购单', group: '采购' },
  suppliers: { title: '供应商', group: '采购' },
  production: { title: '生产管理', short: '生产', group: '生产' },
  warehouse: { title: '仓储', short: '仓库', group: '仓储' },
  finance: { title: '财务概览', short: '概览', group: '财务' },
  'finance-flow': { title: '月度台账', group: '财务' },
  'finance-ar': { title: '应收应付', group: '财务' },
  'finance-cash': { title: '资金发票', short: '资金', group: '财务' },
  'finance-costs': { title: '费用资产工资', group: '财务' },
  'finance-ledger': { title: '凭证账簿', short: '凭证', group: '财务' },
  'finance-reports': { title: '报表结账', group: '财务' },
  'finance-settings': { title: '财务设置', group: '财务' },
  accounts: { title: '账号管理', group: '系统' },
  'ai-settings': { title: '设置', group: '系统' },
  trash: { title: '归档', group: '系统' },
  guide: { title: '使用说明', group: '系统' },
} as const satisfies Record<string, PageMeta>;

export type PageId = keyof typeof pages;
export type FinancePageId = { [K in PageId]: (typeof pages)[K]['group'] extends '财务' ? K : never }[PageId];

export const isPageId = (id: string): id is PageId => Object.hasOwn(pages, id);
export const pageIds: readonly PageId[] = Object.keys(pages).filter(isPageId);
export const isFinancePage = (id: string): id is FinancePageId => isPageId(id) && pages[id].group === '财务';
export const financePageIds: readonly FinancePageId[] = pageIds.filter(isFinancePage);
export const pageTitle = (id: PageId): string => pages[id].title;
export const pageShortTitle = (id: PageId): string => {
  const meta: PageMeta = pages[id];
  return meta.short ?? meta.title;
};
export const pagesInGroup = (group: PageGroup): PageId[] => pageIds.filter((id) => pages[id].group === group);

/** 从 #页面?参数（或裸页面名）取页面编号，未登记返回 null */
export function pageIdOf(hash: string): PageId | null {
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  const id = cleaned.split('?')[0];
  return isPageId(id) ? id : null;
}

/** 是不是本站登记过的页面地址（#页面 或 #页面?参数，不带换行、空字符或第二个 #） */
export function isPageHref(url: unknown): url is string {
  if (typeof url !== 'string' || /[\r\n\u0000]/.test(url)) return false;
  if (!/^#[a-z-]+(?:\?[^#]*)?$/.test(url)) return false;
  return pageIdOf(url) !== null;
}

const flag = (v: string | null): boolean => v === '1';
const posInt = (v: string | null): number | undefined => {
  if (!v || !/^[1-9]\d{0,15}$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && String(n) === v ? n : undefined;
};
const posInts = (v: string | null): number[] =>
  (v || '')
    .split(',')
    .map(posInt)
    .filter((n): n is number => n !== undefined);
const text = (v: string | null): string | undefined => (v ? v : undefined);
const isoDate = (v: string | null): string | undefined => (v && dateSchema.safeParse(v).success ? v : undefined);
const oneOf =
  <const T extends readonly string[]>(values: T) =>
  (v: string | null): T[number] | undefined =>
    values.find((x) => x === v);

const dashboardViews = ['todo', 'overview'] as const;
const importModes = ['order', 'arrival'] as const;
const listScopes = ['pending', 'all', 'archived'] as const;
const simpleScopes = ['all', 'archived'] as const;
const productionViewValues = ['production'] as const;
const onlyAll = ['all'] as const;
const onlyPending = ['pending'] as const;
const arTabs = ['items', 'soon', 'statement', 'terms', 'held', 'aging', 'plan', 'discount', 'deposits', 'interest'] as const;
const cashTabs = ['documents', 'accounts', 'notes', 'invoices', 'bank', 'matching', 'tax'] as const;
const costsTabs = ['expenses', 'assets', 'payroll', 'costing', 'margin'] as const;
const ledgerTabs = ['vouchers', 'events', 'books', 'templates', 'audit'] as const;
const reportsTabs = ['reports', 'closing', 'budget', 'balance', 'profit', 'cashflow', 'trial', 'periods'] as const;
const financeSettingsTabs = ['basic', 'accounts'] as const;
export const settingsTabIds = ['api', 'prompts', 'templates', 'channels', 'tools'] as const;
export type SettingsTab = (typeof settingsTabIds)[number];

const readDatePreset = oneOf(datePresets);
const readOrderView = oneOf(orderViews);
const readDisplayStatus = oneOf(displayOrderStatuses);
const readListScope = oneOf(listScopes);
const readSimpleScope = oneOf(simpleScopes);
const readStockKind = oneOf(stockKinds);
const readOnly = (p: URLSearchParams) => ({ q: text(p.get('q')) });

/** 每个页面允许的查询参数及解析规则：同时决定 pageHref / pageParams 的静态类型 */
const pageReaders = {
  dashboard: (p: URLSearchParams) => ({
    view: oneOf(dashboardViews)(p.get('view')),
    range: readDatePreset(p.get('range')),
    start: isoDate(p.get('start')),
    end: isoDate(p.get('end')),
    customerId: posInt(p.get('customerId')),
    q: text(p.get('q')),
  }),
  inbox: (p: URLSearchParams) => ({ item: posInt(p.get('item')), q: text(p.get('q')) }),
  'ai-import': (p: URLSearchParams) => ({
    workspace: text(p.get('workspace')),
    mode: oneOf(importModes)(p.get('mode')),
    q: text(p.get('q')),
  }),
  orders: (p: URLSearchParams) => ({
    order: posInt(p.get('order')),
    create: flag(p.get('create')),
    customer: posInt(p.get('customer')),
    products: posInts(p.get('products')),
    n: posInt(p.get('n')),
    q: text(p.get('q')),
    scope: readListScope(p.get('scope')),
    view: readOrderView(p.get('view')),
    archived: flag(p.get('archived')),
    status: readDisplayStatus(p.get('status')),
    customerId: posInt(p.get('customerId')),
    range: readDatePreset(p.get('range')),
    start: isoDate(p.get('start')),
    end: isoDate(p.get('end')),
  }),
  customers: (p: URLSearchParams) => ({
    record: posInt(p.get('record')),
    q: text(p.get('q')),
    scope: readSimpleScope(p.get('scope')),
    archived: flag(p.get('archived')),
  }),
  products: (p: URLSearchParams) => ({
    record: posInt(p.get('record')),
    customerId: posInt(p.get('customerId')),
    unassigned: flag(p.get('unassigned')),
    q: text(p.get('q')),
    scope: readSimpleScope(p.get('scope')),
    archived: flag(p.get('archived')),
  }),
  purchases: (p: URLSearchParams) => ({
    record: posInt(p.get('record')),
    create: flag(p.get('create')),
    supplier: posInt(p.get('supplier')),
    stocks: posInts(p.get('stocks')),
    order: posInt(p.get('order')),
    products: posInts(p.get('products')),
    n: posInt(p.get('n')),
    q: text(p.get('q')),
    scope: readListScope(p.get('scope')),
    archived: flag(p.get('archived')),
    pending: flag(p.get('pending')),
    status: text(p.get('status')),
    businessStatus: text(p.get('businessStatus')),
    range: readDatePreset(p.get('range')),
    start: isoDate(p.get('start')),
    end: isoDate(p.get('end')),
  }),
  suppliers: (p: URLSearchParams) => ({
    q: text(p.get('q')),
    scope: readSimpleScope(p.get('scope')),
    archived: flag(p.get('archived')),
  }),
  production: (p: URLSearchParams) => ({
    view: oneOf(productionViewValues)(p.get('view')),
    doc: posInt(p.get('doc')),
    create: flag(p.get('create')),
    task: posInt(p.get('task')),
    order: posInt(p.get('order')),
    pending: flag(p.get('pending')),
    scope: oneOf(onlyAll)(p.get('scope')),
    date: isoDate(p.get('date')),
    archived: flag(p.get('archived')),
    edit: flag(p.get('edit')),
    review: flag(p.get('review')),
    q: text(p.get('q')),
  }),
  warehouse: (p: URLSearchParams) => ({
    kind: readStockKind(p.get('kind')),
    arrivals: flag(p.get('arrivals')),
    deliveries: flag(p.get('deliveries')),
    flow: flag(p.get('flow')),
    doc: posInt(p.get('doc')),
    receipt: text(p.get('receipt')),
    record: posInt(p.get('record')),
    item: posInt(p.get('item')),
    purchase: posInt(p.get('purchase')),
    zero: flag(p.get('zero')),
    archived: flag(p.get('archived')),
    scope: readListScope(p.get('scope')),
    pending: flag(p.get('pending')),
    state: oneOf(onlyPending)(p.get('state')),
    date: isoDate(p.get('date')),
    range: readDatePreset(p.get('range')),
    start: isoDate(p.get('start')),
    end: isoDate(p.get('end')),
    q: text(p.get('q')),
    createDelivery: flag(p.get('createDelivery')),
    order: posInts(p.get('order')),
    stock: posInts(p.get('stock')),
    export: flag(p.get('export')),
    edit: flag(p.get('edit')),
    review: flag(p.get('review')),
  }),
  finance: readOnly,
  'finance-flow': (p: URLSearchParams) => ({ missing: flag(p.get('missing')), q: text(p.get('q')) }),
  'finance-ar': (p: URLSearchParams) => ({ tab: oneOf(arTabs)(p.get('tab')), q: text(p.get('q')) }),
  'finance-cash': (p: URLSearchParams) => ({
    tab: oneOf(cashTabs)(p.get('tab')),
    cash: posInt(p.get('cash')),
    q: text(p.get('q')),
  }),
  'finance-costs': (p: URLSearchParams) => ({ tab: oneOf(costsTabs)(p.get('tab')), q: text(p.get('q')) }),
  'finance-ledger': (p: URLSearchParams) => ({
    tab: oneOf(ledgerTabs)(p.get('tab')),
    voucher: posInt(p.get('voucher')),
    status: oneOf(onlyAll)(p.get('status')),
    account: text(p.get('account')),
    q: text(p.get('q')),
  }),
  'finance-reports': (p: URLSearchParams) => ({ tab: oneOf(reportsTabs)(p.get('tab')), q: text(p.get('q')) }),
  'finance-settings': (p: URLSearchParams) => ({
    tab: oneOf(financeSettingsTabs)(p.get('tab')),
    q: text(p.get('q')),
  }),
  accounts: readOnly,
  'ai-settings': (p: URLSearchParams) => ({
    tab: oneOf(settingsTabIds)(p.get('tab')),
    assistant: flag(p.get('assistant')),
    q: text(p.get('q')),
  }),
  trash: readOnly,
  guide: readOnly,
} satisfies Record<PageId, (p: URLSearchParams) => Record<string, unknown>>;

export type PageParams<P extends PageId> = ReturnType<(typeof pageReaders)[P]>;
export type PageParamsInput<P extends PageId> = {
  [K in keyof PageParams<P>]?: PageParams<P>[K] extends number[] ? readonly number[] : PageParams<P>[K];
};
export type TabbedPageId = {
  [K in PageId]: 'tab' extends keyof PageParams<K> ? K : never;
}[PageId];
export type PageTab<P extends TabbedPageId> = NonNullable<PageParams<P>['tab']>;

/** 每个页面登记过的参数名集合（由 pageReaders 直接派生，单一源头） */
const allowedParamKeys = new Map<PageId, ReadonlySet<string>>(
  pageIds.map((id) => [id, new Set(Object.keys(pageReaders[id](new URLSearchParams())))]),
);

function encodeParam(value: unknown): string | null {
  if (value === undefined || value === null || value === false || value === '') return null;
  if (value === true) return '1';
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (Array.isArray(value)) {
    const nums = value.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
    return nums.length ? nums.join(',') : null;
  }
  return typeof value === 'string' ? encodeURIComponent(value) : null;
}

function buildHref(page: PageId, params?: Record<string, unknown>): string {
  if (!params) return '#' + page;
  const allowed = allowedParamKeys.get(page);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!allowed?.has(key)) continue;
    const encoded = encodeParam(value);
    if (encoded !== null) parts.push(key + '=' + encoded);
  }
  return parts.length ? '#' + page + '?' + parts.join('&') : '#' + page;
}

/** 拼出带 # 的页面地址；参数名和类型按页面登记表核对，未登记参数、空值、false、空数组一律省略 */
export function pageHref<P extends PageId>(page: P, params?: PageParamsInput<P>): string;
export function pageHref(page: PageId, params?: Record<string, unknown>): string {
  return buildHref(page, params);
}

/** 从完整地址（#页面?参数）或搜索串（?a=1 / a=1）取出查询参数；带了别的页面或未知页面编号时返回空 */
function queryOf(page: PageId, hashOrSearch: string): URLSearchParams {
  if (!hashOrSearch) return new URLSearchParams();
  if (hashOrSearch.startsWith('?')) return new URLSearchParams(hashOrSearch.slice(1));
  const at = hashOrSearch.indexOf('?');
  if (hashOrSearch.startsWith('#')) {
    if (pageIdOf(hashOrSearch) !== page) return new URLSearchParams();
    return new URLSearchParams(at >= 0 ? hashOrSearch.slice(at + 1) : '');
  }
  if (at >= 0) {
    const head = hashOrSearch.slice(0, at);
    // 裸查询串的值本身可能带 ?（如 q=A?B&order=42）：? 前含 = 就按完整查询串读
    if (head.includes('=')) return new URLSearchParams(hashOrSearch);
    return head === page ? new URLSearchParams(hashOrSearch.slice(at + 1)) : new URLSearchParams();
  }
  return hashOrSearch.includes('=') ? new URLSearchParams(hashOrSearch) : new URLSearchParams();
}

/** 读取某个页面的查询参数（按登记的类型解析，不认识的取值忽略） */
export function pageParams<P extends PageId>(page: P, hashOrSearch?: string): PageParams<P>;
export function pageParams(page: PageId, hashOrSearch = ''): Record<string, unknown> {
  return pageReaders[page](queryOf(page, hashOrSearch));
}

/** 保留地址里该页已登记的参数，替换或追加搜索词 q */
export function withPageQuery(href: string, q?: string): string {
  const id = pageIdOf(href);
  if (!id) throw new Error('页面不存在。');
  if (!q) return href;
  return buildHref(id, { ...pageReaders[id](queryOf(id, href)), q });
}

/** 保留该页已登记的其他查询参数，切换到指定页签 tab */
export function withPageTab<P extends TabbedPageId>(page: P, hash: string, tab: PageTab<P>): string {
  return buildHref(page, { ...pageReaders[page](queryOf(page, hash)), tab });
}

/** 单据详情的链接（单据页、仓库页、财务、识别导入、助手同一套地址） */
export function flowDocHref(kind: FlowKind, id: number, archived?: boolean): string {
  if (!flowKinds.includes(kind)) throw new Error('单据种类不对。');
  if (kind === 'delivery') return pageHref('warehouse', { kind: 'finished', deliveries: true, doc: id, archived });
  if (kind === 'arrival') return pageHref('warehouse', { arrivals: true, doc: id, archived });
  return pageHref('production', { view: kind === 'production' ? 'production' : undefined, doc: id, archived });
}

/** 生产页的两个子视图（电脑左侧导航和手机顶部切换共用这一份） */
export const productionViews = [
  {
    id: 'task',
    label: '生产任务',
    href: pageHref('production'),
    active: (route: string) => pageParams('production', route).view !== 'production',
  },
  {
    id: 'production',
    label: '完工记录',
    href: pageHref('production', { view: 'production' }),
    active: (route: string) => pageParams('production', route).view === 'production',
  },
] as const;

/** 仓储页的四个子视图（电脑左侧导航和手机顶部切换共用这一份） */
export const warehouseViews = [
  {
    id: 'stock',
    label: '库存',
    href: pageHref('warehouse'),
    active: (route: string) => {
      const p = pageParams('warehouse', route);
      return !p.arrivals && !p.deliveries && !p.flow;
    },
  },
  {
    id: 'arrivals',
    label: '到货',
    href: pageHref('warehouse', { arrivals: true }),
    active: (route: string) => pageParams('warehouse', route).arrivals,
  },
  {
    id: 'deliveries',
    label: '送货',
    href: pageHref('warehouse', { deliveries: true, kind: 'finished' }),
    active: (route: string) => pageParams('warehouse', route).deliveries,
  },
  {
    id: 'flow',
    label: '流水',
    href: pageHref('warehouse', { flow: true }),
    active: (route: string) => pageParams('warehouse', route).flow,
  },
] as const;
