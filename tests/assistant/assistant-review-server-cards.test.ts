// 助手核对区按结构读卡片：喂服务端真实生成的卡片（删除、改资料、导出）和执行结果，核对区该显示的都认得出；
// 导出卡片确认后文件下载失败，照样刷新会话、交回助手接着办。内存库、虚构数据，模型用替身。
import { sales } from '../../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { customerSchema } from '../../shared/core/domain.js';
import { jsonValue, type ThreadView } from '../../shared/assistant/index.js';
import { reviewView } from '../../src/assistant/review-view.js';
import { afterExecuted, type ExecutedEffects } from '../../src/assistant/review-actions.js';
import { readExportFile } from '../../src/assistant/chat-events.js';
import { assistantFixture, lastCard } from '../support/assistant-fixture.js';
import { flowFixture as businessFlow } from '../support/flow-fixture.js';
import { actor, superActor } from '../support/actor-fixture.js';

/** 页面经接口拿到的执行结果：JSON 往返一次（和 HTTP 一样），按对象读 */
const executedResult = (raw: unknown) => z.record(z.string(), jsonValue).parse(JSON.parse(JSON.stringify(raw)));

/** 一张已入库 1000 张的到货单，助手提出把它删掉（动过库存，卡片上让人选库存怎么处理） */
async function arrivalDeleteCard() {
  const who = superActor();
  const b = businessFlow(who);
  const f = assistantFixture([], { store: b.store });
  const arrival = b.arrive('FICT-REVIEW-1', '1000');
  const thread = f.manager.create(who);
  f.replies.push({ message: '', toolCalls: [{ name: 'records.delete', args: { module: 'arrivals', id: arrival.id } }] });
  const plan = lastCard(await f.say(thread.id, '把这张到货单删掉', {}, who));
  return { f, who, thread, plan, arrival };
}

test('删除动过库存的单据的卡片：核对区认得出选了哪张、库存怎么处理，删除标题按选中的算', async () => {
  const { f, plan, arrival } = await arrivalDeleteCard();
  try {
    const v = reviewView(plan);
    assert.equal(v.choosePolicy, true, '动过库存才让人选');
    assert.equal(v.policy, 'recalculate');
    assert.equal(v.impactPlan?.selection?.module, 'arrival');
    assert.deepEqual(
      v.impactPlan?.selection?.items.map((i) => i.id),
      [arrival.id],
    );
    assert.ok(v.headline, '删除方案有删除标题');
    assert.equal(v.headline.alarming, true, '删到库存流水：红色实心、焦点先放关闭');
    assert.ok(v.impactPlan.impact.length > 0);
    assert.ok(v.requiresPassword);
  } finally {
    f.close();
  }
});

test('删除卡片改成“库存数量不动”：服务器回的新方案和会话里重读的卡片，核对区都显示 preserve', async () => {
  const { f, who, thread, plan } = await arrivalDeleteCard();
  try {
    const next = f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'preserve' }, who, 's');
    assert.equal(reviewView(next).policy, 'preserve');
    assert.ok(reviewView(next).headline);
    const reread = f.manager
      .view(thread.id, who)
      .messages.flatMap((m) => m.plans ?? [])
      .find((p) => p.id === plan.id);
    assert.ok(reread);
    assert.equal(reviewView(reread).policy, 'preserve');
    // 再改回来：下拉框跟着回到 recalculate
    const back = f.manager.changeDeletionPolicy(plan.id, { inventoryPolicy: 'recalculate' }, who, 's');
    assert.equal(reviewView(back).policy, 'recalculate');
  } finally {
    f.close();
  }
});

test('改资料的卡片：不是删除方案，核对区按服务器写好的逐行内容和提醒显示', async () => {
  const f = assistantFixture();
  try {
    const customer = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构改资料客户' }));
    const thread = f.manager.create(actor);
    f.replies.push({
      message: '',
      toolCalls: [{ name: 'records.propose_save', args: { module: 'customers', id: customer.id, patch: { phone: '0574-0000000' } } }],
    });
    const plan = lastCard(await f.say(thread.id, '把虚构改资料客户的电话改一下', {}, actor));
    const v = reviewView(plan);
    assert.equal(v.headline, null);
    assert.equal(v.impactPlan, null);
    assert.equal(v.choosePolicy, false);
    assert.ok(v.summary.length > 0);
    assert.deepEqual(v.summary, plan.summary);
    assert.deepEqual(v.warnings, plan.warnings ?? []);
  } finally {
    f.close();
  }
});

/** 一张待送货的送货单（成品库存 500 只，送 300 只），助手出“导出送货单并出库”的卡片 */
async function exportCard() {
  const b = businessFlow(actor);
  const f = assistantFixture([], { store: b.store });
  const order = b.order(300);
  b.stockIn('500');
  const line = order.lines[0];
  assert.ok(line);
  const delivery = b.draft('delivery', {
    plannedDate: '2026-10-27',
    customerId: b.customer.id,
    address: '虚构地址',
    contact: '',
    phone: '',
    lines: [{ orderId: order.id, orderLineId: line.id, stockId: b.finished.id, quantity: '300', notes: '' }],
    notes: '',
  });
  const thread = f.manager.create(actor);
  const args = { kind: 'delivery', id: delivery.id, expectedVersion: delivery.version, format: 'xlsx', markShipped: true, requestId: randomUUID() };
  f.replies.push({ message: '', toolCalls: [{ name: 'documents.export', args }] }, { message: '请在卡片上确认。' });
  const view = await f.say(thread.id, '把这张送货单导出来，货装车了', {}, actor);
  return { f, thread, view, plan: lastCard(view) };
}

/** 记下执行后各步有没有走 */
function recorder(view: ThreadView) {
  const seen = { reloaded: [] as string[], decided: [] as string[], announced: 0, failed: [] as string[], downloaded: 0, listed: 0 };
  const d = {
    thread: view,
    loadThread: (id: string) => {
      seen.reloaded.push(id);
      return Promise.resolve(null);
    },
    loadState: () => {
      seen.listed++;
      return Promise.reject(new Error('导出卡片不刷新会话列表'));
    },
    onDecided: (card: { id: string; decision: string }) => seen.decided.push(card.decision),
  };
  return { seen, d };
}

test('导出卡片：核对区按服务器写好的内容显示；确认后的执行结果里带文件，交给下载，再刷新、交回助手', async () => {
  const { f, view, plan } = await exportCard();
  try {
    const v = reviewView(plan);
    assert.equal(v.impactPlan, null);
    assert.ok(v.summary.some((l) => /文件下载完成后/.test(l.label + '：' + l.value)));
    assert.deepEqual(v.summary, plan.summary);
    const result = executedResult(await f.manager.execute(plan.id, { acknowledged: true }, actor, 's'));
    assert.ok(result.file, '执行结果带导出好的文件');
    const { seen, d } = recorder(view);
    const effects: ExecutedEffects = {
      download: (file) => {
        assert.deepEqual(file, result.file);
        // 浏览器里交给下载之前按导出文件的结构认（review-actions 的 pageEffects）：真实的文件信息要认得出
        assert.doesNotThrow(() => readExportFile(file));
        seen.downloaded++;
        return Promise.resolve();
      },
      downloadFailed: (message) => seen.failed.push(message),
      announce: () => seen.announced++,
    };
    await afterExecuted(d, plan.id, result, effects);
    assert.deepEqual(seen, { reloaded: [view.id], decided: ['confirmed'], announced: 1, failed: [], downloaded: 1, listed: 0 });
  } finally {
    f.close();
  }
});

test('导出卡片确认后文件下载失败：只说明原因，照样刷新会话、通知别的页面、交回助手接着办', async () => {
  const { f, view, plan } = await exportCard();
  try {
    const result = executedResult(await f.manager.execute(plan.id, { acknowledged: true }, actor, 's'));
    const { seen, d } = recorder(view);
    const effects: ExecutedEffects = {
      download: () => Promise.reject(new Error('虚构：文件下载失败。')),
      downloadFailed: (message) => seen.failed.push(message),
      announce: () => seen.announced++,
    };
    await afterExecuted(d, plan.id, result, effects);
    assert.deepEqual(seen, {
      reloaded: [view.id],
      decided: ['confirmed'],
      announced: 1,
      failed: ['虚构：文件下载失败。'],
      downloaded: 0,
      listed: 0,
    });
  } finally {
    f.close();
  }
});
