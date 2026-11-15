// 助手登记完工（flow.propose_production_completion）：整批共用领料按比例拆、完工日期和实际产量必填、
// 良品率对不上整批拒绝、库存不足和分配无效整批不写、可以只登记待入库。内存库、虚构数据。
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 登记完工的结果：取出逐张的结果，其余键保留 */
const completed = z.looseObject({ results: z.array(z.looseObject({})) });
import { randomUUID } from 'node:crypto';
import { actor, superActor, flowFixture } from './assistant-fixture.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { productSchema, customerSchema, orderSchema, today } from '../shared/core/domain.js';
import { asList, field } from '../server/assistant/chat/result-fields.js';
import type { AssistantManager } from '../server/assistant/manager.js';
import { count as countOf } from '../server/core/index.js';
const request = (name: string, args: Record<string, unknown>) => ({ message: '', toolCalls: [{ name, args }] });
/** 用户说了的完工事实：完工日期和每个任务的实际良品、废品（全部做完、100%良品）。助手登记完工这两项必填。 */
const completionFacts = (f: { manager: AssistantManager }) => ({
  date: today(),
  quantities: f.manager.tools.flow.list('task').map((t) => ({ taskId: t.id, goodQuantity: t.quantity, scrapQuantity: '0' })),
});
/**
 * 一张六个型号的订单（共 1093 只），548 张共用原料已经到货入库，六个生产任务已安排。完工各用例自己登记。
 * send 用本机最高管理员身份在一个会话里说话。
 */
function setup() {
  const f = flowFixture(),
    who = localAdministratorActor(superActor()),
    { ops, flow } = f.manager.tools,
    t = f.manager.create(who);
  const customer = f.store.saveCustomer(customerSchema.parse({ name: '虚构全链客户' }));
  const quantities = [181, 181, 181, 182, 184, 184];
  const products = quantities.map((_, i) =>
    f.store.saveProduct(
      productSchema.parse({ name: '虚构六型号' + i, length: 30, width: 20, height: 10, dimensionUnit: 'cm', material: '虚构BC纸板', flute: 'BC', customerProductCode: 'FICTION-' + i }),
    ),
  );
  const order = f.store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: today(),
      deliveryDate: today(),
      status: '已确认',
      lines: products.map((p, i) => ({ productId: p.id, quantity: quantities[i], unit: '只', unitPriceExact: '2.00', unitPriceCents: 200 })),
    }),
  );
  const raw = { name: '虚构共用BC原料', kind: 'raw', unit: '张', length: 100, width: 80, height: null, dimensionUnit: 'cm', material: '虚构BC纸板', flute: 'BC', specification: '虚构100x80', notes: '', productId: null };
  const supplier = ops.saveSupplier({ name: '虚构全链供应商' }, who),
    item = ops.saveItem(raw, who);
  const priced = { quantity: '548', unitPrice: '1.00', priceBasis: 'quantity' };
  const purchase = ops.savePurchase({ supplierId: supplier.id, customerOrderId: order.id, orderDate: today(), status: '已订货', lines: [{ ...raw, stockItemId: item.id, ...priced }] }, who);
  const arrival = flow.save('arrival', { date: today(), supplierId: supplier.id, reference: 'FICTION-ARRIVAL', lines: [{ stockId: item.id, purchaseLineId: purchase.lines[0].id, item: raw, ...priced }] }, who);
  flow.confirm(arrival.id, { previewDigest: flow.preview(arrival.id, who).previewDigest, requestId: randomUUID(), acknowledged: true }, who);
  products.forEach((p, i) => flow.save('task', { date: today(), productId: p.id, quantity: String(quantities[i]), unit: '只', orderIds: [order.id] }, who));
  return { ...f, manager: f.manager, who, send: (text: string) => f.manager.chat(t.id, f.input(text, randomUUID()), who, 'real-session', () => {}, () => who) };
}

test('所有生产任务100%良品，整批547张共享领料完工入库，自动创建成品档案且幂等', async () => {
  const f = setup();
  try {
    f.replies.push(
      request('flow.propose_production_completion', {
        allActive: true,
        goodRatePct: 100,
        ...completionFacts(f),
        materials: [{ unit: '张', issued: '547' }],
        allocation: 'shared-proportional',
      }),
      { message: '已核验完工' },
    );
    const result = await f.send('今天所有生产任务全部做完，100%良品，领用547张原料并完工入库');
    const productions = f.manager.tools.flow.list('production');
    assert.equal(productions.length, 6, result.messages.at(-1)?.text);
    assert(
      productions.every(
        (p) =>
          p.status === 'confirmed' &&
          p.materials.every((m) => Number.isInteger(Number(m.issued))),
      ),
    );
    assert.equal(
      productions.reduce((n, p) => n + Number(p.materials[0].issued), 0),
      547,
    );
    assert.equal(
      productions.reduce((n, p) => n + Number(p.goodQuantity), 0),
      1093,
    );
    assert.equal(f.manager.tools.ops.repo.items().filter((i) => i.kind === 'finished').length, 6);
    // 同一张卡片再确认一次：原样返回上次的结果，不重复登记
    const executed = f.store.db.prepare('SELECT id FROM assistant_previews WHERE result IS NOT NULL ORDER BY rowid DESC LIMIT 1').get();
    assert.ok(executed, '有执行过的卡片');
    const preview = String(executed.id);
    f.manager.execute(preview, { acknowledged: true }, f.who, 'real-session');
    assert.equal(f.manager.tools.flow.list('production').length, 6);
    assert.equal(
      f.manager.tools.ops.repo
        .items()
        .filter((i) => i.kind === 'raw')
        .reduce((n, i) => n + f.manager.tools.ops.repo.balance(i.id), 0),
      1000,
    );
  } finally {
    f.close();
  }
});

test('助手登记完工不传完工日期或实际产量就拒绝，不按今天、剩余任务量默认全部良品；传齐后省略goodRatePct不误报', () => {
  const f = setup();
  try {
    const base = {
      allActive: true,
      materials: [{ unit: '张', issued: '547' }],
      allocation: 'shared-proportional',
    };
    const facts = completionFacts(f);
    const prepare = (args: Record<string, unknown>) =>
      f.manager.tools.prepare('flow.propose_production_completion', args, f.who, 'real-session');
    assert.throws(() => prepare({ ...base, quantities: facts.quantities }), /完工日期必填/);
    assert.throws(() => prepare({ ...base, date: facts.date }), /实际良品、废品数量必填/);
    // 只说了一个任务的产量：其余任务不能按剩余任务量默认全部良品
    assert.throws(
      () => prepare({ ...base, ...facts, quantities: facts.quantities.slice(0, 1) }),
      /缺少实际良品和废品数量/,
    );
    assert.equal(f.manager.tools.flow.list('production').length, 0);
    const plan = prepare({ ...base, ...facts });
    const saved = completed.parse(f.manager.tools.commit(plan, f.who, 'real-session'));
    assert.equal(saved.results.length, 6);
    assert.equal(f.manager.tools.flow.list('production').length, 6);
    assert(f.manager.tools.flow.list('production').every((p) => p.date === facts.date));
  } finally {
    f.close();
  }
});

test('完工良品率与实际良品/废品数量不一致时整批拒绝且不写库存', () => {
  const f = setup();
  try {
    const tasks = f.manager.tools.flow.list('task');
    assert.throws(
      () =>
        f.manager.tools.prepare(
          'flow.propose_production_completion',
          {
            allActive: true,
            goodRatePct: 90,
            date: today(),
            quantities: tasks.map((t) => ({
              taskId: t.id,
              goodQuantity: '10',
              scrapQuantity: '0',
            })),
            materials: [{ unit: '张', issued: '547' }],
            allocation: 'shared-proportional',
          },
          f.who,
          'real-session',
        ),
      /良品率与实际良品/,
    );
    assert.equal(f.manager.tools.flow.list('production').length, 0);
  } finally {
    f.close();
  }
});

test('无效完工分配、库存不足整批不写，成品入这个产品唯一的那个成品库存；普通业务账号按原服务权限完工', async () => {
  const f = setup();
  try {
    const args = {
      allActive: true,
      goodRatePct: 100,
      ...completionFacts(f),
      materials: [{ unit: '张', issued: '549' }],
      allocation: 'shared-proportional',
    };
    assert.throws(
      () => f.manager.tools.prepare('flow.propose_production_completion', args, actor, 'ordinary'),
      /库存不足/,
    );
    assert.equal(f.manager.tools.flow.list('production').length, 0);
    assert.equal(f.manager.tools.ops.repo.items().filter((i) => i.kind === 'finished').length, 0);
    const task = f.manager.tools.flow.list('task')[0];
    const first = f.manager.tools.ops.saveItem({ name: '虚构待选成品A', kind: 'finished', unit: task.unit, productId: task.productId }, actor);
    const valid = { ...args, materials: [{ unit: '张', issued: '547' }] };
    // 入哪个成品库存由产品决定，工具参数里没有“指定成品库存”这一项
    assert.throws(
      () =>
        f.manager.tools.prepare(
          'flow.propose_production_completion',
          { ...valid, finishedStocks: [{ taskId: task.id, stockId: first.id }] },
          actor,
          'ordinary',
        ),
    );
    assert.throws(
      () =>
        f.manager.tools.prepare(
          'flow.propose_production_completion',
          { ...valid, allocation: 'explicit', distribution: [] },
          actor,
          'ordinary',
        ),
      /分配必须完整/,
    );
    assert.equal(
      f.manager.tools.ops.repo.items().filter((i) => i.kind === 'finished').length,
      1,
      '失败预检不能留下后续档案',
    );
    const plan = f.manager.tools.prepare('flow.propose_production_completion', valid, actor, 'ordinary');
    assert.equal(f.manager.tools.flow.list('production').length, 0);
    const saved = completed.parse(f.manager.tools.commit(plan, actor, 'ordinary'));
    assert.equal(saved.results.length, 6);
    assert.equal(saved.results.find((r) => r.taskId === task.id)?.finishedStockId, first.id, '这个产品的那一个成品库存');
    assert(saved.verified);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.close();
  }
});

test('助手登记完工可以只登记、稍后核对入库：和直接入库同样拆分，存成待入库不动库存，之后逐张核对入库', async () => {
  const f = setup();
  try {
    const count = () => countOf(f.store.db, 'SELECT COUNT(*) AS n FROM stock_movements');
    const movements = count();
    const args = {
      allActive: true,
      goodRatePct: 100,
      ...completionFacts(f),
      materials: [{ unit: '张', issued: '547' }],
      allocation: 'shared-proportional',
      pending: true,
    };
    const plan = f.manager.tools.prepare('flow.propose_production_completion', args, actor, 'ordinary');
    assert.match(plan.label, /^登记完工（待核对入库）：6 张完工单(：|$)/);
    assert.equal(field(plan.args.input, 'pending'), true);
    assert.equal(f.manager.tools.flow.list('production').length, 0, '预检不写');
    // 同一组参数直接入库的预检（只预检不写）
    const direct = f.manager.tools.prepare(
      'flow.propose_production_completion',
      { ...args, pending: undefined },
      actor,
      'ordinary',
    );
    const saved = completed.parse(f.manager.tools.commit(plan, actor, 'ordinary'));
    assert.equal(saved.pending, true);
    assert.equal(saved.results.length, 6);
    const drafts = f.manager.tools.flow.list('production');
    assert.equal(drafts.length, 6);
    assert.ok(drafts.every((d) => d.status === 'draft'));
    assert.equal(count(), movements, '只登记不动库存');
    // 剩余量扣掉待入库的：全部剩余量都登记成待入库以后，“全部待完工”里没有能再登记的，直接入库也不能重复登记
    assert.throws(
      () => f.manager.tools.prepare('flow.propose_production_completion', { ...args, pending: undefined }, actor, 'ordinary'),
      /已经登记过完工，在等核对入库/,
    );
    // 和直接入库拆得一样（同一份算法）
    const shapeRow = z.looseObject({
      taskId: z.number(),
      goodQuantity: z.unknown(),
      scrapQuantity: z.unknown(),
      materials: z.array(z.looseObject({ issued: z.unknown(), returned: z.unknown() })),
    });
    const shape = (rows: unknown[]) =>
      rows
        .map((raw) => shapeRow.parse(raw))
        .map((r): [number, unknown, unknown, string] => [r.taskId, r.goodQuantity, r.scrapQuantity, r.materials.map((m) => String(m.issued) + '/' + String(m.returned)).join()])
        .sort((a, b) => a[0] - b[0]);
    assert.deepEqual(shape(saved.results), shape((asList(field(direct.after, 'results')) ?? [])));
    // 之后用核对入库逐张入库
    for (const d of drafts) {
      const confirm = f.manager.tools.prepare('flow.propose_confirmation', { id: d.id }, actor, 'ordinary');
      f.manager.tools.commit(confirm, actor, 'ordinary');
    }
    assert.ok(f.manager.tools.flow.list('production').every((d) => d.status === 'confirmed'));
    assert.ok(count() > movements);
  } finally {
    f.close();
  }
});
