// 按账号判断能不能做（server/core/permissions.ts、shared/core/account-scope.ts）：纯函数，虚构账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  includeArchivedFor,
  isSuperMode,
  requirePermission,
  requireSuperModeFor,
  superModeDenied,
} from '../server/core/permissions.js';
import {
  financeOnlyAccount,
  financeOnlyApiAllowed,
  financeOnlyPageAllowed,
  financeOnlyToolAllowed,
} from '../shared/core/account-scope.js';
import { pageActor } from './actor-fixture.js';

const HOUR = 3600000;
const sales = pageActor({ id: 'fictional-sales', name: '虚构业务员', role: 'admin' as const, permissions: ['business:edit'] });
const boss = pageActor({ id: 'fictional-boss', name: '虚构老板', role: 'super_admin' as const, permissions: [] });
const inMode = { ...boss, superAdminMode: true, superAdminUntil: Date.now() + HOUR };

/** 抛出的错误的状态码、类别和文字 */
function denied(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (error instanceof Error && 'status' in error && 'code' in error) return [error.status, error.code, error.message];
    throw error;
  }
  return assert.fail('应该被拒绝');
}

test('没登录的报 401 请先登录；有这项权限的放行；没有的报 403 没有权限', () => {
  assert.deepEqual(denied(() => requirePermission(null, 'business:edit')), [401, 'authentication', '请先登录管理账号。']);
  assert.equal(requirePermission(sales, 'business:edit'), sales);
  assert.deepEqual(denied(() => requirePermission(sales, 'finance:view')), [403, 'permission', '当前账号没有执行此操作的权限。']);
});

test('超级管理员模式：只有超级管理员账号、进了模式、还没过期才算；在模式里任何权限都放行', () => {
  assert.equal(isSuperMode(inMode), true);
  assert.equal(requirePermission(inMode, 'finance:close'), inMode);
  assert.equal(isSuperMode({ ...inMode, superAdminUntil: Date.now() - HOUR }), false, '过期');
  assert.equal(isSuperMode({ ...inMode, superAdminUntil: undefined }), false, '没有期限');
  assert.equal(isSuperMode({ ...inMode, superAdminMode: false }), false, '没进模式');
  assert.equal(isSuperMode({ ...sales, superAdminMode: true, superAdminUntil: Date.now() + HOUR }), false, '不是超级管理员账号');
  assert.equal(isSuperMode(null), false);
  assert.deepEqual(denied(() => requirePermission(boss, 'finance:view')), [403, 'permission', '当前账号没有执行此操作的权限。']);
});

test('要超级管理员模式的事被拒：能进没进的叫人去系统维护，进不了的直接说没权限，句末补上给的半句', () => {
  assert.deepEqual(
    denied(() => requireSuperModeFor(boss, '撤销生产任务', { superMode: '虚构补充' })),
    [403, 'super-mode', '撤销生产任务要先在账号菜单的“系统维护”里验证密码，进入超级管理员模式；虚构补充。'],
  );
  assert.deepEqual(
    denied(() => requireSuperModeFor(sales, '撤销生产任务', { permission: '可以请管理员处理' })),
    [403, 'permission', '撤销生产任务要用超级管理员账号，当前账号没有这个权限；可以请管理员处理。'],
  );
  assert.equal(superModeDenied(sales, '撤销生产任务').message, '撤销生产任务要用超级管理员账号，当前账号没有这个权限。');
  assert.deepEqual(denied(() => requireSuperModeFor(null, '撤销生产任务')), [401, 'authentication', '请先登录管理账号。']);
  assert.equal(requireSuperModeFor(inMode, '撤销生产任务'), inMode);
});

test('列表带已归档的：all 要超级管理员模式，1 谁都能看，别的值不带', () => {
  assert.equal(includeArchivedFor(inMode, 'all'), true);
  assert.deepEqual(denied(() => includeArchivedFor(sales, 'all'))[1], 'permission');
  assert.equal(includeArchivedFor(sales, '1'), true);
  assert.equal(includeArchivedFor(sales, undefined), false);
  assert.equal(includeArchivedFor(sales, '0'), false);
});

test('纯财务账号：有财务权限、没有业务编辑、不是超级管理员', () => {
  const cashier = { role: 'admin', permissions: ['finance:view', 'finance:cash'] };
  assert.equal(financeOnlyAccount(cashier), true);
  assert.equal(financeOnlyAccount({ ...cashier, permissions: [...cashier.permissions, 'business:edit'] }), false);
  assert.equal(financeOnlyAccount({ ...cashier, role: 'super_admin' }), false);
  assert.equal(financeOnlyAccount({ role: 'admin', permissions: ['business:view'] }), false);
  assert.equal(financeOnlyAccount({ role: 'admin' }), false);
  assert.equal(financeOnlyAccount(null), false);
});

test('纯财务账号能访问的地址按小写单斜杠认，前缀要整段对上', () => {
  for (const ok of ['/api/finance', '/API//Finance/vouchers', '/api/auth/me', '/api/guide']) assert.equal(financeOnlyApiAllowed(ok), true, ok);
  for (const bad of ['/api/customers', '/API//Customers', '/api/financex', '/apix/finance']) assert.equal(financeOnlyApiAllowed(bad), false, bad);
});

test('纯财务账号能用的助手工具和页面', () => {
  const general = ['system.status', 'system.check', 'web.search', 'web.read', 'guide.read', 'diagnostics.errors'];
  for (const ok of ['finance.vouchers', 'page.read', 'chat.history', 'attachments.read', 'ui.open', ...general])
    assert.equal(financeOnlyToolAllowed(ok), true, ok);
  for (const bad of ['records.get', 'system.reset', 'financeX']) assert.equal(financeOnlyToolAllowed(bad), false, bad);
  assert.equal(financeOnlyPageAllowed('finance-cash'), true);
  assert.equal(financeOnlyPageAllowed('guide'), true);
  assert.equal(financeOnlyPageAllowed('orders'), false);
  assert.equal(financeOnlyPageAllowed('guides'), false);
});
