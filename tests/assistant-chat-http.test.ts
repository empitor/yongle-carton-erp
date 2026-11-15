// 助手会话本身：重开库后会话和提示词还在、当前记录从服务器读、写入只出卡片且只在本登录会话点得了、
// 清空会话作废没点的卡片、自定义提示词真的发出去；经接口聊天和点卡片。虚构数据，不发真实请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { actor, assistantFixture, flowFixture, lastCard, readAs, secret } from './assistant-fixture.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { OperationsService } from '../server/operations/service.js';
import { createBusinessService } from '../server/business/service.js';
import { startHttp } from './http-fixture.js';
import { Store } from '../server/core/db.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { assistantDefaultPreset } from '../server/ai/default-prompts/assistant.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { count } from '../server/core/index.js';
import { planCardSchema } from '../shared/assistant/index.js';

const call = (name: string, args: unknown) => ({ message: '', toolCalls: [{ name, args }] });
const audits = (f: { store: Store }) => count(f.store.db, 'SELECT COUNT(*) n FROM business_audit');
/** 会话里每条消息的卡片（经接口读回来的会话） */
const threadPlans = z.object({ messages: z.array(z.object({ plans: z.array(planCardSchema).optional() })) });

test('重开业务库和提示词库：会话、改过的提示词都在，档案没变；别的账号看不到这个会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-assistant-reopen-')),
    open = () => ({ store: new Store(join(dir, 'erp.sqlite')), prompts: new PromptPresetManager(join(dir, 'assistant.sqlite'), assistantDefaultPreset) });
  let files = open();
  let f = assistantFixture([call('records.search', { module: 'customers' }), { message: '已查到。' }], { store: files.store });
  try {
    const customer = files.store.saveCustomer(customerSchema.parse({ name: '虚构持久客户' }));
    const v = files.prompts.view(),
      preset = { ...structuredClone(v.presets[0]), name: '独立全局持久预设' };
    files.prompts.change('save', { expectedRevision: v.revision, preset, activate: true });
    const thread = f.manager.create(actor);
    await f.say(thread.id, '查询客户');
    f.close();
    files.prompts.close();
    files = open();
    f = assistantFixture([], { store: files.store });
    assert.equal(f.manager.view(thread.id, actor).messages.length, 2);
    assert.throws(() => f.manager.view(thread.id, { ...actor, id: 'other-user' }));
    assert.equal(files.prompts.view().presets[0].name, '独立全局持久预设');
    assert.deepEqual(files.store.customer(customer.id), customer);
  } finally {
    f.close();
    files.prompts.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('当前记录从服务器读给模型（不信页面带来的内容）：查询给出结果链接、流式发草稿，不写库，回复里没有密钥', async () => {
  const f = assistantFixture([call('records.search', { module: 'products', filters: { q: '虚构' } }), { message: '找到了虚构纸箱。' }]);
  try {
    const p = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱', requirements: '原始后端备注' }));
    const result = await f.say(f.manager.create(actor).id, '查询当前产品', { context: { page: '#products', module: 'products', id: p.id } });
    assert.equal(result.messages.at(-1)?.links?.[0].url, '#products?q=' + encodeURIComponent(p.name));
    assert.match(JSON.stringify(f.requests[0].body), /原始后端备注/);
    assert.equal(audits(f), 0);
    assert(f.events.some(([e]) => e === 'draft'));
    assert(!JSON.stringify(result).includes(secret));
  } finally {
    f.close();
  }
});

test('改当前记录：确认写入后给页面发业务刷新事件', async () => {
  const f = flowFixture();
  try {
    const customer = f.store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
      product = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
    const order = f.store.saveOrder(
      orderSchema.parse({ customerId: customer.id, orderDate: '2026-10-25', deliveryDate: '2026-10-30', status: '已确认', lines: [{ productId: product.id, productName: product.name, quantity: 100, unit: '只', unitPriceCents: 100 }] }),
    );
    f.replies.push(call('records.propose_save', { module: 'orders', id: order.id, patch: { deliveryDate: '2027-01-02' } }));
    await f.say(f.manager.create(actor).id, '把当前订单交期改为2027-01-02', { context: { page: '#orders', module: 'orders', id: order.id } });
    assert.equal(f.store.order(order.id)?.deliveryDate, '2027-01-02');
    assert(f.events.some(([e, d]) => e === 'effect' && d.type === 'business'));
  } finally {
    f.close();
  }
});

test('写入只出卡片：没点不写；别的登录会话点不了；点了走业务校验，再点拿回原结果不重复写；不能冒充人工或助手来源', async () => {
  const f = assistantFixture();
  try {
    const p = f.store.saveProduct(productSchema.parse({ name: '纸箱', requirements: '旧备注' }));
    f.replies.push(call('records.propose_save', { module: 'products', id: p.id, patch: { requirements: '人工确认后更新' } }));
    const plan = lastCard(await f.say(f.manager.create(actor).id, '修改这个产品的加工要求'));
    assert.equal(plan.state, 'waiting');
    assert.equal(f.store.product(p.id)?.requirements, '旧备注');
    assert.equal(audits(f), 0);
    assert.throws(() => f.manager.execute(plan.id, { acknowledged: true }, actor, 'another'), /登录会话/);
    const result = f.manager.execute(plan.id, { acknowledged: true }, actor, 's');
    assert.equal(field(result, 'requirements'), '人工确认后更新');
    const written = audits(f);
    assert.deepEqual(f.manager.execute(plan.id, { acknowledged: true }, actor, 's'), result);
    assert.equal(audits(f), written);
    const create = { entity: 'products', action: 'create', input: { name: '越权' } } as const;
    // @ts-expect-error 类型里没有的来源：守的是运行时传进来的别的来源照样被拒
    assert.throws(() => createBusinessService(f.store).execute(create, { source: 'ai', operatorId: actor.id }));
    assert.throws(() => createBusinessService(f.store).execute(create, { source: 'reviewed-assistant', operatorId: actor.id, approval: {} }));
  } finally {
    f.close();
  }
});

test('清空会话：没点的卡片作废，再点不执行', async () => {
  const f = assistantFixture();
  try {
    const p = f.store.saveProduct(productSchema.parse({ name: '测试产品' })),
      t = f.manager.create(actor);
    f.replies.push(call('records.propose_save', { module: 'products', id: p.id, patch: { requirements: '新' } }));
    const plan = lastCard(await f.say(t.id, '改备注'));
    f.manager.clear(t.id, actor);
    assert.equal(f.manager.view(t.id, actor).messages.length, 0);
    assert.throws(() => f.manager.execute(plan.id, { acknowledged: true }, actor, 's'), /作废/);
    assert.equal(f.store.product(p.id)?.requirements, '');
  } finally {
    f.close();
  }
});

test('自定义的助手提示词条目真的发给模型', async () => {
  const f = assistantFixture();
  try {
    const s = f.prompts.view(),
      p = s.presets[0];
    p.entries.push({ id: randomUUID(), name: '独立规则', enabled: true, content: 'GLOBAL_ASSISTANT_CUSTOM_RULE' });
    f.prompts.change('save', { expectedRevision: s.revision, preset: p, activate: true });
    await f.say(f.manager.create(actor).id, '你好');
    assert.match(JSON.stringify(f.requests[0].body), /GLOBAL_ASSISTANT_CUSTOM_RULE/);
  } finally {
    f.close();
  }
});

test('经接口聊天和点卡片：未登录 401、没页面凭证 403；高风险卡片照样点了才写；别的账号看不到会话、点不了卡片', async () => {
  const password = 'Fictional-assistant-password-123';
  const f = assistantFixture(),
    h = await startHttp(f.store, { aiSettings: f.settings, assistant: f.manager, admin: { name: '全局验收', password } });
  try {
    const req = (path: string, body?: unknown, cookie = h.cookie, csrf = true) => h.send(path, body, cookie, csrf ? {} : { csrf: null });
    assert.equal((await fetch(h.api + '/assistant')).status, 401);
    assert.equal((await req('/assistant/threads', {}, h.cookie, false)).status, 403);
    const t = readAs(await (await req('/assistant/threads', {})).json(), { id: z.string() });
    const lastPlan = async () => {
      const plan = threadPlans.parse(await (await req('/assistant/threads/' + t.id)).json()).messages.at(-1)?.plans?.[0];
      assert.ok(plan, '最后一条回复没有卡片');
      return plan;
    };
    f.replies.push(call('records.propose_save', { module: 'customers', patch: { name: '待审核客户' } }));
    const wire = await (await req('/assistant/threads/' + t.id + '/chat', f.input('新建测试客户', randomUUID()))).text();
    assert.match(wire, /event: result/);
    assert(!wire.includes(secret));
    const plan = await lastPlan();
    assert.equal(f.store.customers().length, 0);
    assert.equal((await req('/assistant/previews/' + plan.id + '/execute', { acknowledged: true })).status, 200);
    assert.equal(f.store.customers().at(0)?.name, '待审核客户');
    await req('/auth/super-admin/enter', { password });
    const ops = new OperationsService(f.store),
      item = ops.saveItem({ name: '高风险HTTP验收纸板', kind: 'raw', unit: '张' }, actor);
    f.replies.push(call('inventory.propose_movement', { id: item.id, action: 'in', quantity: '5', date: '2026-10-25', notes: '人工核对测试' }));
    await (await req('/assistant/threads/' + t.id + '/chat', f.input('增加5张库存', randomUUID()))).text();
    const high = await lastPlan();
    assert(high.highRisk);
    assert.equal(ops.repo.balance(item.id), 0);
    assert.equal((await req('/assistant/previews/' + high.id + '/execute', { acknowledged: true })).status, 200);
    assert.equal(ops.repo.balance(item.id), 5000);
    await req('/auth/users', { name: '只读第二账号', password: 'Fictional-viewer-123', level: 'viewer' });
    const reader = await h.login('只读第二账号', 'Fictional-viewer-123');
    assert.equal((await req('/assistant/threads/' + t.id, undefined, reader)).status, 404);
    assert.equal((await req('/assistant/previews/' + plan.id + '/execute', { acknowledged: true }, reader)).status, 404);
  } finally {
    await h.close();
    f.close();
  }
});
