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
/** 财务页面。需要 finance:view，导航和助手都按这个判断。 */
export const financePageTargets = {
  finance: '财务概览（理论和实际盈亏、经营报表）',
  'finance-flow': '月度台账（流水、补税率）',
  'finance-ar': '应收应付（压货款、账期、现结优惠、保证金、利息）',
  'finance-cash': '资金发票（收付款、银行流水、票据、发票）',
  'finance-costs': '费用资产工资',
  'finance-ledger': '凭证账簿',
  'finance-reports': '报表结账',
  'finance-settings': '财务设置',
} as const;
/** 只包含现有前端页面。 */
export const erpPages = {
  dashboard: '今日（首页、工作台、经营概览）',
  'ai-plugins': 'AI插件与工具管理（兼容入口）',
  orders: '订单（客户订单、销售订单）',
  purchases: '采购单（采购订货）',
  customers: '客户',
  suppliers: '供应商',
  products: '产品',
  production: '生产任务（生产管理）',
  warehouse: '库存（仓库）',
  'document-templates': '单据模板',
  inbox: '收件箱',
  'ai-import': 'AI 导入（AI智能订单导入）',
  'ai-settings': '设置（AI设置）',
  trash: '归档',
  guide: '使用说明',
  arrivals: '到货',
  'ai-prompts': '提示词',
  ...financePageTargets,
} as const;
export const erpPageIds = Object.keys(erpPages) as (keyof typeof erpPages)[];
export const registeredErpPages = erpPages;
export const registeredErpPageIds: string[] = erpPageIds;
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
export const navigationTargets = [...registeredErpPageIds, ...Object.keys(navigationAliases)];
export function isErpNavigation(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    !/[\r\n\u0000]/.test(url) &&
    /^#[a-z-]+(?:\?[^#]*)?$/.test(url) &&
    registeredErpPageIds.includes(url.slice(1).split('?')[0])
  );
}
export function pageLink(page: string, q?: string) {
  const url = navigationAliases[page] || (registeredErpPageIds.includes(page) ? '#' + page : null);
  if (!url) throw new Error('页面不存在。');
  return url + (q ? (url.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(q) : '');
}
