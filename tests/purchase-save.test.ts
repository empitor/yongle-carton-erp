// 保存采购单和供应商（server/operations/purchases/purchase-save.ts、suppliers）：明细规则、已登记到货后锁定、采购进度、归档供应商的修改。
// 页面、助手、数据管理共用这一份保存。内存库、虚构数据。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/index.js';
import { PurchaseWriter } from '../server/operations/purchases/purchase-save.js';
import { OperationsRepository } from '../server/operations/ledger/repository.js';
import { requiredPurchaseSize } from '../shared/business/index.js';
import { businessFixture, flowFixture, clerk } from './flow-fixture.js';
import { receiveLines } from './receive-fixture.js';
import { count } from '../server/core/index.js';
import { AppError } from '../server/core/errors.js';
import type { Actor } from '../server/core/actor.js';
import { errorMessage } from '../shared/core/error-message.js';
import { userError } from '../shared/core/user-errors.js';
import { ZodError } from 'zod';

test('没关联库存品的明细长、宽必填，缺哪栏说哪栏；材质选填；选了库存品的尺寸跟着库存品走', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store);
  try {
    const supplier = ops.saveSupplier({ name: '虚构纸板厂' }, clerk);
    const save = (line: Record<string, unknown>) =>
      ops.savePurchase({ supplierId: supplier.id, orderDate: '2026-11-01', status: '待订货', lines: [{ priceBasis: 'area', ...line }] }, clerk);
    assert.throws(
      () => save({ name: '虚构三层纸板', material: 'K=A', unit: '张', quantity: '100' }),
      (e: unknown) => /明细第1项“虚构三层纸板”没关联库存品，要填纸板的长和宽/.test(errorMessage(e)) && /不要猜/.test(errorMessage(e)),
      '只写材质不够',
    );
    assert.throws(() => save({ name: '虚构三层纸板', length: 1200, unit: '张', quantity: '100' }), /要填纸板的宽（/);
    assert.equal(count(store.db, 'SELECT count(*) n FROM purchases'), 0, '拒收时什么都不写');
    const sized = save({ name: '虚构三层纸板', length: 1200, width: 900, unit: '张', quantity: '100' }).lines[0];
    assert.deepEqual([sized.length, sized.width, sized.material], [1200, 900, ''], '材质不填也能保存');
    // 选了库存里已有的纸板：尺寸跟着库存品（库存品自己没写尺寸也行）
    const item = ops.saveItem({ name: '虚构只写名称的纸板', kind: 'raw', unit: '张' }, clerk);
    assert.equal(save({ name: item.name, stockItemId: item.id, unit: '张', quantity: '10' }).lines[0].stockItemId, item.id);
    // 页面的必填标记按同一份规则
    assert.deepEqual(requiredPurchaseSize({ stockItemId: null }), ['length', 'width']);
    assert.deepEqual(requiredPurchaseSize({ stockItemId: item.id }), []);
  } finally {
    store.close();
  }
});

test('采购明细没写计价方式时不让建，提示选按平方米还是按张，不按默认算钱', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store);
  try {
    const supplier = ops.saveSupplier({ name: '虚构纸板厂' }, clerk);
    const line = { name: '虚构三层纸板', length: 1200, width: 900, unit: '张', quantity: '100', unitPrice: '2' };
    const save = (extra: Record<string, unknown>) =>
      ops.savePurchase({ supplierId: supplier.id, orderDate: '2026-11-01', status: '待订货', lines: [{ ...line, ...extra }] }, clerk);
    // 页面、接口看到的整句（server/http-errors.ts 按 shared/core/user-errors.ts 换成界面叫法）：栏目名只说一次
    const shown = (e: unknown) => (e instanceof ZodError ? e.issues.map((i) => userError(i.path.join('.') + ': ' + i.message)).join('；') : '');
    for (const extra of [{}, { priceBasis: 'piece' }])
      assert.throws(() => save(extra), (e: unknown) => shown(e) === '明细第1项的计价方式：请选择按平方米还是按张', JSON.stringify(extra));
    assert.equal(count(store.db, 'SELECT count(*) n FROM purchases'), 0, '拒收时什么都不写');
    assert.equal(save({ priceBasis: 'area' }).lines[0].priceBasis, 'area');
  } finally {
    store.close();
  }
});

test('保存采购单：纸板只收“张”；改成已订货时自动建订货单；已登记到货的不能改数量', () => {
  const f = flowFixture();
  try {
    const writer = new PurchaseWriter(f.store, new OperationsRepository(f.store));
    const line = { ...f.raw, stockItemId: f.raw.id, quantity: '100', unitPrice: '1', priceBasis: 'quantity' };
    assert.throws(() => writer.savePurchase({ supplierId: f.supplier.id, status: '待订货', orderDate: '2026-10-01', lines: [{ ...line, unit: '公斤' }] }, clerk), /张/);
    const p = writer.savePurchase({ supplierId: f.supplier.id, status: '已订货', orderDate: '2026-10-01', lines: [line] }, clerk);
    assert.ok(f.store.db.prepare('SELECT 1 FROM order_batch_purchases WHERE purchase_id=?').get(p.id), '已订货自动建订货单');
    receiveLines(
      f.store,
      p.id,
      { requestId: randomUUID(), reference: '虚构送货单-锁定', date: '2026-10-10', items: [{ lineId: p.lines[0].id, quantity: '10' }] },
      clerk,
    );
    const current = f.flow.views.purchases(true, p.id)[0];
    assert.throws(
      () => f.flow.stock.savePurchase({ supplierId: f.supplier.id, status: '已订货', orderDate: '2026-10-01', version: current.version, lines: [{ ...current.lines[0], quantity: '200' }] }, clerk, p.id),
      /已登记到货的采购单不能修改.*可改订货单的到货安排/,
    );
  } finally {
    f.store.close();
  }
});

test('采购进度按明细行判断：一行超收盖不住另一行没到', () => {
  const f = businessFixture();
  try {
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        customerOrderId: f.order.id,
        orderDate: '2026-10-01',
        status: '已订货',
        lines: [
          { stockItemId: f.raw.id, name: f.raw.name, quantity: '100', unit: '张', priceBasis: 'quantity' },
          { stockItemId: f.glue.id, name: f.glue.name, quantity: '100', unit: '张', priceBasis: 'quantity' },
        ],
      },
      f.actor,
    );
    // 历史数据里有超收：第一行多到 100 张，第二行一张没到。按总量相加会误报“全部到货”。
    f.store.db
      .prepare('UPDATE purchase_lines SET received_units=200000 WHERE id=?')
      .run(purchase.lines[0].id);
    assert.equal(f.store.order(f.order.id)?.materialProgress, 'partial');
  } finally {
    f.store.close();
  }
});

test('已登记到货的采购单：普通业务账号、不在本机的超级管理员改不了供应商、数量、价格（数据不变），不能退回待订货，全部到货后不能取消；本机管理员能改', () => {
  const f = businessFixture();
  try {
    const clerk = pageActor({ id: 'fictional-clerk', name: '虚构业务员', permissions: ['business:edit'] });
    const remote = pageActor({
      id: 'fictional-remote-admin',
      name: '虚构远程管理员',
      role: 'super_admin' as const,
      permissions: ['business:edit'],
      superAdminMode: true,
      superAdminUntil: Date.now() + 3600000,
    });
    const other = f.ops.saveSupplier({ name: '虚构另一家供应商' }, f.actor);
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-01',
        status: '已订货',
        lines: [{ stockItemId: f.raw.id, name: f.raw.name, unit: '张', quantity: '100', unitPrice: '1.2000', priceBasis: 'quantity' }],
      },
      f.actor,
    );
    const current = () => f.flow.views.purchases(true, purchase.id)[0];
    const receive = (quantity: string) => {
      const p = current();
      receiveLines(
        f.store,
        p.id,
        { requestId: randomUUID(), reference: 'DN-' + randomUUID(), date: '2026-10-02', items: [{ lineId: p.lines[0].id, quantity }] },
        f.actor,
      );
    };
    const edit = (patch: Record<string, unknown>, line: Record<string, unknown> = {}) => {
      const p = current();
      return { ...p, status: p.baseStatus, version: p.version, lines: p.lines.map((l) => ({ ...l, ...line })), ...patch };
    };
    receive('40');
    const locked = /已登记到货的采购单不能修改采购日期、供应商、明细、数量或价格/;
    const before = JSON.stringify(current());
    for (const who of [clerk, remote]) {
      for (const [patch, line] of [
        [{ supplierId: other.id }, {}],
        [{}, { quantity: '120' }],
        [{}, { unitPrice: '1.5000' }],
        [{ orderDate: '2026-09-30' }, {}],
      ] as const) {
        assert.throws(() => f.flow.stock.savePurchase(edit(patch, line), who, purchase.id), locked, who.name + JSON.stringify([patch, line]));
        assert.equal(JSON.stringify(current()), before, '被拒绝后采购单一点没变');
      }
      assert.throws(() => f.flow.stock.savePurchase(edit({ status: '待订货' }), who, purchase.id), /已有到货，不能退回待订货状态。/);
      assert.equal(JSON.stringify(current()), before);
    }
    // 备注照常能改
    assert.equal(f.flow.stock.savePurchase(edit({ notes: '虚构备注' }), clerk, purchase.id).notes, '虚构备注');
    // 本机管理员能改价格
    const changed = f.flow.stock.savePurchase(edit({}, { unitPrice: '1.5000' }), f.actor, purchase.id);
    assert.equal(Number(changed.lines[0].unitPrice), 1.5);
    // 全部到货以后不能取消
    receive('60');
    assert.equal(current().status, '全部到货');
    for (const who of [clerk, remote])
      assert.throws(
        () => f.flow.stock.savePurchase(edit({ status: '已取消' }), who, purchase.id),
        /已经全部到货，不能取消；库存不会因取消而回退。/,
      );
    assert.equal(current().status, '全部到货');
  } finally {
    f.store.close();
  }
});

test('改已归档的供应商：要超级管理员模式，按账号分两类说（业务员没有权限、没进模式的超级管理员去系统维护），不再笼统说“记录不存在或已归档”', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store);
  try {
    const clerk = pageActor({ id: 'fictional-clerk', name: '虚构业务员', role: 'admin' as const, permissions: ['business:edit'] });
    const waiting = { ...clerk, id: 'fictional-super', role: 'super_admin' as const, superAdminMode: false };
    const elevated = { ...waiting, superAdminMode: true, superAdminUntil: Date.now() + 600000 };
    const supplier = ops.saveSupplier({ name: '虚构归档供应商' }, clerk);
    store.markArchived('suppliers', supplier.id, clerk.id);
    const edit = (who: Actor) => ops.saveSupplier({ name: '虚构归档供应商', notes: '虚构改备注', version: supplier.version }, who, supplier.id);
    assert.throws(() => edit(clerk), (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'permission' && e.message === '修改已归档的记录要用超级管理员账号，当前账号没有这个权限。');
    assert.throws(() => edit(waiting), (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'super-mode' && /系统维护/.test(e.message));
    assert.equal(edit(elevated).notes, '虚构改备注');
    // 真没有的记录照旧 404
    assert.throws(() => ops.saveSupplier({ name: '虚构', version: 1 }, clerk, 999999), (e: unknown) => e instanceof AppError && e.status === 404 && e.message === '记录不存在。');
  } finally {
    store.close();
  }
});
