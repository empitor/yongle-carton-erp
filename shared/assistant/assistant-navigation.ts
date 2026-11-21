import { modulePages } from './assistant-modules.js';

export const assistantManagementHash = '#ai-settings?tab=tools';
const settingsTabParam = (hash: string) => new URLSearchParams(hash.split('?')[1] || '').get('tab');
export function aiSettingsTab(hash: string): 'api' | 'prompts' | 'tools' | 'templates' {
  const tab = settingsTabParam(hash);
  return tab === 'templates' ? 'templates' : tab === 'tools' ? 'tools' : tab === 'prompts' ? 'prompts' : 'api';
}
/**
 * 设置里人人都能看的页签。其余（API 配置、提示词、消息接入、高级）只给超级管理员账号：
 * 别的账号设置页里只有这一个页签（src/AiSettingsHub.tsx），助手也不替他们打开那几个（ui.open）。
 */
export const everyoneSettingsTab = 'templates';
/** 这个页面链接是不是设置里只给超级管理员账号的页签；没写页签的打开各人能看的那一页，不算 */
export function adminSettingsLink(url: string) {
  const tab = settingsTabParam(url);
  return url.slice(1).split('?')[0] === 'ai-settings' && tab !== null && tab !== everyoneSettingsTab;
}
/** 财务页面。需要 finance:view，导航和助手都按这个判断。 */
export const financePageTargets = {
  finance: '财务概览（理论和实际盈亏、经营报表）',
  'finance-flow': '月度台账（流水、补税率）',
  'finance-ar': '应收应付（欠款明细、到期和计划、对账单、账期、保证金、利息）',
  'finance-cash': '资金发票（收付款、银行流水、票据、发票）',
  'finance-costs': '费用资产工资',
  'finance-ledger': '凭证账簿',
  'finance-reports': '报表结账',
  'finance-settings': '财务设置',
} as const;
/** 只包含现有前端页面。 */
export const erpPages = {
  dashboard: '今日（首页、工作台、经营概览）',
  orders: '订单（客户订单、销售订单）',
  purchases: '采购单（采购订货）',
  customers: '客户',
  suppliers: '供应商',
  products: '产品',
  production: '生产任务（生产管理）',
  warehouse: '库存（仓库）',
  inbox: '收件箱',
  'ai-import': 'AI 导入（AI智能订单导入）',
  'ai-settings': '设置（AI设置）',
  accounts: '账号管理（新建账号、审批申请、重置密码）',
  trash: '归档',
  guide: '使用说明',
  ...financePageTargets,
} as const;
const isErpPage = (id: string): id is keyof typeof erpPages => Object.hasOwn(erpPages, id);
export const erpPageIds = Object.keys(erpPages).filter(isErpPage);
const registeredErpPageIds: string[] = erpPageIds;
export const navigationAliases: Record<string, string> = {
  // 设置里的几个页签（助手按名字打开）
  'document-templates': '#ai-settings?tab=templates',
  'ai-plugins': assistantManagementHash,
  'ai-prompts': '#ai-settings?tab=prompts',
  // 助手的模块名（原材料库存、到货、流水这些）打开各自的页面（assistant-modules.ts）
  ...modulePages,
  delivery_plans: '#warehouse?kind=finished&deliveries=1',
};
/** 至少有一项的列表（给 z.enum 用） */
function nonEmpty<T>(list: T[]): [T, ...T[]] {
  const [first, ...rest] = list;
  if (first === undefined) throw new Error('列表是空的');
  return [first, ...rest];
}
/** 助手能打开的全部页面和别名（ui.open 的 module 取值） */
export const navigationTargets = nonEmpty([...registeredErpPageIds, ...Object.keys(navigationAliases)]);
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
