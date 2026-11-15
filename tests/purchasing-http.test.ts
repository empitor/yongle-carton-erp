// 采购库存的接口（server/operations/router.ts、登记到货的接口）：登录、权限、页面凭证、状态码，和只有经接口才有的结果。
// 业务规则本身在服务层的测试里（purchase-save、stock-items、stock-identity、arrival-register）。内存库、虚构数据。
// 准备和读回答的写法在 purchasing-http-fixture.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { count } from '../server/core/index.js';
import { stockItemSchema } from '../shared/business/operations.js';
import { json, password, problem, purchasingFixture, registered } from './purchasing-http-fixture.js';

test('新建采购单：缺价格也能建；待订货的还没有订货单，无从登记到货；写审计', async () => {
  const f = await purchasingFixture();
  try {
    const p = await f.purchase({
      customerOrderId: null,
      expectedDate: null,
      status: '待订货',
      lines: [f.line({ unitPrice: null })],
    });
    assert.equal(p.lines[0].length, 1200);
    assert.equal(p.lines[0].unitPrice, null);
    assert.equal(p.totalAmount, null);
    assert.equal(p.customerOrderId, null);
    assert.equal(p.status, '待订货');
    // 还没订货的采购单没有订货单，无从登记到货
    assert.equal(await json(await f.req('/order-batches/by-purchase/' + p.id)), null);
    assert.ok(f.store.db.prepare("SELECT 1 FROM business_audit WHERE entity='purchases'").get());
  } finally {
    await f.close();
  }
});

test('供应商新建、编辑、按电话搜到并带历史采购；采购单按供应商和状态筛、换供应商保存', async () => {
  const f = await purchasingFixture();
  try {
    let p = await f.purchase();
    assert.equal(p.customerOrderId, f.order.id);
    assert.equal(p.customerOrderNumber, f.order.number);
    assert.equal(p.totalAmount, '1390.0000000');
    const s = await f.saveSupplier({ ...f.supplier, phone: '13800000000', notes: '送货时间协商' }, f.supplier.id);
    assert.equal(s.version, 2);
    const rows = await f.suppliers('?q=13800000000');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].purchaseHistory[0].id, p.id);
    assert.equal((await f.purchases('?supplierId=' + s.id + '&status=已订货')).length, 1);
    const other = await f.saveSupplier({ name: '第二供应商' });
    p = await f.savePurchase(p.id, { ...p, supplierId: other.id, status: p.baseStatus, notes: '变更供应商' });
    assert.equal(p.supplierName, other.name);
    assert.equal(f.repo.purchases(true, p.id)[0].supplierId, other.id);
  } finally {
    await f.close();
  }
});

test('采购分两批到货：部分到货变全部到货、入同一个库存品；流水接口带采购单号和操作人', async () => {
  const f = await purchasingFixture();
  try {
    let p = await f.purchase();
    p = await f.received(p, '400', 'DN-FIRST');
    assert.equal(p.status, '部分到货');
    assert.equal(p.lines[0].receivedQuantity, '400');
    let stock = (await f.items('?kind=raw'))[0];
    assert.equal(stock.quantity, '400');
    const id = stock.id;
    p = await f.received(p, '600', 'DN-SECOND');
    assert.equal(p.status, '全部到货');
    assert.equal(p.lines[0].receivedQuantity, '1000');
    stock = (await f.items())[0];
    assert.equal(stock.id, id);
    assert.equal(stock.quantity, '1000');
    assert.equal(p.receipts.length, 2);
    const movements = await f.movements('?itemId=' + id);
    assert.equal(movements.length, 2);
    assert.equal(movements[0].source_kind, 'flow_arrival');
    assert.equal(movements[0].actor_name, '采购仓库测试管理员');
    assert.equal(movements[0].purchaseNumber, p.number);
  } finally {
    await f.close();
  }
});

test('登记到货接口：要登录和页面凭证；同一请求原样返回、并发只入库一次；同送货单号换凭据 409、超量 422、按同一版本的两份只成一份、多行里一行超量整单不落库', async () => {
  const f = await purchasingFixture();
  const movementCount = () => count(f.store.db, 'SELECT COUNT(*) n FROM stock_movements');
  try {
    let p = await f.purchase();
    const body = await f.receive(p, '400', 'UNIQUE-DN');
    assert.equal((await f.req(...body, 'POST', null)).status, 401);
    assert.equal((await f.req(...body, 'POST', f.h.cookie, false)).status, 403);
    const [a, b] = await Promise.all([f.req(...body), f.req(...body)]).then((rs) =>
      Promise.all(rs.map(async (r) => registered(await json(r)))),
    );
    assert.equal(a.arrival.id, b.arrival.id);
    assert.equal(movementCount(), 1, '同一请求并发只入库一次');
    assert.equal(registered(await f.good(...body)).arrival.id, a.arrival.id);
    assert.equal((await f.arrivalRecords(p.id)).length, 1);
    p = await f.readPurchase(p.id);
    assert.equal(
      (await f.req(...(await f.receive(p, '100', 'UNIQUE-DN')))).status,
      409,
    );
    const over = await f.req(...(await f.receive(p, '601')));
    assert.equal(over.status, 422);
    assert.match((await problem(over)).message, /比还没到的 600 张 多/);
    assert.equal((await f.items())[0].quantity, '400');
    const results = await Promise.all([
      // 两份请求都按同一个订货单版本写好再一起发
      ...(await Promise.all([f.receive(p, '100', 'CONCURRENT-A'), f.receive(p, '100', 'CONCURRENT-B')])).map((r) => f.req(...r)),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await f.items())[0].quantity, '500');
    const multi = await f.purchase({
      lines: [f.line({ name: '原材料A' }), f.line({ name: '原材料B' })],
    });
    const before = movementCount();
    const bad = await f.receive(multi, '10', 'ROLLBACK', {
      items: [
        { lineId: multi.lines[0].id, quantity: '10' },
        { lineId: multi.lines[1].id, quantity: '1001' },
      ],
    });
    assert.equal((await f.req(...bad)).status, 422);
    assert.equal(movementCount(), before);
    assert.equal(f.repo.purchases().find((p) => p.id === multi.id)?.lines[0].receivedUnits, 0);
    assert.equal(f.repo.purchases().find((p) => p.id === multi.id)?.receipts.length, 0);
  } finally {
    await f.close();
  }
});

test('整张保存采购单（PUT）不改状态：改成已订货、已取消都 409，提示用详情里的按钮，版本不变、不建订货单', async () => {
  const f = await purchasingFixture();
  try {
    const p = await f.purchase({ status: '待订货' });
    for (const status of ['已订货', '已取消']) {
      const r = await f.req('/purchases/' + p.id, { ...p, status }, 'PUT');
      assert.equal(r.status, 409, status);
      assert.match((await problem(r)).message, /保存采购单不改状态。.*请用采购单详情里的对应按钮/);
    }
    assert.equal(f.repo.purchases(true, p.id)[0].version, p.version);
    assert.equal(await json(await f.req('/order-batches/by-purchase/' + p.id)), null);
  } finally {
    await f.close();
  }
});

test('手工出入库和盘点：同一请求只记一次；负库存 409；没确认、带系统来源、未来日期、纸板带小数张都 400；原材料只收“张”', async () => {
  const f = await purchasingFixture();
  try {
    // 原材料只收“张”：保存服务拦别的单位，绕过它直接改库也被数据库拦下
    assert.equal((await f.req('/warehouse/items', { name: '独立纸板', kind: 'raw', unit: '平方米' })).status, 400);
    let raw = await f.saveItem({ name: '独立纸板', kind: 'raw', unit: '张' });
    assert.throws(() => f.store.db.prepare("UPDATE stock_items SET unit='平方米' WHERE id=?").run(raw.id), /CHECK constraint failed/);
    let finished = await f.saveItem({ name: '成品箱', kind: 'finished', unit: '只', productId: f.product.id });
    const post = (item: { id: number }, body: unknown) => f.req('/warehouse/items/' + item.id + '/move', body);
    const done = async (item: { id: number }, body: unknown) => (await f.moveItem(item, body)).item;
    for (const patch of [{ quantity: '0.125' }, { acknowledged: false }, { source_kind: 'purchase_receipt' }, { date: '2099-01-01' }])
      assert.equal((await post(raw, { ...f.move(raw, 'in', '1'), ...patch })).status, 400, JSON.stringify(patch));
    const body = f.move(raw, 'in', '125');
    const first = await f.moveItem(raw, body);
    raw = first.item;
    assert.equal(raw.quantity, '125');
    assert.equal((await f.moveItem(raw, body)).movementId, first.movementId);
    assert.equal((await post(raw, f.move(raw, 'out', '126'))).status, 409);
    raw = await done(raw, f.move(raw, 'out', '25'));
    assert.equal(raw.quantity, '100');
    raw = await done(raw, f.move(raw, 'adjust', '0'));
    assert.equal(raw.quantity, '0');
    finished = await done(finished, f.move(finished, 'in', '500', { customerOrderId: f.order.id }));
    finished = await done(finished, f.move(finished, 'out', '100'));
    assert.equal(finished.quantity, '400');
    const flows = await f.movements('?kind=raw');
    assert.deepEqual([flows.length, flows[0].action, flows[0].delta, flows[0].after], [3, 'adjust', '100', '0']);
  } finally {
    await f.close();
  }
});
test('采购和库存的尺寸按 mm、cm 换算比对；有流水后不能改实际规格；单位只收“张”，尺寸单位不认识的拒收', async () => {
  const f = await purchasingFixture();
  try {
    let item = await f.saveItem({ name: '厘米纸板', kind: 'raw', unit: '张', length: 30, width: 20, dimensionUnit: 'cm' });
    const p = await f.purchase({
      lines: [f.line({ ...stockItemSchema.parse(item), stockItemId: item.id, length: 300, width: 200, dimensionUnit: 'mm' })],
    });
    await f.received(p, '10');
    assert.equal(f.repo.items(true, item.id)[0].quantity, '10');
    // 同一个尺寸换个写法可以，真改尺寸不行
    item = await f.saveItem({ ...item, length: 300, width: 200, dimensionUnit: 'mm', version: f.repo.items(true, item.id)[0].version }, item.id);
    assert.deepEqual([item.length, item.dimensionUnit], [300, 'mm']);
    assert.equal((await f.req('/warehouse/items/' + item.id, { ...item, length: 400 }, 'PUT')).status, 400);
    const wrongUnit = { supplierId: f.supplier.id, orderDate: '2026-10-25', status: '已订货', lines: [f.line({ ...stockItemSchema.parse(item), stockItemId: item.id, unit: '只' })] };
    assert.equal((await f.req('/purchases', wrongUnit)).status, 400);
    assert.equal((await f.req('/warehouse/items', { name: '未知单位数字', kind: 'raw', unit: '张', length: 30, dimensionUnit: '英寸' })).status, 400);
  } finally {
    await f.close();
  }
});
test('写接口要登录、业务权限和页面凭证：没登录 401，没有业务权限 403，不带页面凭证 403', async () => {
  const f = await purchasingFixture();
  try {
    const reader = await f.reader();
    const p = await f.purchase();
    const writes: [string, unknown][] = [
      ['/suppliers', { name: '越权' }],
      ['/purchases', { supplierId: f.supplier.id, orderDate: '2026-10-25', status: '已订货', lines: [f.line()] }],
      ['/warehouse/items', { name: '越权', kind: 'raw', unit: '张' }],
      await f.receive(p, '1'),
    ];
    for (const [path, body] of writes) {
      assert.equal((await f.req(path, body, 'POST', null)).status, 401, path);
      assert.equal((await f.req(path, body, 'POST', reader)).status, 403, path);
      assert.equal((await f.req(path, body, 'POST', f.h.cookie, false)).status, 403, path);
    }
    assert.equal(f.repo.purchases(true, p.id)[0].lines[0].receivedQuantity, '0', '被拒的到货没有落库');
  } finally {
    await f.close();
  }
});

test('归档：有采购关联的订单、有库存的库存品不能归档；已归档的供应商进了超级管理员模式才能改', async () => {
  const f = await purchasingFixture();
  try {
    const p = await f.received(await f.purchase(), '400');
    assert.equal((await f.batch('orders', f.order)).results[0].success, false);
    const item = (await f.items())[0];
    assert.equal((await f.batch('stock_items', item)).results[0].success, false);
    assert.equal(f.repo.items(true, item.id)[0].quantity, '400');
    assert.equal(f.repo.purchases(true, p.id)[0].archived, false);
    await f.batch('suppliers', f.supplier);
    // 已归档的记录没进超级管理员模式改不了：说清要进模式（403），不笼统说“不存在或已归档”（404）
    assert.equal((await f.req('/suppliers/' + f.supplier.id, { ...f.supplier, notes: '普通越权' }, 'PUT')).status, 403);
    await f.good('/auth/super-admin/enter', { password });
    const edited = await f.saveSupplier({ ...f.supplier, notes: '超级模式修改归档' }, f.supplier.id);
    assert.deepEqual([edited.notes, edited.archived], ['超级模式修改归档', true]);
  } finally {
    await f.close();
  }
});

test('部分到货后：明细锁定，取消只停余量、不再收货，归档恢复不回退流水', async () => {
  const f = await purchasingFixture();
  try {
    let p = await f.purchase();
    p = await f.received(p, '400');
    assert.equal((await f.batch('purchases', p)).results[0].success, false);
    assert.equal(
      (
        await f.req(
          '/purchases/' + p.id,
          { ...p, status: p.baseStatus, lines: [{ ...p.lines[0], quantity: '2000' }] },
          'PUT',
        )
      ).status,
      400,
    );
    // 整张保存不改状态；取消走采购单的取消动作，原因记进审计
    p = await f.savePurchase(
      p.id,
      {
        expectedVersion: p.version,
        requestId: randomUUID(),
        reason: '取消未到货600张',
      },
      'cancel',
    );
    assert.equal(p.status, '已取消');
    const stopped = await f.req(...(await f.receive(p, '600')));
    assert.equal(stopped.status, 422);
    // 取消的采购单不再算进订货单的待到货
    assert.match((await problem(stopped)).message, /不在订货单里/);
    assert.equal((await f.batch('purchases', p)).results[0].success, true);
    assert.equal(f.repo.items()[0].quantity, '400');
    assert.equal((await f.batch('purchases', p, 'restore')).results[0].success, true);
    assert.equal(f.repo.items()[0].quantity, '400');
    assert.equal(f.repo.purchases()[0].receipts.length, 1);
    let item = (await f.items())[0];
    item = (await f.moveItem(item, f.move(item, 'out', '400'))).item;
    assert.equal((await f.batch('stock_items', item)).results[0].success, true);
    await f.good('/auth/super-admin/enter', { password });
    p = await f.savePurchase(p.id, { ...p, status: p.baseStatus, notes: '归档库存引用保留时修改历史采购备注' });
    assert.match(p.notes, /历史采购备注/);
  } finally {
    await f.close();
  }
});

test('供应商批量归档、恢复；删除没有往来的供应商只删它们自己，删了不能再恢复', async () => {
  const f = await purchasingFixture();
  try {
    const a = await f.saveSupplier({ name: '待删供应商A' }),
      b = await f.saveSupplier({ name: '待删供应商B' });
    const results = await f.batch('suppliers', [a, b]);
    assert.ok(results.results.every((r) => r.success));
    assert.equal((await f.suppliers('?archived=1')).length, 2);
    await f.good('/auth/super-admin/enter', { password });
    const selection = {
      module: 'suppliers',
      items: [
        { id: a.id, version: 1 },
        { id: b.id, version: 1 },
      ],
    };
    const preview = await f.previewDeletion(selection);
    assert.deepEqual(
      preview.impact.map((r) => [r.table, r.action]),
      [
        ['suppliers', 'delete'],
        ['suppliers', 'delete'],
      ],
      '没有往来的供应商：只删它们自己',
    );
    const deletion = { ...selection, requestId: randomUUID(), deletionDigest: preview.digest };
    // 档案删除要超级管理员模式和本人密码（不输不删）由 delete-permissions 守着，这里照规矩带上
    assert.equal((await f.req('/deletions/execute', { ...deletion, password })).status, 200);
    assert.equal(f.repo.suppliers(true).length, 1, '只剩一开始那家');
    assert.equal((await f.batch('suppliers', a, 'restore')).results[0].success, false);
  } finally {
    await f.close();
  }
});

test('新建撞上已有的库存品返回 409 和已有那个的编号；按产品查成品库存、按编号读库存品（归档的也能读）', async () => {
  const f = await purchasingFixture();
  try {
    const raw = await f.saveItem({ name: '虚构查重纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' });
    let r = await f.req('/warehouse/items', { name: '虚构查重纸板 ', kind: 'raw', unit: '张', length: 100, width: 80, dimensionUnit: 'cm' });
    assert.equal(r.status, 409);
    let body = await problem(r);
    assert.equal(body.code, 'stock-exists');
    assert.deepEqual(body.details, { stockId: raw.id, name: '虚构查重纸板', kind: 'raw', archived: false });
    assert.match(body.message, /已经有一样的原材料“虚构查重纸板”/);
    // 产品还没有成品库存时是 null；建了以后查得到，名称按产品
    assert.equal(await f.good('/warehouse/product-stock/' + f.product.id), null);
    const finished = await f.saveItem({ name: '随便', kind: 'finished', unit: '只', productId: f.product.id });
    assert.equal(finished.name, '成品纸箱（虚构）');
    assert.deepEqual(await f.good('/warehouse/product-stock/' + f.product.id), { id: finished.id, name: '成品纸箱（虚构）', archived: false });
    r = await f.req('/warehouse/items', { name: '再建一个', kind: 'finished', unit: '只', productId: f.product.id });
    assert.equal(r.status, 409);
    body = await problem(r);
    assert.deepEqual(body.details, { stockId: finished.id, name: '成品纸箱（虚构）', kind: 'finished', archived: false });
    // 归档后照样查得到，带着“已归档”；按编号读也能读到
    assert.ok((await f.batch('stock_items', finished)).results[0].success);
    assert.deepEqual(await f.good('/warehouse/product-stock/' + f.product.id), { id: finished.id, name: '成品纸箱（虚构）', archived: true });
    const read = await f.readItem(finished.id);
    assert.deepEqual([read.id, read.kind, read.archived], [finished.id, 'finished', true]);
    assert.equal((await f.req('/warehouse/items/999999')).status, 404);
  } finally {
    await f.close();
  }
});

test('读一个库存品时带上“用过没有”：有出入库记录就算用过', async () => {
  const f = await purchasingFixture();
  try {
    const fresh = await f.saveItem({ name: '随便', kind: 'finished', unit: '只', productId: f.product.id });
    assert.equal((await f.readItem(fresh.id)).used, false);
    await f.moveItem(fresh, f.move(fresh, 'in', '5'));
    assert.equal((await f.readItem(fresh.id)).used, true);
  } finally {
    await f.close();
  }
});
