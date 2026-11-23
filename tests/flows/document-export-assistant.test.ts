// 助手导出单据（documents.export、flow.daily 等命令）：和人工导出走同一个服务，写入要人点确认。假模型、内存库、虚构数据。
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantTools } from '../../server/assistant/tools.js';
import { AssistantToolRegistry } from '../../server/assistant/tool-registry.js';
import { assistantFixture, confirmCard, autoConfirmAssistant, lastCard, toolsOf } from '../support/assistant-fixture.js';
import { setup } from '../support/document-fixture.js';
import { count } from '../../server/core/index.js';
import { actor } from '../support/actor-fixture.js';
import { readAs } from '../support/read-result.js';

/** 生成好的导出文件：交付、回执要用编号和哈希 */
const exportedFile = z.looseObject({ exportId: z.string(), sha256: z.string() });

/** 助手提出“安排送货”（4000 只、10 月 30 日 9:30）并由人确认，返回建好的待送货单 */
function proposeDelivery(tools: AssistantTools, f: ReturnType<typeof setup>) {
  const lines = [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.stock.id, quantity: '4000' }];
  const patch = { date: '2026-10-29', plannedDate: '2026-10-30', plannedTime: '09:30', customerId: f.customer.id, lines };
  const plan = tools.prepare('records.propose_save', { module: 'deliveries', patch }, actor, 'test');
  return z.looseObject({ id: z.number(), version: z.number() }).parse(tools.commit(plan, actor, 'test'));
}

test('助手导出订货单：只出确认卡片，模型说“已订货”也不改，事实另记；人点确认、文件交付并回执后才已订货；查每日记录和人工同一份；没有权限不能导出', async () => {
  const a = assistantFixture(),
    f = setup(a.store);
  try {
    const t = a.manager.create(actor),
      request = f.exp('purchase', f.purchase.id);
    a.replies.push(
      { state: 'working', message: '查询今日到货', toolCalls: [{ name: 'flow.daily', args: { kind: 'arrival', date: '2026-10-29' } }] },
      { state: 'working', message: '准备文件', toolCalls: [{ name: 'documents.export', args: request }] },
      { state: 'completed', message: '已经正式订货成功。', toolCalls: [] },
    );
    const result = await a.manager.chat(t.id, a.input('导出Word并正式订货。', randomUUID()), actor, 'test', () => {}, () => actor);
    // 模型的话原样留着，服务器不改；事实另记：只出了一张待确认的卡片
    const reply = result.messages.at(-1);
    assert.ok(reply);
    assert.equal(reply.text, '已经正式订货成功。');
    assert.equal(reply.facts?.cards.length, 1);
    assert.ok(!reply.facts?.executed.some((e) => /导出|订货/.test(e.label)), JSON.stringify(reply.facts?.executed));
    assert.equal(reply.plans?.[0].state, 'waiting');
    assert.match(lastCard(result).label, /^导出订货单并标记已订货：/);
    assert.equal(f.current().businessStatus, '待订货');
    const done = readAs(await confirmCard(a, result, 0, actor, 'test'), { file: exportedFile });
    assert.equal(f.current().businessStatus, '待订货', '文件还没交付');
    f.docs.delivered(done.file.exportId, actor);
    f.docs.complete(done.file.exportId, done.file.sha256, actor);
    assert.equal(f.current().businessStatus, '已订货');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 1);
    assert.equal(readAs(toolsOf(a.store).read('flow.daily', { kind: 'arrival', date: '2026-10-29' }, actor), { summary: z.looseObject({}) }).summary.completed, 0);
    const registry = new AssistantToolRegistry();
    try {
      await assert.rejects(
        () => registry.dispatch('documents.export', request, { ...actor, permissions: [] }, { workflow: () => assert.fail('不应调用'), read: () => null, business: () => null }),
        /权限/,
      );
    } finally {
      registry.close();
    }
  } finally {
    a.close();
  }
});

test('助手导出遇到超长规格保留具体中文原因，不生成文件、不改变采购状态', async () => {
  const a = autoConfirmAssistant(),
    f = setup(a.store);
  try {
    const p = f.flow.stock.savePurchase(
      {
        ...f.current(),
        version: f.current().version,
        lines: f
          .current()
          .lines.map((l) => ({
            ...l,
            stockItemId: null,
            specification: '虚构长规格说明'.repeat(280),
          })),
      },
      actor,
      f.purchase.id,
    );
    const request = f.exp('purchase', p.id),
      t = a.manager.create(actor);
    a.replies.push(
      {
        state: 'working',
        message: '导出',
        toolCalls: [{ name: 'documents.export', args: request }],
      },
      { state: 'completed', message: '请按工具结果处理。', toolCalls: [] },
    );
    const view = await a.manager.chat(t.id, a.input('导出这张采购单，发给供应商订货。', randomUUID()), actor, 'test', () => {}, () => actor);
    // 出卡片前先排一遍版：排不下就不出卡片，具体原因原样交给模型
    const reply = view.messages.at(-1);
    assert.ok(reply);
    assert.equal(reply.plans?.length, 0);
    assert.equal(reply.facts?.failed.length, 1);
    const failure = reply.facts?.failed[0];
    assert.ok(failure);
    assert.match(failure.message, new RegExp(p.number));
    assert.match(failure.message, /第 1 行明细“规格及尺寸”.*缩短内容或换更大的纸张/);
    assert.equal(f.current().businessStatus, '待订货');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 0);
    assert.equal(count(f.store.db, "SELECT COUNT(*) n FROM business_audit WHERE action='generate'"), 0);
  } finally {
    a.close();
  }
});

test('助手安排送货、改期、核对出库和导出本批 Excel 走同一个服务，导出不再出库', async () => {
  const a = autoConfirmAssistant(),
    f = setup(a.store);
  try {
    const tools = toolsOf(f.store);
    const draft = proposeDelivery(tools, f);
    assert.equal(f.ops.balance(f.stock.id), 10000000);
    tools.commit(
      tools.prepare(
        'flow.schedule',
        {
          id: draft.id,
          plannedDate: '2026-11-02',
          plannedTime: '16:00',
          expectedVersion: draft.version,
          requestId: randomUUID(),
        },
        actor,
        'test',
      ),
      actor,
      'test',
    );
    assert.equal(
      readAs(tools.read('flow.daily', { kind: 'delivery', date: '2026-11-02' }, actor), { summary: z.looseObject({}) }).summary.pending,
      1,
    );
    tools.commit(
      tools.prepare('flow.propose_confirmation', { id: draft.id }, actor, 'test'),
      actor,
      'test',
    );
    const before = f.ops.balance(f.stock.id),
      t = a.manager.create(actor);
    a.replies.push(
      {
        state: 'working',
        message: '导出本批送货',
        toolCalls: [{ name: 'documents.preview', args: { kind: 'delivery', id: draft.id } }],
      },
      {
        state: 'working',
        message: '生成文件',
        toolCalls: [
          { name: 'documents.export', args: f.exp('delivery', draft.id, { format: 'xlsx' }) },
        ],
      },
      { state: 'completed', message: '本批送货单已交付。', toolCalls: [] },
    );
    await a.manager.chat(
      t.id,
      a.input('将本批4000只的正式送货单导出Excel。', randomUUID()),
      actor,
      'test',
      (event: string, data: unknown) => {
        if (event === 'effect' && readAs(data, { type: z.string() }).type === 'download') {
          const { file } = readAs(data, { file: exportedFile });
          f.docs.delivered(file.exportId, actor);
          f.docs.complete(file.exportId, file.sha256, actor);
        }
      },
      () => actor,
    );
    assert.equal(f.ops.balance(f.stock.id), before);
    assert.equal(f.docs.form('delivery', draft.id).form.rows[0][4], '4000');
  } finally {
    a.close();
  }
});
