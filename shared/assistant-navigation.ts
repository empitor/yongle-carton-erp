/** 只包含现有前端页面；前端导航及后端ui.open共用。 */
export const erpPages = {
  dashboard: '经营概览',
  orders: '客户订单',
  purchases: '采购订货',
  customers: '客户管理',
  suppliers: '供应商管理',
  products: '产品管理',
  production: '生产管理',
  warehouse: '仓库管理',
  'ai-import': 'AI智能订单导入',
  'ai-settings': 'AI设置',
  trash: '归档记录',
  guide: '使用说明',
  arrivals: '采购到货',
  'ai-prompts': 'AI提示词',
} as const;
export const erpPageIds = Object.keys(erpPages) as (keyof typeof erpPages)[];
export const navigationAliases: Record<string, string> = {
  raw_inventory: '#warehouse?kind=raw',
  finished_inventory: '#warehouse?kind=finished',
  production_tasks: '#production',
  production_records: '#production?view=production',
  deliveries: '#warehouse?kind=finished&deliveries=1',
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
