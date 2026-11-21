// 助手按账号能读到什么、能办什么：出纳读不了业务记录；读已归档的和全部记录要超级管理员模式；
// 要超级管理员模式的事分两类说法（业务员说没有权限，没进模式的超级管理员叫他去系统维护进入），页面服务同一个分法。
// 内存库、虚构数据。
import { pageActor, actor, superActor } from './actor-fixture.js';
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PurchaseReturns } from '../server/flow/returns.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { today } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import { autoConfirmAssistant } from './assistant-fixture.js';
import { AppError } from '../server/core/errors.js';
import type { Actor } from '../server/core/index.js';
import { readAs } from './read-result.js';

const cashier = pageActor({ id: 'fictional-cashier', name: '虚构出纳', role: 'admin' as const, permissions: ['finance:view', 'finance:cash'] });
const notElevated = () => ({ ...superActor(), superAdminMode: false, superAdminUntil: undefined });

test('出纳账号：ui.open 带编号、records.get 和聊天上下文预读都不能读业务记录', async () => {
  const f = autoConfirmAssistant();
  try {
    const secretName = '虚构出纳不可见客户甲';
    const customer = businessBase(actor, f.store).customer({ name: secretName });
    assert.throws(
      () => f.manager.tools.read('ui.open', { module: 'customers', id: customer.id }, cashier),
      /出纳账号只能查看财务数据/,
    );
    assert.throws(
      () => f.manager.tools.read('ui.open', { module: 'orders' }, cashier),
      /出纳账号只能查看财务数据/,
    );
    assert.throws(
      () => f.manager.tools.read('records.get', { module: 'customers', id: customer.id }, cashier),
      /出纳账号只能查看财务数据/,
    );
    assert.throws(
      () => f.manager.tools.read('records.search', { module: 'customers' }, cashier),
      /出纳账号只能查看财务数据/,
    );
    assert.equal(
      readAs(f.manager.tools.read('ui.open', { module: 'finance-cash' }, cashier), {}).url,
      '#finance-cash',
    );
    assert.equal(readAs(f.manager.tools.read('ui.open', { module: 'guide' }, cashier), {}).url, '#guide');
    // 普通业务账号照常能按编号打开记录。
    assert.equal(
      readAs(f.manager.tools.read('ui.open', { module: 'customers', id: customer.id }, actor), { record: z.looseObject({}) }).record.name,
      secretName,
    );
    const t = f.manager.create(cashier);
    await f.manager.chat(
      t.id,
      f.input('这是什么', randomUUID(), {
        page: '#customers',
        module: 'customers',
        id: customer.id,
      }),
      cashier,
      'session',
      () => {},
      () => cashier,
    );
    assert.ok(f.requests.length > 0);
    assert.doesNotMatch(JSON.stringify(f.requests.map((r) => r.body)), new RegExp(secretName));
  } finally {
    f.close();
  }
});

test('已归档的记录：普通账号读不到，进了超级管理员模式的照常读', () => {
  const f = autoConfirmAssistant();
  try {
    const p = businessBase(actor, f.store).product({ name: '虚构归档产品' }),
      owner = superActor();
    f.manager.tools.commit(f.manager.tools.prepare('records.propose_lifecycle', { module: 'products', id: p.id, action: 'archive' }, owner, 's'), owner, 's');
    assert.throws(() => f.manager.tools.read('records.get', { module: 'products', id: p.id }, actor));
    assert.equal(readAs(f.manager.tools.read('records.get', { module: 'products', id: p.id }, owner), { record: z.looseObject({}) }).record.name, p.name);
  } finally {
    f.close();
  }
});

test('助手读全部记录（含已归档）：业务员直接说没有权限（permission），没进模式的超级管理员提示去系统维护进入（super-mode），进了模式照常读', () => {
  const f = autoConfirmAssistant();
  try {
    const customer = businessBase(actor, f.store).customer({ name: '虚构读全部客户' });
    const calls = [
      ['records.get', { module: 'customers', id: customer.id, lifecycle: 'all' }],
      ['records.search', { module: 'customers', filters: { lifecycle: 'all' } }],
      ['records.search', { module: 'customers', filters: { archived: true } }],
    ] as const;
    for (const [name, args] of calls) {
      const label = name + ' ' + JSON.stringify(args);
      assert.throws(
        () => f.manager.tools.read(name, args, actor),
        (e: unknown) =>
          e instanceof AppError &&
          e.status === 403 &&
          e.code === 'permission' &&
          e.message === '读取全部记录（含已归档）要用超级管理员账号，当前账号没有这个权限。' &&
          !/系统维护|进入超级管理员模式/.test(e.message),
        '业务员 ' + label,
      );
      assert.throws(
        () => f.manager.tools.read(name, args, notElevated()),
        (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'super-mode' && /系统维护/.test(e.message) && /进入超级管理员模式/.test(e.message),
        '没进模式的超级管理员 ' + label,
      );
      assert.doesNotThrow(() => f.manager.tools.read(name, args, superActor()), '进了模式 ' + label);
    }
    // 只读已归档的、读在用的不用这个模式
    assert.doesNotThrow(() => f.manager.tools.read('records.search', { module: 'customers', filters: { lifecycle: 'archived' } }, actor));
    assert.equal(readAs(f.manager.tools.read('records.get', { module: 'customers', id: customer.id }, actor), { record: z.looseObject({}) }).record.name, '虚构读全部客户');
  } finally {
    f.close();
  }
});

test('要超级管理员模式的事统一分两类：业务员让助手撤销生产任务、完工、采购退货，原因直接说没有权限，不叫他进模式；没进模式的超级管理员才提示去系统维护', async () => {
  const f = autoConfirmAssistant();
  try {
    const base = businessBase(actor, f.store),
      { flow, ops } = base;
    const product = base.product({ name: '虚构撤销权限纸箱' });
    const raw = base.raw({ name: '虚构撤销权限纸板' }, { quantity: '50', date: today() });
    const confirm = (doc: { id: number }) => base.check(doc);
    const task = flow.save('task', { date: today(), plannedDate: today(), productId: product.id, quantity: '30', unit: '只', orderIds: [], notes: '' }, actor);
    const done = confirm(
      flow.save('production', { date: today(), productId: product.id, taskId: task.id, goodQuantity: '10', scrapQuantity: '0', operator: '虚构机长', materials: [{ stockId: raw.id, issued: '5', returned: '0' }] }, actor),
    );
    const waitingBoss = notElevated();
    const ask = async (who: Actor, name: string, args: Record<string, unknown>) => {
      const t = f.manager.create(who);
      f.replies.length = 0;
      f.replies.push({ message: '', toolCalls: [{ name, args }] }, { message: '' });
      const v = await f.manager.chat(t.id, f.input('撤销这张', randomUUID()), who, 'session', () => {}, () => who);
      const last = v.messages.at(-1);
      assert.ok(last, '有回复');
      return last;
    };
    const cases = [
      ['flow.propose_reversal', { id: done.id, reason: '虚构登记错了' }, '撤销完工'],
      ['flow.propose_reversal', { id: task.id, reason: '虚构排错了' }, '撤销生产任务'],
      // 退货单号随便填：权限在读单子之前就拦下，不出一张必然失败的卡片
      ['purchase_return.reverse', { id: 999, version: 1, reason: '虚构退错了' }, '撤销采购退货'],
    ] as const;
    for (const [name, args, what] of cases) {
      const staff = await ask(actor, name, args);
      assert.equal(staff.plans?.length, 0, what + ' 业务员不出卡片');
      // 原因原样交给模型（由它用自己的话说），服务器不替它拼回复
      assert.equal(staff.facts?.failed[0].message, what + '要用超级管理员账号，当前账号没有这个权限。', what);
      assert.doesNotMatch(String(staff.facts?.failed[0].message), /系统维护|进入超级管理员模式/);
      const waiting = await ask(waitingBoss, name, args);
      assert.equal(waiting.plans?.length, 0);
      assert.equal(waiting.facts?.failed[0].message, what + '要先在账号菜单的“系统维护”里验证密码，进入超级管理员模式。', what);
    }
    // 页面走的服务同一个分法：类别 permission / super-mode，兜底白名单都认
    const input = { version: done.version, reason: '虚构', acknowledged: true };
    assert.throws(() => flow.reverse(done.id, input, actor), (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'permission' && e.message === '撤销完工要用超级管理员账号，当前账号没有这个权限。');
    assert.throws(() => flow.reverse(task.id, { ...input, version: task.version }, waitingBoss), (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'super-mode' && /^撤销生产任务要先在账号菜单的“系统维护”/.test(e.message));
    const returns = new PurchaseReturns(f.store);
    assert.throws(() => returns.reverse(actor, 999, { version: 1, reason: '虚构' }), (e: unknown) => e instanceof AppError && e.code === 'permission' && e.message === '撤销采购退货要用超级管理员账号，当前账号没有这个权限。');
    assert.throws(() => returns.reverse(waitingBoss, 999, { version: 1, reason: '虚构' }), (e: unknown) => e instanceof AppError && e.code === 'super-mode' && /系统维护/.test(e.message));
    // 更正完工单（和撤销完工同一级）同一个分法：出方案时服务就拦下
    const fix = { id: done.id, expectedVersion: flow.get(done.id).version, reason: '虚构', goodQuantity: '9' };
    assert.throws(() => f.manager.tools.prepare('production.correct', fix, actor, 's'), (e: unknown) => e instanceof AppError && e.code === 'permission' && e.message === '更正完工要用超级管理员账号，当前账号没有这个权限。');
    assert.throws(() => f.manager.tools.prepare('production.correct', fix, waitingBoss, 's'), (e: unknown) => e instanceof AppError && e.code === 'super-mode' && /系统维护/.test(e.message));
    assert.equal(flow.get(done.id).status, 'confirmed', '都没撤成');
    assert.equal(flow.get(task.id).status, 'confirmed');
    const archiveFail = (who: Actor) => {
      const item = ops.items(true, raw.id)[0];
      return changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: raw.id, version: item.version }] }, who).results[0].message;
    };
    // 还有库存时不按账号分，一律引导先出库或盘点清零，不提删除
    for (const who of [actor, superActor(), waitingBoss])
      assert.equal(archiveFail(who), '库存还不是零，不能归档；先出库或盘点清零，再归档。');
  } finally {
    f.close();
  }
});
