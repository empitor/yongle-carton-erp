import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import {
  sheetArea,
  purchaseLineAmount,
  flowStatusLabel,
  matchesFlowStatus,
} from '../shared/physical-flow.js';
import { productSchema, customerSchema, orderSchema } from '../shared/domain.js';
import type { Actor } from '../server/auth.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { changeLifecycle } from '../server/business/management.js';
import { PermanentDeletionService } from '../server/business/permanent-deletion.js';
const actor: Actor = {
  id: 'test-operator',
  name: '虚构测试操作员',
  permissions: ['business:edit'],
};
const superActor = (): Actor => ({
  ...actor,
  role: 'super_admin',
  superAdminMode: true,
  superAdminUntil: Date.now() + 60000,
});
function fixture(file = ':memory:') {
  const store = new Store(file),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构采购客户' }));
  const product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
  const supplier = ops.saveSupplier({ name: '虚构纸板供应商' }, actor);
  const rawInput = {
    name: '五层纸板',
    kind: 'raw',
    unit: '张',
    length: 100,
    width: 80,
    height: null,
    dimensionUnit: 'cm',
    material: 'K=A',
    flute: 'BC',
    specification: '100×80cm',
    notes: '',
    productId: null,
  };
  const raw = ops.saveItem(rawInput, actor),
    finished = ops.saveItem(
      {
        ...rawInput,
        name: '虚构成品A',
        kind: 'finished',
        unit: '只',
        productId: product.id,
        specification: '型号A',
      },
      actor,
    );
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-30',
      status: '已确认',
      notes: '',
      costs: null,
      lines: [
        {
          productId: product.id,
          productName: product.name,
          specification: '型号A',
          quantity: 100,
          unit: '只',
          unitPriceCents: 123,
          notes: '包装说明',
        },
      ],
    }),
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: null,
      orderDate: '2026-10-01',
      expectedDate: '2026-10-20',
      status: '已订货',
      notes: '',
      lines: [
        {
          ...rawInput,
          stockItemId: raw.id,
          quantity: '200',
          unitPrice: '2.1234',
          priceBasis: 'area',
        },
      ],
    },
    actor,
  );
  const confirm = (d: any, who = actor) => {
    const p = flow.preview(d.id, who, 'session');
    return flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      who,
      'session',
    );
  };
  const arrival = (quantity = '100', reference: string = randomUUID(), extra: any = {}) =>
    flow.save(
      'arrival',
      {
        date: '2026-10-20',
        supplierId: supplier.id,
        reference,
        lines: [
          {
            stockId: raw.id,
            purchaseLineId: purchase.lines[0].id,
            item: rawInput,
            quantity,
            unitPrice: '2.1234',
            priceBasis: 'area',
          },
        ],
        ...extra,
      },
      actor,
    );
  const production = (goodQuantity = '60', extra: any = {}) =>
    flow.save(
      'production',
      {
        date: '2026-10-21',
        productId: product.id,
        finishedStockId: finished.id,
        goodQuantity,
        scrapQuantity: '5',
        operator: '虚构机长',
        materials: [{ stockId: raw.id, issued: '80', returned: '10' }],
        ...extra,
      },
      actor,
    );
  const delivery = (quantity = '40', extra: any = {}) =>
    flow.save(
      'delivery',
      {
        date: '2026-10-22',
        customerId: customer.id,
        lines: [
          { orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity },
        ],
        ...extra,
      },
      actor,
    );
  return {
    store,
    ops,
    flow,
    customer,
    product,
    supplier,
    raw,
    rawInput,
    finished,
    order,
    purchase,
    confirm,
    arrival,
    production,
    delivery,
  };
}
test('面积计价精确处理mm/cm、小数张数和未知单位，不改变传统数量计价', () => {
  assert.equal(sheetArea({ unit: '张', length: 100, width: 80, dimensionUnit: 'cm' }, '100'), '80');
  assert.equal(
    sheetArea({ unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' }, '100'),
    '80',
  );
  assert.equal(sheetArea({ unit: '张', length: 100, width: 80, dimensionUnit: null }, '100'), null);
  assert.equal(
    purchaseLineAmount({
      unit: '张',
      length: 100,
      width: 80,
      dimensionUnit: 'cm',
      quantity: '200',
      unitPrice: '2.1234',
      priceBasis: 'area',
    }),
    '339.744',
  );
});
test('采购分批收货→领料退料/损耗→分批完工→分批送货→订单完成，库存与明细联动', () => {
  const f = fixture();
  try {
    assert.equal(f.purchase.totalAmount, '339.7440000');
    const first = f.arrival('100', 'DH-001');
    assert.equal(f.ops.repo.balance(f.raw.id), 0);
    f.confirm(first);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.equal(f.ops.repo.purchases()[0].status, '部分到货');
    f.confirm(f.arrival('100', 'DH-002'));
    assert.equal(f.ops.repo.purchases()[0].status, '全部到货');
    const task = f.confirm(
      f.flow.save(
        'task',
        {
          date: '2026-10-21',
          productId: f.product.id,
          quantity: '100',
          unit: '只',
          orderIds: [f.order.id],
        },
        actor,
      ),
    );
    f.confirm(f.production('60', { taskId: task.id }));
    assert.equal(f.ops.repo.balance(f.raw.id), 130000);
    assert.equal(f.ops.repo.balance(f.finished.id), 60000);
    assert.equal(f.flow.get(task.id).completed, '60');
    assert.equal(f.flow.get(task.id).progress, 60);
    f.confirm(f.delivery('40'));
    let order = f.store.order(f.order.id)!;
    assert.equal(order.status, '待发货');
    assert.equal(order.lines[0].shippedQuantity, 40);
    assert.equal(order.lines[0].remainingQuantity, 60);
    f.confirm(
      f.production('40', {
        taskId: task.id,
        materials: [{ stockId: f.raw.id, issued: '45', returned: '5' }],
      }),
    );
    assert.equal(f.flow.get(task.id).completed, '100');
    f.confirm(f.delivery('60'));
    order = f.store.order(f.order.id)!;
    assert.equal(order.status, '已发货');
    assert.equal(order.lines[0].remainingQuantity, 0);
    assert.equal(f.ops.repo.balance(f.finished.id), 0);
    assert.equal(f.ops.repo.balance(f.raw.id), 90000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) n FROM stock_movements WHERE source_kind='flow_production'")
        .get()!.n,
      6,
    );
  } finally {
    f.store.close();
  }
});
test('同文件/送货号拒绝重复；幂等重试、并行旧预览、库存不足整单回滚', () => {
  const f = fixture();
  try {
    const d = f.arrival('100', 'dh-1'),
      p = f.flow.preview(d.id, actor, 'session'),
      request = { previewId: p.previewId, requestId: randomUUID(), acknowledged: true };
    const a = f.flow.confirm(d.id, request, actor, 'session');
    assert.deepEqual(f.flow.confirm(d.id, request, actor, 'session'), a);
    const dup = f.arrival('50', ' DH-1 ');
    assert.throws(() => f.confirm(dup), /不能重复入库/);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    const prod = f.production(),
      p1 = f.flow.preview(prod.id, actor, 'session');
    f.confirm(
      f.production('20', { materials: [{ stockId: f.raw.id, issued: '10', returned: '0' }] }),
    );
    assert.throws(
      () =>
        f.flow.confirm(
          prod.id,
          { previewId: p1.previewId, requestId: randomUUID(), acknowledged: true },
          actor,
          'session',
        ),
      /已变化/,
    );
    const insufficient = f.production('5', {
      materials: [{ stockId: f.raw.id, issued: '100', returned: '10' }],
    });
    assert.throws(() => f.confirm(insufficient), /库存不足/);
    assert.equal(f.ops.repo.balance(f.finished.id), 20000);
    const delivery = f.delivery('30');
    assert.throws(() => f.confirm(delivery), /库存不足/);
    assert.equal(f.store.order(f.order.id)!.lines[0].shippedQuantity, 0);
    assert.equal(f.flow.get(delivery.id).status, 'draft');
  } finally {
    f.store.close();
  }
});
test('规格完整区分、无采购单多纸板收货、差异原因、未知面积不伪造', () => {
  const f = fixture();
  try {
    const wrong = { ...f.rawInput, length: 120 };
    assert.throws(
      () =>
        f.flow.save(
          'arrival',
          {
            date: '2026-10-20',
            supplierId: f.supplier.id,
            reference: 'wrong',
            lines: [{ stockId: f.raw.id, item: wrong, quantity: '10' }],
          },
          actor,
        ),
      /不一致/,
    );
    assert.throws(
      () =>
        f.flow.save(
          'arrival',
          {
            date: '2026-10-20',
            supplierId: f.supplier.id,
            reference: 'diff',
            lines: [{ stockId: f.raw.id, item: f.rawInput, quantity: '10', statedQuantity: '12' }],
          },
          actor,
        ),
      /差异原因/,
    );
    const d = f.flow.save(
        'arrival',
        {
          date: '2026-10-20',
          supplierId: f.supplier.id,
          reference: '无单多项',
          lines: [
            { item: f.rawInput, quantity: '10', differenceReason: '独立备料' },
            {
              item: { ...wrong, dimensionUnit: null },
              quantity: '12',
              unitPrice: '1.2345',
              differenceReason: '规格待补充',
            },
          ],
        },
        actor,
      ),
      p = f.flow.preview(d.id, actor, 'session');
    assert.equal(p.lines[1].area, null);
    assert.equal(p.lines[1].amount, null);
    const result = f.confirm(d);
    assert.notEqual(result.lines[0].stockId, result.lines[1].stockId);
    assert.equal(f.ops.repo.items().filter((i) => i.kind === 'raw').length, 3);
  } finally {
    f.store.close();
  }
});
test('确认后禁止编辑/普通删除，冲销需超级验证；下游库存阻止冲销，反向更正与恢复保留审计', () => {
  const f = fixture();
  try {
    const a = f.confirm(f.arrival('100', 'recover'));
    assert.throws(
      () => f.flow.save('arrival', { ...a, version: a.version }, actor, a.id),
      /只能编辑/,
    );
    assert.throws(() => f.flow.archive(a.id, false, actor), /保留历史/);
    assert.throws(
      () => f.flow.reverse(a.id, { version: a.version, reason: '核错', acknowledged: true }, actor),
      /超级管理员/,
    );
    const prod = f.confirm(f.production('60'));
    assert.throws(
      () =>
        f.flow.reverse(
          a.id,
          { version: a.version, reason: '核错', acknowledged: true },
          superActor(),
        ),
      /后续业务/,
    );
    const d = f.confirm(f.delivery('40'));
    assert.throws(
      () =>
        f.flow.reverse(
          prod.id,
          { version: prod.version, reason: '核错', acknowledged: true },
          superActor(),
        ),
      /后续业务/,
    );
    f.flow.reverse(
      d.id,
      { version: d.version, reason: '送货更正', acknowledged: true },
      superActor(),
    );
    assert.equal(f.store.order(f.order.id)!.lines[0].shippedQuantity, 0);
    assert.equal(f.ops.repo.balance(f.finished.id), 60000);
    f.flow.reverse(
      prod.id,
      { version: prod.version, reason: '生产更正', acknowledged: true },
      superActor(),
    );
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.equal(f.ops.repo.balance(f.finished.id), 0);
    f.flow.reverse(
      a.id,
      { version: a.version, reason: '收货更正', acknowledged: true },
      superActor(),
    );
    assert.equal(f.ops.repo.balance(f.raw.id), 0);
    assert.equal(f.ops.repo.purchases()[0].lines[0].receivedQuantity, '0');
    const correction = f.flow.save(
      'arrival',
      {
        date: a.date,
        supplierId: f.supplier.id,
        reference: 'recover',
        correctionOf: a.id,
        lines: [
          {
            stockId: f.raw.id,
            purchaseLineId: f.purchase.lines[0].id,
            item: f.rawInput,
            quantity: '90',
          },
        ],
      },
      superActor(),
    );
    assert.throws(() => f.confirm(correction), /超级管理员|确认/);
    f.confirm(correction, superActor());
    assert.equal(f.ops.repo.balance(f.raw.id), 90000);
    const draft = f.delivery('10');
    f.flow.cancel(draft.id, { version: draft.version, reason: '暂缓', acknowledged: true }, actor);
    f.flow.archive(draft.id, false, actor);
    assert.equal(
      f.flow.list('delivery').some((x) => x.id === draft.id),
      false,
    );
    f.flow.archive(draft.id, true, actor);
    assert.equal(f.flow.get(draft.id).archived, false);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('后续引用阻止订单撤回/永久删除，客户订单金额备注编辑保留稳定明细编号', () => {
  const f = fixture();
  try {
    const task = f.flow.save(
      'task',
      {
        date: '2026-10-20',
        productId: f.product.id,
        quantity: '100',
        unit: '只',
        orderIds: [f.order.id],
      },
      actor,
    );
    const result = changeLifecycle(
      f.store,
      'orders',
      {
        action: 'archive',
        acknowledged: true,
        items: [{ id: f.order.id, version: f.order.version }],
      },
      actor,
    );
    assert.equal(result.results[0].success, false);
    const old = f.store.order(f.order.id)!,
      changed = f.store.saveOrder(
        orderSchema.parse({
          ...old,
          notes: '改备注',
          lines: old.lines.map((l) => ({ ...l, unitPriceCents: 124 })),
        }),
        old.id,
        old.version,
      );
    assert.equal(changed.lines[0].id, old.lines[0].id);
    assert.throws(
      () =>
        f.store.saveOrder(
          orderSchema.parse({
            ...changed,
            lines: changed.lines.map((l) => ({ ...l, quantity: 99 })),
          }),
          old.id,
          changed.version,
        ),
      /不能改变/,
    );
    const deletion = new PermanentDeletionService(f.store),
      p = deletion.preview(
        { entity: 'orders', items: [{ id: old.id, version: changed.version }] },
        superActor(),
        'session',
      );
    assert.match(p.plan.blockers.join(''), /生产或送货/);
  } finally {
    f.store.close();
  }
});
test('生产/送货预览绑定用户会话与版本、超订单数量须超级批准、禁止超库存', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    f.confirm(f.production('120'));
    const d = f.flow.save(
      'delivery',
      {
        date: '2026-10-22',
        customerId: f.customer.id,
        lines: [
          {
            orderId: f.order.id,
            orderLineId: f.order.lines[0].id,
            stockId: f.finished.id,
            quantity: '110',
          },
        ],
        allowOverdelivery: true,
        overdeliveryReason: '客户确认追加',
      },
      superActor(),
    );
    assert.throws(() => f.flow.preview(d.id, actor, 'session'), /超级管理员/);
    const p = f.flow.preview(d.id, superActor(), 'session');
    assert.throws(
      () =>
        f.flow.confirm(
          d.id,
          { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
          superActor(),
          'another-session',
        ),
      /失效/,
    );
    f.flow.confirm(
      d.id,
      { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
      superActor(),
      'session',
    );
    assert.equal(f.store.order(f.order.id)!.lines[0].shippedQuantity, 110);
  } finally {
    f.store.close();
  }
});
test('新表安全迁移与重开持久保存，不重建已有业务数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-flow-'));
  try {
    const file = join(dir, 'erp.sqlite'),
      f = fixture(file);
    f.confirm(f.arrival());
    const count = f.store.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n;
    f.store.close();
    const s = new Store(file);
    try {
      assert.equal(new FlowService(s).list('arrival')[0].status, 'confirmed');
      assert.equal(
        new OperationsService(s).repo.items().find((i) => i.kind === 'raw')!.quantity,
        '100',
      );
      assert.equal(s.db.prepare('SELECT COUNT(*) n FROM business_audit').get()!.n, count);
      assert.equal(s.customers().length, 1);
      assert.equal(s.orders().length, 1);
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('HTTP写入必须登录/CSRF，服务真实联通且原始文件上传无本地解析依赖', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const setup = await fetch(base + '/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
        body: JSON.stringify({ name: '虚构账号', password: 'fictional-flow-password-123' }),
      }),
      cookie = setup.headers.get('set-cookie')!.split(';')[0];
    assert.equal(setup.status, 200);
    const req = (path: string, body: any, authenticated = true, csrf = true) =>
      fetch(base + '/api' + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { Cookie: cookie } : {}),
          ...(csrf ? { 'X-ERP-Auth-Token': auth.csrf } : {}),
        },
        body: JSON.stringify(body),
      });
    const task = { date: '2026-10-20', productId: f.product.id, quantity: '100', unit: '只' };
    assert.equal((await req('/flow/task', task, false)).status, 401);
    assert.equal((await req('/flow/task', task, true, false)).status, 403);
    assert.equal((await req('/flow/task', task)).status, 201);
    const a = f.arrival('100', 'HTTP-CONCURRENT-1'),
      p = await req('/flow/' + a.id + '/preview', {}).then((r) => r.json()),
      input = { previewId: p.previewId, requestId: randomUUID(), acknowledged: true };
    const responses = await Promise.all([
      req('/flow/' + a.id + '/confirm', input),
      req('/flow/' + a.id + '/confirm', input),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 200],
    );
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    const b = f.arrival('50', 'HTTP-CONCURRENT-2'),
      c = f.arrival('50', 'HTTP-CONCURRENT-3'),
      pb = await req('/flow/' + b.id + '/preview', {}).then((r) => r.json()),
      pc = await req('/flow/' + c.id + '/preview', {}).then((r) => r.json());
    const races = await Promise.all([
      req('/flow/' + b.id + '/confirm', {
        previewId: pb.previewId,
        requestId: randomUUID(),
        acknowledged: true,
      }),
      req('/flow/' + c.id + '/confirm', {
        previewId: pc.previewId,
        requestId: randomUUID(),
        acknowledged: true,
      }),
    ]);
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.ops.repo.balance(f.raw.id), 150000);
    const draft = f.arrival('10', 'VERSION-LIFECYCLE'),
      edited = f.flow.save('arrival', { ...draft, notes: '另一用户已改内容' }, actor, draft.id);
    assert.equal(
      (
        await req('/flow/' + draft.id + '/lifecycle', {
          action: 'archive',
          version: draft.version,
          acknowledged: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (await req('/flow/' + draft.id + '/lifecycle', { action: 'archive', acknowledged: true }))
        .status,
      400,
    );
    assert.equal(
      (
        await req('/flow/' + draft.id + '/lifecycle', {
          action: 'archive',
          version: edited.version,
          acknowledged: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req('/flow/' + draft.id + '/lifecycle', {
          action: 'restore',
          version: edited.version,
          acknowledged: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req('/flow/' + draft.id + '/lifecycle', {
          action: 'restore',
          version: f.flow.get(draft.id).version,
          acknowledged: true,
        })
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.store.close();
  }
});
test('生产进度达到实际计划量才完工，99.9%仍待生产剩余数量，状态筛选与业务含义一致', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    const task = f.confirm(
      f.flow.save(
        'task',
        { date: '2026-10-21', productId: f.product.id, quantity: '1000', unit: '只' },
        actor,
      ),
    );
    assert.equal(flowStatusLabel(task), '待生产');
    assert(matchesFlowStatus(task, '待生产'));
    f.confirm(f.production('999', { taskId: task.id }));
    const partial = f.flow.get(task.id);
    assert.equal(partial.completed, '999');
    assert.equal(partial.progress, 99);
    assert.equal(flowStatusLabel(partial), '生产中');
    assert(!matchesFlowStatus(partial, '已完工'));
    f.confirm(
      f.production('1', {
        taskId: task.id,
        materials: [{ stockId: f.raw.id, issued: '1', returned: '0' }],
      }),
    );
    const full = f.flow.get(task.id);
    assert.equal(full.progress, 100);
    assert.equal(flowStatusLabel(full), '已完工');
    assert(matchesFlowStatus(full, '已完工'));
    assert.equal(flowStatusLabel({ kind: 'arrival', status: 'confirmed' }), '已确认收货');
    assert.equal(flowStatusLabel({ kind: 'delivery', status: 'confirmed' }), '已确认发货');
    assert.equal(flowStatusLabel({ kind: 'production', status: 'reversed' }), '已冲销');
  } finally {
    f.store.close();
  }
});
test('写入阶段异常整单回滚；多订单任务、独立生产、多订单送货与单位/型号安全', () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.flow.save(
          'task',
          { date: '2026-10-20', productId: f.product.id, quantity: '10', unit: '只' },
          { ...actor, permissions: [] },
        ),
      /没有.*权限/,
    );
    const unplanned = f.flow.save(
        'arrival',
        {
          date: '2026-10-20',
          supplierId: f.supplier.id,
          reference: 'ROLLBACK',
          lines: [{ item: { ...f.rawInput, name: '新独立规格' }, quantity: '10' }],
        },
        actor,
      ),
      p = f.flow.preview(unplanned.id, actor, 'session');
    f.store.db.exec(
      "CREATE TRIGGER fail_flow BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT,'test write failure'); END",
    );
    assert.throws(
      () =>
        f.flow.confirm(
          unplanned.id,
          { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
          actor,
          'session',
        ),
      /test write failure/,
    );
    f.store.db.exec('DROP TRIGGER fail_flow');
    assert.equal(f.ops.repo.items().length, 2);
    assert.equal(f.flow.get(unplanned.id).status, 'draft');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM flow_receipt_keys').get()!.n, 0);
    f.confirm(f.arrival());
    const second = f.store.saveOrder(
      orderSchema.parse({
        ...f.order,
        lines: f.order.lines.map((l) => ({ ...l, id: undefined, quantity: 50 })),
      }),
    );
    const task = f.confirm(
      f.flow.save(
        'task',
        {
          date: '2026-10-20',
          productId: f.product.id,
          quantity: '150',
          unit: '只',
          orderIds: [f.order.id, second.id],
        },
        actor,
      ),
    );
    assert.equal(task.orderIds.length, 2);
    f.confirm(
      f.production('150', {
        taskId: null,
        materials: [{ stockId: f.raw.id, issued: '90', returned: '0' }],
      }),
    );
    const multi = f.flow.save(
      'delivery',
      {
        date: '2026-10-25',
        customerId: f.customer.id,
        lines: [
          {
            orderId: f.order.id,
            orderLineId: f.order.lines[0].id,
            stockId: f.finished.id,
            quantity: '100',
          },
          {
            orderId: second.id,
            orderLineId: second.lines[0].id,
            stockId: f.finished.id,
            quantity: '50',
          },
        ],
      },
      actor,
    );
    f.confirm(multi);
    assert.equal(f.store.order(f.order.id)!.status, '已发货');
    assert.equal(f.store.order(second.id)!.status, '已发货');
    assert.equal(f.ops.repo.balance(f.finished.id), 0);
    const bad = f.ops.saveItem(
      {
        ...f.rawInput,
        name: '错误型号',
        kind: 'finished',
        unit: '只',
        productId: f.product.id,
        specification: '型号B',
      },
      actor,
    );
    assert.throws(
      () =>
        f.flow.save(
          'delivery',
          {
            date: '2026-10-25',
            customerId: f.customer.id,
            lines: [
              {
                orderId: second.id,
                orderLineId: second.lines[0].id,
                stockId: bad.id,
                quantity: '1',
              },
            ],
          },
          actor,
        ),
      /型号/,
    );
  } finally {
    f.store.close();
  }
});
test('同一原料供不同产品生产，混合成品单位送货不合并；取消剩余任务保留实产库存', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    const task = f.confirm(
      f.flow.save(
        'task',
        {
          date: '2026-10-20',
          productId: f.product.id,
          quantity: '150',
          unit: '只',
          orderIds: [f.order.id],
        },
        actor,
      ),
    );
    f.confirm(f.production('100', { taskId: task.id }));
    const product2 = f.store.saveProduct(productSchema.parse({ name: '虚构第二款纸箱' })),
      stock2 = f.ops.saveItem(
        {
          ...f.rawInput,
          name: '虚构箱装成品',
          kind: 'finished',
          productId: product2.id,
          specification: '型号C',
          unit: '箱',
        },
        actor,
      ),
      order2 = f.store.saveOrder(
        orderSchema.parse({
          ...f.order,
          lines: [
            {
              productId: product2.id,
              productName: product2.name,
              specification: '型号C',
              unit: '箱',
              quantity: 10,
              unitPriceCents: 1000,
            },
          ],
        }),
      );
    f.confirm(
      f.flow.save(
        'production',
        {
          date: '2026-10-22',
          productId: product2.id,
          finishedStockId: stock2.id,
          goodQuantity: '10',
          scrapQuantity: '2',
          operator: '虚构人员',
          materials: [{ stockId: f.raw.id, issued: '30', returned: '0' }],
        },
        actor,
      ),
    );
    f.confirm(
      f.flow.save(
        'delivery',
        {
          date: '2026-10-25',
          customerId: f.customer.id,
          lines: [
            {
              orderId: f.order.id,
              orderLineId: f.order.lines[0].id,
              stockId: f.finished.id,
              quantity: '20',
            },
            {
              orderId: order2.id,
              orderLineId: order2.lines[0].id,
              stockId: stock2.id,
              quantity: '10',
            },
          ],
        },
        actor,
      ),
    );
    assert.equal(f.ops.repo.balance(f.finished.id), 80000);
    assert.equal(f.ops.repo.balance(stock2.id), 0);
    assert.equal(f.store.order(order2.id)!.status, '已发货');
    assert.equal(f.store.order(f.order.id)!.lines[0].remainingQuantity, 80);
    const current = f.flow.get(task.id);
    f.flow.cancel(
      task.id,
      { version: current.version, reason: '暂停剩余50只任务', acknowledged: true },
      actor,
    );
    assert.equal(f.flow.get(task.id).status, 'cancelled');
    assert.equal(f.flow.get(task.id).completed, '100');
    assert.equal(f.ops.repo.balance(f.finished.id), 80000);
    assert.throws(() => f.confirm(f.production('1', { taskId: task.id })), /任务/);
  } finally {
    f.store.close();
  }
});
