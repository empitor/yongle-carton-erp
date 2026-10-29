export const assistantManagementHash = '#ai-settings?tab=tools';
export function normalizeAiSettingsHash(hash: string) {
  const [page, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  if (page === '#document-templates') {
    params.set('tab', 'templates');
    return '#ai-settings?' + params.toString();
  }
  if (page === '#ai-plugins' || (page === '#ai-settings' && params.get('tab') === 'plugins')) {
    params.set('tab', 'tools');
    return '#ai-settings?' + params.toString();
  }
  return hash;
}
export function aiSettingsTab(hash: string): 'api' | 'prompts' | 'tools' | 'templates' {
  const [page, query = ''] = normalizeAiSettingsHash(hash).split('?');
  const tab = new URLSearchParams(query).get('tab');
  return tab === 'templates'
    ? 'templates'
    : tab === 'tools'
      ? 'tools'
      : tab === 'prompts' || page === '#ai-prompts'
        ? 'prompts'
        : 'api';
}
/** 只包含现有前端页面；前端导航及后端ui.open共用。 */
export const erpPages = {
  dashboard: '业务工作台',
  'ai-plugins': 'AI插件与工具管理（兼容入口）',
  orders: '客户订单',
  purchases: '采购订货',
  customers: '客户管理',
  suppliers: '供应商管理',
  products: '产品管理',
  production: '生产管理',
  warehouse: '仓库管理',
  'document-templates': '单据模板',
  'ai-import': 'AI智能订单导入',
  'ai-settings': 'AI设置',
  trash: '归档记录',
  guide: '使用说明',
  arrivals: '采购到货',
  'ai-prompts': 'AI提示词',
} as const;
export const erpPageIds = Object.keys(erpPages) as (keyof typeof erpPages)[];
export const navigationAliases: Record<string, string> = {
  'document-templates': '#ai-settings?tab=templates',
  'ai-plugins': assistantManagementHash,
  raw_inventory: '#warehouse?kind=raw',
  finished_inventory: '#warehouse?kind=finished',
  production_tasks: '#production',
  production_records: '#production?view=production',
  deliveries: '#warehouse?kind=finished&deliveries=1',
  arrivals: '#warehouse?arrivals=1',
  arrival_plans: '#warehouse?arrivals=1',
  delivery_plans: '#warehouse?kind=finished&deliveries=1',
  movements: '#warehouse?flow=1',
};
export const navigationTargets = [...erpPageIds, ...Object.keys(navigationAliases)];
export function isErpNavigation(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    !/[\r\n\u0000]/.test(url) &&
    /^#[a-z-]+(?:\?[^#]*)?$/.test(url) &&
    erpPageIds.includes(url.slice(1).split('?')[0] as keyof typeof erpPages)
  );
}
export function pageLink(page: string, q?: string) {
  const url =
    navigationAliases[page] ||
    (erpPageIds.includes(page as keyof typeof erpPages) ? '#' + page : null);
  if (!url) throw new Error('页面不存在。');
  return url + (q ? (url.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q) : '');
}
