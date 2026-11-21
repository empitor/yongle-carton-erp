import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BusinessDocuments } from '../server/documents/service.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { today } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import { assistantFixture, autoConfirmAssistant, lastCard, toolsOf } from './assistant-fixture.js';
import type { Store } from '../server/core/db.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { actor } from './actor-fixture.js';
import { readAs } from './read-result.js';

/** 一个虚构客户订了 300 只，成品库存 500 只，已经安排了一张待送货的送货单。 */
function setup(store: Store) {
  const base = businessBase(actor, store),
    { ops, flow } = base;
  const customer = base.customer({ name: '虚构甲电器', address: '虚构路1号' });
  const product = base.product({ name: '虚构外箱' });
  const order = base.order(customer, [base.line(product, 300, { productName: product.name, notes: '' })], {
    orderDate: '2026-11-09',
    deliveryDate: '2026-11-20',
    notes: '',
    costs: null,
  });
  const stock = base.finished(product, { name: '虚构外箱' }, { quantity: '500', date: '2026-11-09' });
  const delivery = flow.save(
    'delivery',
    {
      date: '2026-11-10',
      plannedDate: '2026-11-10',
      customerId: customer.id,
      address: '虚构路1号',
      contact: '',
      phone: '',
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity: '300', notes: '' }],
      notes: '',
    },
    actor,
  );
  const balance = () => ops.items(true, stock.id)[0].balanceUnits;
  return { ops, flow, customer, product, order, stock, delivery, balance };
}

test('导出送货单并出库的确认卡片：写明是哪张送货单和客户、每行数量、库存从多少变成多少；没点确认不出库', async () => {
  const fx = assistantFixture(),
    f = setup(fx.store);
  try {
    const t = fx.manager.create(actor);
    fx.replies.push(
      {
        message: '',
        toolCalls: [
          { name: 'documents.export', args: { kind: 'delivery', id: f.delivery.id, expectedVersion: f.delivery.version, format: 'xlsx', markShipped: true, requestId: randomUUID() } },
        ],
      },
      { message: '请在卡片上确认。' },
    );
    const view = await fx.manager.chat(t.id, fx.input('把虚构甲电器这张送货单导出来，货装车了。', randomUUID()), actor, 'test', () => {}, () => actor);
    const card = lastCard(view);
    assert.ok(card.summary, '卡片有逐行内容');
    const number = f.flow.get(f.delivery.id).number;
    assert.equal(card.label, '导出送货单并出库：送货单 ' + number + '（虚构甲电器）');
    const text = card.summary.map((l) => l.label + '：' + l.value).join('\n');
    assert.match(text, /第 1 行：虚构外箱 300 只/);
    assert.match(text, /库存：虚构外箱：500 只 → 200 只（减 300 只）/);
    assert.match(text, /文件下载完成后：送货单出库，扣成品库存/);
    assert.equal(f.flow.get(f.delivery.id).status, 'draft', '没点确认不出库');
    assert.equal(f.balance(), 500_000);
  } finally {
    fx.close();
  }
});

test('助手导出送货单并出库：文件交付后扣库存、变送货中；再确认送达，只记送达不动库存', async () => {
  const fx = autoConfirmAssistant(),
    f = setup(fx.store);
  try {
    const docs = new BusinessDocuments(fx.store);
    const t = fx.manager.create(actor);
    fx.replies.push(
      {
        message: '导出送货单并出库',
        toolCalls: [
          {
            name: 'documents.export',
            args: {
              kind: 'delivery',
              id: f.delivery.id,
              expectedVersion: f.delivery.version,
              format: 'xlsx',
              markShipped: true,
              requestId: randomUUID(),
            },
          },
        ],
      },
      { message: '送货单已导出，已出库，送货中。', toolCalls: [] },
    );
    await fx.manager.chat(
      t.id,
      fx.input('把虚构甲电器这张送货单导出来，货装车了。', randomUUID()),
      actor,
      'test',
      (event: string, data: unknown) => {
        if (event === 'effect' && field(data, 'type') === 'download') {
          const file = docs.file(readAs(data, { file: z.looseObject({ exportId: z.string() }) }).file.exportId, actor);
          docs.delivered(file.requestId, actor);
          docs.complete(file.requestId, file.sha256, actor);
        }
      },
      () => actor,
    );
    const shipped = f.flow.get(f.delivery.id, 'delivery');
    assert.equal(shipped.status, 'confirmed', '交付完成后出库');
    assert.ok(shipped.shippedAt, '送货中');
    assert.equal(f.balance(), 200_000, '扣了 300 只');
    const tools = toolsOf(fx.store);
    // 送达日期要人确认：用户没说就不能悄悄记今天，让模型先问
    assert.throws(
      () => tools.prepare('delivery.mark_delivered', { id: shipped.id, version: shipped.version }, actor, 'test'),
      /送达日期要用用户说的日期/,
    );
    const registry = new AssistantToolRegistry();
    try {
      const definition = registry.definition('delivery.mark_delivered');
      assert.ok(definition, '登记了送达命令');
      const schema = definition.schema;
      assert.equal(schema.safeParse({ id: shipped.id, version: shipped.version }).success, false, '工具参数里日期必填');
    } finally {
      registry.close();
    }
    // 用户说“今天送到的”：模型传今天的日期
    const plan = tools.prepare('delivery.mark_delivered', { id: shipped.id, version: shipped.version, date: today() }, actor, 'test');
    assert.equal(f.flow.get(shipped.id, 'delivery').deliveredAt, undefined, '准备阶段不写入');
    const done = z.looseObject({}).parse(tools.commit(plan, actor, 'test'));
    assert.ok(done.deliveredAt, '已送达');
    assert.equal(f.balance(), 200_000, '确认送达不动库存');
    assert.equal(done.deliveredAt, today());
    // 已经确认送达：直接返回原来的送达结果，不报错、不改日期
    const again = tools.prepare('delivery.mark_delivered', { id: shipped.id, version: shipped.version, date: today() }, actor, 'test');
    assert.match(again.label, /已经确认送达/);
    const same = z.looseObject({}).parse(tools.commit(again, actor, 'test'));
    assert.equal(same.deliveredAt, done.deliveredAt);
    assert.equal(same.version, done.version, '没有重复确认');
  } finally {
    fx.close();
  }
});

test('助手安排生产：和页面一样保存后直接下达', () => {
  const fx = autoConfirmAssistant(),
    f = setup(fx.store);
  try {
    const tools = toolsOf(fx.store);
    const plan = tools.prepare(
      'records.propose_save',
      {
        module: 'production_tasks',
        patch: { date: '2026-11-09', plannedDate: '2026-11-11', productId: f.product.id, quantity: '300', unit: '只', orderIds: [f.order.id], notes: '' },
      },
      actor,
      'test',
    );
    assert.match(plan.warnings.join(''), /直接下达/);
    const task = z.looseObject({ id: z.number() }).parse(tools.commit(plan, actor, 'test'));
    assert.equal(task.status, 'confirmed');
    assert.equal(f.flow.get(task.id).status, 'confirmed');
  } finally {
    fx.close();
  }
});
