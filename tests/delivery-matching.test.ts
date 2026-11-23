import { trackedOrder, trackOrders } from '../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineSpecification, orderSchema, productSchema, sameSpecification, specification, specificationDifference, today } from '../shared/core/domain.js';
import { deliveryBlockers, deliveryCandidates, planOrderDelivery, planStockDelivery, specificationMismatch, stockByProduct } from '../shared/business/warehouse-delivery.js';
import { orderNextSteps } from '../shared/business/order-next-step.js';
import { productionHint, productionReasons } from '../src/records/order-production.js';
import { finishedStockByProduct } from '../src/recordkit/stock-lookup.js';
import { netQuantity } from '../src/recordkit/quantity.js';
import { buildToday } from '../server/overview/workbench.js';
import { formatStockSize } from '../shared/business/operations.js';
import { quantityUnits } from '../shared/core/quantity.js';
import { actor } from './actor-fixture.js';
import { businessBase, manualWrite } from './business-base-fixture.js';

/**
 * 和用户本机遇到的一样：订单明细规格只写了产品名称、没写数量单位；成品库存按“只”，规格是尺寸+材质+楞型。
 */
function setup(unit?: string, specification = '虚构纸箱A-300x200x150') {
  const base = businessBase(actor),
    { store, ops, flow } = base;
  const customer = base.customer({ name: '虚构测试客户' });
  const product = base.product({ name: '虚构纸箱A-300x200x150', length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: '虚构三层瓦楞纸板', flute: 'B楞' });
  const order = base.order(
    customer,
    [{ productId: product.id, productName: product.name, specification, quantity: 1000, unitPriceCents: 350, notes: '', ...(unit ? { unit } : {}) }],
    { orderDate: '2026-11-09', deliveryDate: '2026-11-20', notes: '', costs: null },
  );
  const stock = base.finished(
    product,
    { name: product.name, specification: '300 × 200 × 150 mm / 虚构三层瓦楞纸板 / B楞' },
    { quantity: '1000', date: '2026-11-09' },
  );
  const item = () => flow.views.items(true, stock.id)[0];
  return { store, ops, flow, check: base.check, customer, product, order, item };
}

test('订单规格只写了产品名称时不拿它和库存规格比对；写了别的规格仍要一致', () => {
  assert.equal(lineSpecification({ specification: '虚构纸箱A-300x200x150', productName: '虚构纸箱A-300x200x150' }), '');
  assert.equal(lineSpecification({ specification: '虚构纸箱A 300×200×150', productName: '虚构纸箱A-300x200x150' }), '', '空格、横线写法不同也算只写了名称');
  assert.equal(lineSpecification({ specification: '虚构纸箱A_1', productName: '虚构纸箱A—1' }), '', '判断照抄品名时下划线、破折号也不算差别');
  assert.equal(lineSpecification({ specification: '虚构纸箱A-300x200x150 五层', productName: '虚构纸箱A-300x200x150' }), '虚构纸箱A-300x200x150 五层');
  const f = setup('只');
  assert.equal(deliveryCandidates(f.item(), f.customer.id, trackOrders(f.store, f.store.orders())).length, 1, '产品、单位一致就能送');
  const g = setup('只', '400×300×200 五层');
  assert.equal(deliveryCandidates(g.item(), g.customer.id, trackOrders(g.store, g.store.orders())).length, 0, '尺寸不同的规格不混着发');
  assert.equal(deliveryBlockers(g.item(), trackOrders(g.store, g.store.orders()))[0].kind, 'spec');
});

test('订单没写单位就是“只”：读出来是只，直接能排送货、能确认发货', () => {
  const f = setup();
  assert.equal(f.store.order(f.order.id)?.lines[0].unit, '只', '老订单没写单位按“只”读');
  assert.equal(deliveryCandidates(f.item(), f.customer.id, trackOrders(f.store, f.store.orders())).length, 1);
  assert.equal(deliveryBlockers(f.item(), trackOrders(f.store, f.store.orders())).length, 0, '不再报“没写单位”');
  const [plan] = planStockDelivery([f.item()], trackOrders(f.store, f.store.orders()), f.customer.id);
  assert.deepEqual(plan.lines.map((l) => l.quantity), ['1000']);
  const draft = f.flow.save('delivery', { date: '2026-11-10', plannedDate: '2026-11-10', customerId: f.customer.id, address: '', contact: '', phone: '', lines: plan.lines, notes: '' }, actor);
  const done = f.check(draft);
  assert.equal(done.status, 'confirmed');
  assert.equal(f.item().balanceUnits, 0);
});

test('“个”就是“只”：订单、库存品、生产任务写“个”都存成“只”；别的单位不收，提示先换算', () => {
  const f = setup('个');
  assert.equal(f.store.order(f.order.id)?.lines[0].unit, '只');
  // 成品一定关联产品，一个产品一个成品库存
  const [productB, productC] = ['虚构成品B', '虚构成品C'].map((name) => f.store.saveProduct(productSchema.parse({ name })));
  const finished = f.ops.saveItem({ name: '虚构成品B', kind: 'finished', unit: '个', productId: productB.id }, actor);
  assert.equal(finished.unit, '只');
  const blank = f.ops.saveItem({ name: '虚构成品C', kind: 'finished', productId: productC.id }, actor);
  assert.equal(blank.unit, '只', '成品不填单位就是只');
  const board = f.ops.saveItem({ name: '虚构纸板', kind: 'raw' }, actor);
  assert.equal(board.unit, '张', '原材料不填单位就是张');
  assert.throws(() => f.ops.saveItem({ name: '虚构成品D', kind: 'finished', unit: '箱' }, actor), /只有“只”/);
  assert.throws(() => f.ops.saveItem({ name: '虚构胶水', kind: 'raw', unit: '公斤' }, actor), /只有“张”/);
  assert.throws(
    () =>
      f.store.saveOrder(orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-11-10',
        deliveryDate: '2026-11-20',
        status: '已确认',
        notes: '',
        costs: null,
        lines: [{ productId: f.product.id, quantity: 10, unitPriceCents: 100, notes: '', unit: '箱' }],
      })),
    /只有“只”/,
  );
  // 数据库这一层的单位约束由 schema-constraints.test.ts 守着；已有的档案改成别的单位，保存服务照样拦并说明原因
  assert.throws(
    () => f.flow.stock.saveItem({ name: '虚构成品B改名', kind: 'finished', unit: '箱', version: finished.version }, actor, finished.id),
    /只有“只”/,
  );
  const task = f.flow.save('task', { date: '2026-11-10', plannedDate: '2026-11-11', productId: f.product.id, quantity: '100', unit: '个', orderIds: [f.order.id], notes: '' }, actor);
  assert.equal(task.unit, '只');
});

test('排产按“只”算，只扣这个产品的成品库存；已有任务在做的不再排', async () => {
  const { planProductionForOrders } = await import('../shared/business/production-plan.js');
  const order = { id: 1, number: '虚构单1', status: '已确认', lines: [{ id: 1, productId: 9, productName: '虚构箱', quantity: 1000, remainingQuantity: 1000, unit: '只' }] };
  const items = [
    { kind: 'finished', productId: 9, unit: '只', availableUnits: quantityUnits('300') },
    { kind: 'finished', productId: 10, unit: '只', availableUnits: quantityUnits('50') },
  ];
  const plan = planProductionForOrders([order], [{ tasks: [] }], items);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].unit, '只');
  assert.equal(plan.groups[0].availableUnits, quantityUnits('300'), '只扣这个产品的库存，别的产品不相加');
  assert.equal(plan.groups[0].suggested, '700');
  const working = planProductionForOrders(
    [order],
    [{ tasks: [{ productId: 9, status: 'confirmed', quantity: '1000', completed: '0' }] }],
    items,
  );
  assert.equal(working.groups.length, 0, '已有任务在做，不再排一张');
  assert.match(working.skipped[0].reason, /已有生产任务在做/);
});

test('只有长宽的产品（隔板、垫片）也比规格：订单写的长宽不同被拦，相同放行；缺长、缺宽或没写尺寸单位的不比', () => {
  const stock = (patch: Partial<Parameters<typeof specificationMismatch>[0]> = {}) => ({ productId: 1, length: 600, width: 400, height: null, dimensionUnit: 'mm', specification: '600 × 400 mm', ...patch });
  const line = (specification: string) => ({ specification, productName: '虚构隔板' });
  assert.equal(specificationMismatch(stock(), line('500x400')), true);
  assert.equal(specificationMismatch(stock(), line('600x400')), false);
  assert.equal(specificationMismatch(stock(), line('600*400mm')), false);
  for (const patch of [{ width: null }, { length: null }, { dimensionUnit: null }])
    assert.equal(specificationMismatch(stock(patch), line('500x400')), false, JSON.stringify(patch));
  // 服务端出库、页面排送货是同一个判断：成品库存的尺寸和规格说明跟着产品
  const base = businessBase(actor),
    { store, flow } = base;
  try {
    const customer = base.customer({ name: '虚构隔板客户' });
    const product = base.product({ name: '虚构隔板', length: 600, width: 400, dimensionUnit: 'mm' });
    const item = base.finished(product, { name: product.name });
    assert.equal(item.specification, '600 × 400 mm', '没填的高不写占位');
    const orderFor = (specification: string) =>
      store.saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-11-09',
          deliveryDate: '2026-11-20',
          status: '已确认',
          lines: [{ productId: product.id, productName: product.name, specification, quantity: 10, unit: '只', unitPriceCents: 100 }],
        }),
      );
    const deliver = (order: { id: number; lines: { id: number }[] }) =>
      flow.save('delivery', { date: '2026-11-10', customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: item.id, quantity: '1' }] }, actor);
    const wrong = orderFor('500x400'),
      right = orderFor('600x400');
    // 提示说清哪一项不一样：两边的尺寸按同一种写法并排
    assert.throws(
      () => deliver(wrong),
      /订单 \S+ 的“虚构隔板”规格和产品现在的不一样，订单明细写的是 500 × 400，产品现在是 600 × 400 mm，请核对这张订单的明细。/,
    );
    assert.equal(deliver(right).status, 'draft');
    const reread = (id: number) => {
      const o = trackedOrder(store, id);
      assert.ok(o, '订单还在');
      return o;
    };
    assert.equal(deliveryCandidates(item, customer.id, [reread(wrong.id)]).length, 0);
    assert.equal(deliveryCandidates(item, customer.id, [reread(right.id)]).length, 1);
    assert.equal(deliveryBlockers(item, [reread(wrong.id)])[0].kind, 'spec');
  } finally {
    store.close();
  }
});

test('产品规格文字：没填的不写占位，整个都没有时是空的；规格相同、不同的判断不受影响；对不上时说清差在哪一项', () => {
  const p = (patch: Record<string, unknown>) => productSchema.parse({ name: '虚构纸箱', ...patch });
  // 尺寸一项都没填、单位也没写：不写尺寸那一段，也不写“尺寸单位待确认”
  assert.equal(specification(p({})), '');
  assert.equal(specification(p({ dimensionUnit: 'mm' })), '');
  assert.equal(specification(p({ material: 'K=A', flute: 'B' })), 'K=A / B');
  // 只填了部分的照实写：末尾没填的不写，中间没填的写“—”保住长 × 宽 × 高的位置；没写单位只写数字
  assert.equal(specification(p({ length: 600, width: 400, dimensionUnit: 'mm' })), '600 × 400 mm');
  assert.equal(specification(p({ length: 600, height: 240 })), '600 × — × 240');
  assert.equal(specification(p({ length: 30, width: 20, height: 10, dimensionUnit: 'cm', material: '配纸', flute: 'B', requirements: '四色' })), '30 × 20 × 10 cm / 配纸 / B / 四色');
  // 规格相同、不同的判断照旧：只差排版的算相同，尺寸不同的算不同
  const full = specification(p({ length: 270, width: 110, height: 240, dimensionUnit: 'mm', material: 'W=A', flute: 'E' }));
  assert.equal(sameSpecification(full, '270*110*240'), true);
  assert.equal(sameSpecification(full, '270×110×240mm W=A'), true);
  assert.equal(sameSpecification(full, '260*110*240'), false);
  assert.equal(sameSpecification('300*200*150MM', '300x200x150mm'), true, '单位大小写不算不同');
  assert.equal(sameSpecification('K=A BC楞', 'K=K BC楞'), false, '材质不同还是要拦');
  // 比较两段规格时横线可能是编号的一部分，去掉会把不同规格算成同一个
  assert.equal(sameSpecification('1-12', '11-2'), false, '“1-12”和“11-2”不是同一规格');
  assert.equal(sameSpecification('A-11', 'A1-1'), false, '“A-11”和“A1-1”不是同一规格');
  assert.equal(sameSpecification(specification(p({ length: 600, width: 400, dimensionUnit: 'mm' })), '600x400'), true);
  // 差在哪：尺寸不同只说尺寸（同一种写法并排），尺寸一样说其余那段，都没写尺寸时整段对照
  assert.equal(specificationDifference('260×110×240', full), '订单明细写的是 260 × 110 × 240，产品现在是 270 × 110 × 240 mm');
  assert.equal(specificationDifference('270*110*240 五层', full), '订单明细写的是“五层”，产品现在是“W=A / E”');
  assert.equal(specificationDifference('型号A', 'K=A / B'), '订单明细写的是“型号A”，产品现在是“K=A / B”');
});

test('按订单排送货：规格对不上被拦下的行只在“对不上”里说原因，不再算进“没有库存”', () => {
  const stock = { id: 7, productId: 1, length: 270, width: 110, height: 240, dimensionUnit: 'mm', specification: '270 × 110 × 240 mm / W=A / E', availableUnits: 500_000 };
  const order = (specification: string) => ({
    id: 1,
    number: '虚构单1',
    customerId: 1,
    status: '已确认',
    deliveryDate: '2026-11-20',
    lines: [{ id: 11, productId: 1, productName: '虚构彩箱', specification, quantity: 1000, remainingQuantity: 1000, unit: '只' }],
  });
  const blocked = planOrderDelivery([order('260×110×240')], [stock]);
  assert.deepEqual([blocked.groups.length, blocked.missing.length], [0, 0], '规格对不上：不排，也不说成没有库存');
  assert.equal(deliveryBlockers(stock, [order('260×110×240')])[0].text, '规格和产品现在的不一样，订单明细写的是 260 × 110 × 240，产品现在是 270 × 110 × 240 mm，请核对这张订单的明细');
  // 规格对得上、只是库存不够的，照旧说还差多少
  const short = planOrderDelivery([order('270*110*240')], [stock]);
  assert.deepEqual(short.groups[0].lines.map((l) => l.quantity), ['500']);
  assert.deepEqual(short.missing.map((m) => m.quantity), ['500']);
});
test('订单下一步：规格和产品现在的对不上的明细，不算“有库存可发”、不提示排产，说清要核对订单明细（和送货同一个判断）', () => {
  const stock = { id: 7, productId: 1, length: 270, width: 110, height: 240, dimensionUnit: 'mm', specification: '270 × 110 × 240 mm / W=A / E', availableUnits: 500_000 };
  const other = { id: 8, productId: 2, length: 300, width: 200, height: 150, dimensionUnit: 'mm', specification: '300 × 200 × 150 mm', availableUnits: 200_000 };
  const order = (specification: string) => ({
    id: 1,
    number: '虚构单1',
    customerId: 1,
    status: '已确认',
    deliveryDate: '2026-11-20',
    materialProgress: 'none' as const,
    lines: [
      { id: 11, productId: 1, productName: '虚构彩箱', specification, quantity: 100, remainingQuantity: 100, unit: '只' },
      { id: 12, productId: 2, productName: '虚构外箱', specification: '300*200*150', quantity: 100, remainingQuantity: 100, unit: '只' },
    ],
  });
  const related = { tasks: [], stocks: [stock, other], deliveries: [], purchases: [] };
  const wrong = orderNextSteps(order('260×110×240'), related);
  // 对得上的那种照常“有库存可发”，对不上的不算
  const ship = wrong.steps.find((s) => s.kind === 'delivery');
  assert.equal(ship?.detail, '虚构外箱 有库存可发');
  assert.ok(!wrong.steps.some((s) => s.kind === 'schedule'), '对不上的不提示排产：做出来还是产品现在的规格');
  assert.deepEqual(
    wrong.lines.map((l) => [l.name, l.available]),
    [
      ['虚构彩箱', '0'],
      ['虚构外箱', '200'],
    ],
  );
  assert.deepEqual(wrong.notes, [
    '虚构彩箱：规格和产品现在的不一样，订单明细写的是 260 × 110 × 240，产品现在是 270 × 110 × 240 mm，请核对这张订单的明细，核对好之前送不了货',
  ]);
  // 规格对得上：两种都有库存可发，没有提醒
  const right = orderNextSteps(order('270*110*240'), related);
  assert.equal(right.steps.find((s) => s.kind === 'delivery')?.detail, '虚构彩箱、虚构外箱 有库存可发');
  assert.deepEqual(right.notes, []);
  // 工作台传的库存只有分到的数量、没有规格：不比，照旧（和 specificationMismatch 的规则一样，缺规格不拦）
  const bare = orderNextSteps(order('260×110×240'), { ...related, stocks: [{ productId: 1, availableUnits: 500_000 }, { productId: 2, availableUnits: 200_000 }] });
  assert.equal(bare.steps.find((s) => s.kind === 'delivery')?.detail, '虚构彩箱、虚构外箱 有库存可发');
});

test('订单详情“生产任务都已完工，订单还没做齐”：规格对不上的明细不说“还没排产”，说去核对订单明细，和“下一步”的黄色提示同一句', () => {
  const stock = { id: 7, productId: 1, length: 270, width: 110, height: 240, dimensionUnit: 'mm', specification: '270 × 110 × 240 mm / W=A / E', availableUnits: 0 };
  const other = { id: 8, productId: 2, length: 300, width: 200, height: 150, dimensionUnit: 'mm', specification: '300 × 200 × 150 mm', availableUnits: 0 };
  const order = (specification: string) => ({
    id: 1,
    number: '虚构单1',
    customerId: 1,
    status: '生产中',
    deliveryDate: '2026-11-20',
    materialProgress: 'none' as const,
    lines: [
      { id: 11, productId: 2, productName: '虚构五金箱', specification: '300*200*150', quantity: 100, remainingQuantity: 0, unit: '只' },
      { id: 12, productId: 1, productName: '虚构彩箱', specification, quantity: 100, remainingQuantity: 100, unit: '只' },
    ],
  });
  // 五金箱的任务做完、发完；彩箱没排产
  const tasks = [{ id: 5, number: 'SC-虚构-5', status: 'confirmed', productId: 2, quantity: '100', completed: '100', orderIds: [1] }];
  const related = { tasks, stocks: [stock, other], deliveries: [], purchases: [] };
  const wrong = productionReasons(order('260×110×240'), related);
  const steps = orderNextSteps(order('260×110×240'), related);
  assert.deepEqual(wrong.map((r) => r.kind), ['mismatch']);
  assert.equal(wrong[0].text, steps.notes[0], '和订单详情“下一步”同一句');
  assert.match(productionHint(wrong), /虚构彩箱：规格和产品现在的不一样.+请核对这张订单的明细，核对好之前送不了货。$/);
  assert.doesNotMatch(productionHint(wrong), /还没排产/);
  // 规格对得上：照旧说还没排产
  assert.deepEqual(
    productionReasons(order('270*110*240'), related).map((r) => r.text),
    ['虚构彩箱 还没排产'],
  );
  // 读不到库存品（没有规格可比）时不比，照旧
  assert.deepEqual(productionReasons(order('260×110×240'), { tasks }).map((r) => r.kind), ['unscheduled']);
});

test('库存品尺寸文字和 specification() 的尺寸段完全一样：没写单位只写数字，不写“尺寸单位待确认”', () => {
  const cases: Parameters<typeof formatStockSize>[0][] = [
    {},
    { dimensionUnit: 'mm' },
    { length: 600, width: 400, dimensionUnit: 'mm' },
    { length: 600, height: 240 },
    { length: 600 },
    { length: 80, width: 60, dimensionUnit: 'cm' },
  ];
  // 两边是同一段写法（formatStockSize 直接调 specification）；产品资料只收 mm / cm，单位都用这两种写法比
  for (const c of cases) assert.equal(formatStockSize(c), specification(productSchema.parse({ name: '虚构纸板', ...c })), JSON.stringify(c));
  assert.equal(formatStockSize({ length: 600, height: 240 }), '600 × — × 240');
  assert.equal(formatStockSize({ length: 800, width: 600 }), '800 × 600');
});

test('今日页“待排产”只排还要做的产品：只剩规格对不上那一行的订单不进待排产、进“要核对订单”；另一种产品还缺货时，待排产那一步是它，规格提示挂在行下', () => {
  const base = businessBase(actor),
    { store, ops, flow } = base;
  try {
    const day = today();
    const confirm = (doc: { id: number }) => base.check(doc);
    const customer = base.customer({ name: '虚构待排产客户' });
    const [box, color] = (
      [
        ['虚构五金箱', 300, 200, 150],
        ['虚构彩箱', 260, 110, 240],
      ] as const
    ).map(([name, length, width, height]) => base.product({ name, length, width, height, dimensionUnit: 'mm', material: 'A=A', flute: 'B' }));
    for (const p of [box, color])
      base.finished(p, { name: p.name, length: p.length, width: p.width, height: p.height, dimensionUnit: 'mm' });
    const raw = base.raw({ name: '虚构待排产纸板' }, { quantity: '100', date: day });
    const order = (quantities: [number, number]) =>
      store.saveOrder(
        orderSchema.parse({
          customerId: customer.id,
          orderDate: '2026-10-01',
          deliveryDate: '2026-12-30',
          status: '已确认',
          lines: [box, color].map((p, i) => ({ productId: p.id, productName: p.name, specification: `${p.length}×${p.width}×${p.height}`, quantity: quantities[i], unit: '只', unitPriceCents: 100 })),
        }),
      );
    // 第一张：五金箱做完、发完，只剩彩箱一行
    const first = order([1000, 500]);
    const task = flow.save('task', { date: day, plannedDate: day, productId: box.id, quantity: '1000', unit: '只', orderIds: [first.id], notes: '' }, actor);
    confirm(flow.save('production', { date: day, taskId: task.id, productId: box.id, goodQuantity: '1000', scrapQuantity: '0', operator: '虚构机长', materials: [{ stockId: raw.id, issued: '10', returned: '0' }] }, actor));
    const stockOf = (productId: number) => {
      const found = ops.items(false).find((i) => i.kind === 'finished' && i.productId === productId);
      assert.ok(found, '有这个产品的成品库存品');
      return found;
    };
    confirm(flow.save('delivery', { date: day, customerId: customer.id, lines: [{ orderId: first.id, orderLineId: first.lines[0].id, stockId: stockOf(box.id).id, quantity: '1000' }] }, actor));
    // 第二张：五金箱还没做、没库存，彩箱同样对不上
    const second = order([600, 300]);
    // 彩箱的长改成 270：两张订单的彩箱明细（260×110×240）都和产品现在的对不上
    const current = store.product(color.id, true);
    assert.ok(current, '彩箱产品还在');
    manualWrite(store, { entity: 'products', action: 'update', id: color.id, input: { ...current, length: 270 } }, actor);
    const view = buildToday(store, day);
    const row = (id: number) => view.todo.find((r) => r.id === id);
    // 只剩对不上的那一行：不进任何待办分组（不给“安排生产”），进“要核对订单”
    assert.equal(row(first.id), undefined);
    assert.ok(view.specMismatch.some((r) => r.id === first.id));
    const firstMismatch = view.specMismatch.find((r) => r.id === first.id);
    assert.ok(firstMismatch, '第一张在“要核对订单”里');
    assert.match(firstMismatch.mismatches[0], /^虚构彩箱：规格和产品现在的不一样/);
    // 五金箱还缺：待排产那一步只排五金箱（订料或排产），彩箱的规格提示挂在这一行下面
    const next = row(second.id);
    assert.ok(next, '第二张在待办里');
    assert.equal(next.group, 'schedule');
    assert.equal(next.step.params.product ?? next.step.params.products, String(box.id));
    assert.match(next.mismatches[0], /^虚构彩箱：规格和产品现在的不一样/);
  } finally {
    store.close();
  }
});

test('今日页和订单下一步、送货同一个规格判断：规格对不上的订单不进“可发货”、不占别的订单的库存，提示和订单详情同一句', () => {
  // 成品 1000 只，产品 300 × 200 × 150；交期早的那张订单明细写成 260 × 200 × 150，对不上
  const f = setup();
  try {
    const wrong = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-11-09',
        deliveryDate: '2026-11-15',
        status: '已确认',
        lines: [{ productId: f.product.id, productName: f.product.name, specification: '260x200x150', quantity: 1000, unit: '只', unitPriceCents: 350 }],
      }),
    );
    const today = buildToday(f.store, '2026-11-12');
    const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
    // 对不上的不算有库存可发，也不把库存分走：交期晚、规格对得上的那张照样能送
    assert.ok(!ids(today.ready).includes(wrong.id));
    assert.ok(!today.todo.some((r) => r.id === wrong.id && r.group === 'ship'));
    assert.ok(ids(today.ready).includes(f.order.id));
    assert.ok(today.todo.some((r) => r.id === f.order.id && r.group === 'ship'));
    // 提示和订单详情“下一步”同一句
    const wrongOrder = trackedOrder(f.store, wrong.id);
    assert.ok(wrongOrder);
    const steps = orderNextSteps(wrongOrder, { tasks: [], stocks: [f.item()], deliveries: [], purchases: [] });
    assert.deepEqual(ids(today.specMismatch), [wrong.id]);
    assert.deepEqual(today.specMismatch[0].mismatches, steps.notes);
    assert.match(today.specMismatch[0].mismatches[0], /规格和产品现在的不一样，订单明细写的是 260 × 200 × 150.+核对好之前送不了货/);
    assert.equal(today.todo.find((r) => r.id === f.order.id)?.mismatches.length, 0);
  } finally {
    f.store.close();
  }
});

test('按产品取成品库存品、领用减退料：直接调用', () => {
  const items = [
    { id: 1, kind: 'raw', productId: null },
    { id: 2, kind: 'finished', productId: 5 },
    { id: 3, kind: 'finished', productId: 5 },
  ];
  // 同一个产品万一有两条，取先出现的那条（和 find 一样）；原材料不算
  assert.equal(finishedStockByProduct(items).get(5)?.id, 2);
  assert.equal(finishedStockByProduct(items).size, 1);
  assert.equal(stockByProduct([{ id: 8, productId: 6 }]).get(6)?.id, 8);
  assert.equal(netQuantity('10', '2.5'), '7.5');
  assert.equal(netQuantity('x', '1'), '—');
});
