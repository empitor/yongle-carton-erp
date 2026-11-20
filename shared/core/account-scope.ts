/**
 * 纯财务账号（目前就是“出纳”级别）：有财务权限、没有业务编辑权限、不是超级管理员。
 * 按常见做法只看财务：收付款、银行、往来、凭证报表，看不到订单、客户文件和收件箱。
 * “只读”级别的账号是专门看业务的，不受影响；“财务”级别带业务编辑权限，也不受影响。
 */
export function financeOnlyAccount(
  actor: { role?: string; permissions?: readonly string[] } | null | undefined,
) {
  if (!actor || actor.role === 'super_admin') return false;
  const permissions = actor.permissions || [];
  return permissions.some((p) => p.startsWith('finance:')) && !permissions.includes('business:edit');
}

/** 纯财务账号能访问的接口：登录、财务、助手（工具另按下面的规则拦）、使用手册、健康检查，还有页面报错上报（/api/diagnostics 下只有这一个只写的地址）。 */
const financeOnlyApis = ['/api/auth', '/api/finance', '/api/assistant', '/api/guide', '/api/health', '/api/diagnostics'];
/**
 * Express 路由不分大小写、也认连续斜杠，判断前先统一成小写单斜杠，
 * 否则 /API/customers 这类写法能绕过出纳拦截。
 */
export function normalizeApiPath(path: string) {
  return path.toLowerCase().replace(/\/{2,}/g, '/');
}
export function financeOnlyApiAllowed(path: string) {
  const value = normalizeApiPath(path);
  return financeOnlyApis.some((p) => value === p || value.startsWith(p + '/'));
}

/**
 * 纯财务账号能用的助手工具：财务工具，以及页面浏览、聊天记录、
 * 自己上传的聊天附件、打开页面、系统状态这些不涉及业务数据的通用工具；还有联网、使用说明、
 * 自己的出错记录（diagnostics.errors 对非超级管理员只给本人的）。
 */
const financeOnlyToolPrefixes = ['finance.', 'page.', 'chat.', 'attachments.', 'ui.'];
const financeOnlyTools = ['system.status', 'system.check', 'web.search', 'web.read', 'guide.read', 'diagnostics.errors'];
export function financeOnlyToolAllowed(name: string) {
  return financeOnlyTools.includes(name) || financeOnlyToolPrefixes.some((p) => name.startsWith(p));
}

/** 纯财务账号能打开的页面。 */
export function financeOnlyPageAllowed(page: string) {
  return page.startsWith('finance') || page === 'guide';
}
