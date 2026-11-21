// 出卡片的两道守卫（server/assistant/tools/card-summary.ts、card-targets.ts）：
// 试执行时执行函数返回要等的结果（Promise）就不试；读目标记录时只有“查不到”算没有，库里的数据坏了照常报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoredDataError } from '../server/core/errors.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { PROMISE_REFUSED } from '../server/assistant/tools/card-rehearsal.js';
import { withCard } from '../server/assistant/tools/card-summary.js';
import { readTarget } from '../server/assistant/tools/card-targets.js';
import type { ToolContext } from '../server/assistant/tools/context.js';
import { planCardSchema } from '../shared/assistant/index.js';
import { autoConfirmAssistant } from './assistant-fixture.js';
import { superActor } from './actor-fixture.js';

/** 工具上下文：和外壳给的一样，执行函数换成测试给的 */
function context(f: ReturnType<typeof autoConfirmAssistant>, commit: () => unknown): ToolContext {
  const tools = f.manager.tools;
  return {
    store: f.store,
    ops: tools.ops,
    flow: tools.flow,
    services: {},
    tools: { read: () => undefined, prepare: (tool, raw, who, binding) => tools.prepare(tool, raw, who, binding), commit },
  };
}

test('出卡片试执行时执行函数返回要等的结果（Promise）：拒绝，不出卡片（回滚之后它接着写的会真的落库）', () => {
  const f = autoConfirmAssistant(),
    who = localAdministratorActor(superActor());
  try {
    const c = f.store.saveCustomer(customerSchema.parse({ name: '虚构客户' }));
    const { summary: _summary, ...plan } = f.manager.tools.prepare('records.propose_save', { module: 'customers', id: c.id, patch: { phone: '111' } }, who, 'card');
    const later = context(f, () => Promise.resolve({ id: c.id }));
    assert.throws(() => withCard(later, plan, who, 'card'), (e: unknown) => e instanceof Error && e.message === PROMISE_REFUSED);
  } finally {
    f.close();
  }
});

test('读目标记录：查不到的算没有；库里的单据内容对不上结构照常报错，不当成“没有这条”', () => {
  const f = autoConfirmAssistant(),
    who = localAdministratorActor(superActor());
  try {
    const ctx = context(f, () => undefined);
    const task = f.manager.tools.flow.save('task', { date: '2026-10-20', productId: f.store.saveProduct(productSchema.parse({ name: '虚构纸箱' })).id, quantity: '10', unit: '只', orderIds: [], notes: '' }, who);
    assert.equal(readTarget(ctx, { module: 'task', id: task.id + 1 }, who), undefined);
    assert.equal(readTarget(ctx, { module: 'customers', id: 999, assistant: 'customers' }, who), undefined);
    f.store.db.prepare("UPDATE flow_documents SET document=json_set(document,'$.quantity','不是数量') WHERE id=?").run(task.id);
    assert.throws(() => readTarget(ctx, { module: 'task', id: task.id }, who), StoredDataError);
  } finally {
    f.close();
  }
});

test('删除卡片上改“库存怎么处理”：写进聊天记录的卡片合卡片的结构，和回给页面的是同一份', async () => {
  const f = autoConfirmAssistant(),
    who = superActor();
  try {
    const c = f.store.saveCustomer(customerSchema.parse({ name: '虚构要删的客户' }));
    const thread = f.manager.create(who);
    f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'customers', id: c.id } }] });
    await f.say(thread.id, '把客户 虚构要删的客户 删掉', {}, who);
    const shown = () =>
      f.store.db.prepare("SELECT json_extract(document,'$.plans[0]') AS plan FROM assistant_messages WHERE thread_id=? AND json_type(document,'$.plans')='array'").get(thread.id)?.plan;
    const card = f.manager.changeDeletionPolicy(planCardSchema.parse(JSON.parse(String(shown()))).id, { inventoryPolicy: 'preserve' }, who, 's');
    assert.deepEqual(planCardSchema.parse(JSON.parse(String(shown()))), card);
  } finally {
    f.close();
  }
});
