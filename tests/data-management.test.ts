// 本机管理员的“数据管理”（server/admin/data-management-service.ts）：谁能用、改的版本幂等、新建模板、读记录和列表显示。
// 删除不在数据管理命令里（data-management-delete.test.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { AppError, count, isLocalAdministrator, one, rows, type Actor } from '../server/core/index.js';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/service.js';
import { recordStatus } from '../src/admin/record-refs.js';
import { basics, command, firstResult } from './data-management-fixture.js';
import { superActor, actor } from './actor-fixture.js';
import { must } from './read-result.js';


test('本机管理员的能力不能由普通对象属性伪造；普通账号、超级管理员模式都用不了数据管理', () => {
  const f = basics();
  try {
    for (const who of [null, actor, superActor(), { ...superActor(), localAdministrator: true }]) {
      assert.equal(isLocalAdministrator(who), false);
      assert.throws(
        () => f.service.execute(command('customers', 'create', [], { name: '不可创建' }), who, 's'),
        /本机最高管理员/,
      );
    }
    assert.equal(f.store.customers().length, 1);
  } finally {
    f.store.close();
  }
});
test('本机管理员在数据管理里改归档订单：版本、幂等、批量原子保留', () => {
  const f = basics();
  try {
    const archived = f.service.execute(command('orders', 'archive', [f.order]), f.who, 's');
    assert.equal(archived.count, 1);
    let row = must(f.store.order(f.order.id, true), '订单');
    // 明细照编辑窗给的那份（input）改：订单读出来的样子带着已送数量这类派生的栏目，录入不收
    const input = must(f.service.list('orders', f.who).records.find((r) => r.record.id === row.id), '订单').input;
    const edit = command('orders', 'update', [row], {
      notes: '归档后修正',
      lines: [{ ...input.lines[0], quantity: 200, unitPriceExact: '1.2345' }],
      roundingPolicy: 'half-up-cent',
    });
    const a = f.service.execute(edit, f.who, 's');
    assert.equal(firstResult(a).totalAmountExact, '246.9000');
    assert.equal(must(f.store.order(row.id, true), '订单').notes, '归档后修正');
    assert.deepEqual(f.service.execute(edit, f.who, 's'), a);
    assert.throws(
      () => f.service.execute({ ...edit, requestId: randomUUID() }, f.who, 's'),
      /变化/,
    );
    row = must(f.store.order(row.id, true), '订单');
    assert.throws(
      () =>
        f.service.execute(
          command('orders', 'update', [row, { id: 9999, version: 1 }], { notes: '应回滚' }),
          f.who,
          's',
        ),
      /变化/,
    );
    assert.equal(must(f.store.order(row.id, true), '订单').notes, '归档后修正');
  } finally {
    f.store.close();
  }
});

test('数据管理新建模板不预填数量、单价和交货日期：漏填时提示请填写，不按 1 只、0 元、今天保存', () => {
  const f = basics();
  try {
    const t = f.service.list('orders', f.who).template;
    assert.deepEqual([t.deliveryDate, t.lines[0].quantity, t.lines[0].unitPriceCents], [null, null, null]);
    const count = f.store.orders(true).length;
    const line = { ...t.lines[0], productId: f.product.id, productName: f.product.name };
    assert.throws(
      () =>
        f.service.execute(command('orders', 'create', [], { ...t, customerId: f.customer.id, deliveryDate: '2026-12-31', lines: [line] }), f.who, 's'),
      (e: unknown) => e instanceof Error && /请填写有效数量/.test(e.message) && /请填写单价/.test(e.message),
    );
    assert.throws(
      () =>
        f.service.execute(command('orders', 'create', [], { ...t, customerId: f.customer.id, lines: [{ ...line, quantity: 5, unitPriceCents: 100 }] }), f.who, 's'),
      /请填写明确日期/,
    );
    assert.equal(f.store.orders(true).length, count, '一张也没建出来');
    // 采购、到货、生产、送货的数量同样留空；报废、退料没有就是 0
    const template = <M extends 'purchases' | 'arrival' | 'task' | 'production' | 'delivery'>(m: M) => f.service.list(m, f.who).template;
    assert.equal(template('purchases').lines[0].quantity, null);
    assert.equal(template('arrival').lines[0].quantity, null);
    assert.equal(template('task').quantity, null);
    assert.deepEqual(
      [template('production').goodQuantity, template('production').materials[0].issued, template('production').scrapQuantity, template('production').materials[0].returned],
      [null, null, '0', '0'],
    );
    assert.equal(template('delivery').lines[0].quantity, null);
    // 生产任务漏填数量：拒收，不按 1 只建
    const tasks = new FlowService(f.store).list('task', true).length;
    for (const quantity of [null, ''])
      assert.throws(
        () => f.service.execute(command('task', 'create', [], { ...template('task'), productId: f.product.id, quantity }), f.who, 's'),
        /请填写数量/,
      );
    assert.equal(new FlowService(f.store).list('task', true).length, tasks);
  } finally {
    f.store.close();
  }
});
test('数据管理改库存品：原材料单位只有张，本机管理员也改不了别的单位；数据管理命令里没有出入库（走库存页同一个窗口）', () => {
  const f = basics(),
    ops = new OperationsService(f.store);
  try {
    const item = ops.saveItem({ name: '虚构原料', kind: 'raw', unit: '张' }, f.who);
    assert.throws(() => f.service.execute(command('stock_items', 'update', [item], { unit: '平方米' }), f.who, 's'), /只有“张”/);
    assert.throws(
      () => f.service.execute(command('stock_items', 'move', [item], { action: 'adjust', quantity: '1', date: '2026-10-27', notes: '虚构' }), f.who, 's'),
      (e: unknown) => e instanceof ZodError && e.issues.some((i) => i.path.join('.') === 'action'),
    );
    assert.equal(ops.movements().length, 0);
  } finally {
    f.store.close();
  }
});

/** 登记一笔盘点（和库存页“出入库 / 盘点”同一个服务） */
const adjust = (flow: FlowService, item: { id: number; version: number }, who: Actor) =>
  flow.stock.move(item.id, { action: 'adjust', quantity: '5', date: '2026-11-13', notes: '虚构', acknowledged: true, requestId: randomUUID(), expectedVersion: item.version }, who);

test('数据管理里的库存品：读的时候带上用没用过（只补显示用的 record），用过的改种类、改关联产品在编辑窗里是只读的', () => {
  const f = basics();
  try {
    const ops = new OperationsService(f.store);
    const unused = ops.saveItem({ name: '虚构没用过的纸板', kind: 'raw', unit: '张' }, actor);
    const moved = ops.saveItem({ name: '虚构用过的纸板', kind: 'raw', unit: '张' }, actor);
    adjust(new FlowService(f.store), moved, f.who);
    const rows = f.service.list('stock_items', f.who).records;
    const row = (id: number) => must(rows.find((r) => r.record.id === id), '库存品 ' + id);
    assert.equal(row(unused.id).record.usage, null);
    assert.equal(row(moved.id).record.usage, 'moved');
    assert.equal('usage' in row(moved.id).input, false, '编辑内容不带它');
    // 服务端确实拒绝改用过的库存品的种类（编辑窗做成只读就是按这个来的）
    assert.throws(
      () =>
        f.service.execute(
          command('stock_items', 'update', [row(moved.id).record], { ...row(moved.id).input, kind: 'finished', unit: '只', productId: f.product.id }),
          f.who,
          's',
        ),
      /不能改种类/,
    );
  } finally {
    f.store.close();
  }
});
test('库存品用没用过：数据管理列表、单据流转的 usage（StockViews）和“被单据关联”（flow_refs.stock_id）是同一个判断，批量版一次查齐', () => {
  const f = basics();
  try {
    const ops = new OperationsService(f.store),
      flow = new FlowService(f.store);
    const supplier = ops.saveSupplier({ name: '虚构用量供应商' }, actor);
    const raw = (name: string) => ops.saveItem({ name, kind: 'raw', unit: '张' }, actor);
    const unused = raw('虚构没用过'),
      moved = raw('虚构有流水也被引用'),
      purchased = raw('虚构被采购引用'),
      referenced = raw('虚构被单据引用'),
      finished = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: f.product.id }, actor);
    adjust(flow, moved, f.who);
    ops.savePurchase(
      {
        supplierId: supplier.id,
        orderDate: '2026-11-01',
        status: '已订货',
        lines: [{ stockItemId: purchased.id, name: purchased.name, unit: '张', quantity: '100', unitPrice: '1', priceBasis: 'quantity' }],
      },
      actor,
    );
    // 待入库的到货单引用两个库存品（只进 flow_refs，不记流水）
    flow.save(
      'arrival',
      {
        date: '2026-11-07',
        supplierId: supplier.id,
        reference: '虚构用量到货',
        lines: [referenced, moved].map((i) => ({ stockId: i.id, item: { name: i.name, unit: '张' }, quantity: '10', unitPrice: '1', priceBasis: 'quantity' })),
      },
      actor,
    );
    const ids = [unused, moved, purchased, referenced, finished].map((i) => i.id);
    assert.deepEqual(
      ids.map((id) => flow.views.usage(id)),
      [null, 'moved', 'referenced', 'referenced', null],
      '有流水优先算 moved；只被采购明细或单据引用算 referenced',
    );
    assert.deepEqual(
      ids.map((id) => !!f.store.db.prepare('SELECT 1 FROM flow_refs WHERE stock_id=? LIMIT 1').get(id)),
      [false, true, false, true, false],
      '被单据引用就是 flow_refs.stock_id 有它',
    );
    // 批量版一次查齐（采购库存自己的流水、采购明细一条语句，单据流转的引用一条语句），结论和单条一致；没用过的不在结果里
    const db = f.store.db,
      prepare = db.prepare.bind(db);
    let statements = 0;
    db.prepare = (sql: string) => {
      statements++;
      return prepare(sql);
    };
    const batch = flow.views.usages([...ids, ids[1], 999999]);
    db.prepare = prepare;
    assert.equal(statements, 2, '不逐条查');
    for (const id of [...ids, 999999]) assert.equal(batch.get(id) ?? null, flow.views.usage(id), '库存品 ' + id);
    assert.deepEqual([...batch.keys()].sort((a, b) => a - b), [moved.id, purchased.id, referenced.id].sort((a, b) => a - b));
    assert.equal(flow.views.usages([]).size, 0);
    // 数据管理列表给编辑窗的 usage 用的就是它，结论一样
    const listed = new Map(f.service.list('stock_items', f.who).records.map((r) => [r.record.id, r.record.usage]));
    for (const id of ids) assert.equal(listed.get(id), flow.views.usage(id), '数据管理列表里库存品 ' + id);
  } finally {
    f.store.close();
  }
});

test('数据管理列表的状态列按界面叫法：单据不显示 draft、confirmed、cancelled、reversed', () => {
  const doc = (kind: string, status: string, extra = {}) => recordStatus(kind, { kind, status, ...extra });
  assert.equal(doc('delivery', 'draft'), '待送货');
  assert.equal(doc('arrival', 'draft'), '待入库');
  assert.equal(doc('production', 'draft'), '待入库');
  assert.equal(doc('arrival', 'confirmed'), '已入库');
  assert.equal(doc('production', 'confirmed'), '已入库');
  assert.equal(doc('delivery', 'confirmed'), '送货中');
  assert.equal(doc('task', 'confirmed', { quantity: '100', completed: '0' }), '待生产');
  assert.equal(doc('arrival', 'cancelled'), '已取消');
  assert.equal(doc('arrival', 'reversed'), '已撤销');
  assert.equal(doc('arrival', 'reversed', { replacedBy: 9 }), '已更正');
  assert.equal(recordStatus('purchases', { status: '全部到货', businessStatus: '已订货' }), '已到齐');
  assert.equal(recordStatus('purchases', { status: '已订货', businessStatus: '已订货' }), '待到货');
  assert.equal(recordStatus('orders', { status: '待发货', shippingProgress: '部分发货' }), '部分发货');
  assert.equal(recordStatus('customers', {}), '正常');
  for (const kind of ['arrival', 'task', 'production', 'delivery'])
    for (const status of ['draft', 'confirmed', 'cancelled', 'reversed'])
      assert.doesNotMatch(doc(kind, status), /[A-Za-z]|草稿/, kind + ' ' + status);
});

test('数据管理列表：待入库、已取消的到货单也显示供应商名（读的时候批量补，单据内容不改）', () => {
  const f = basics();
  try {
    const ops = new OperationsService(f.store),
      flow = new FlowService(f.store);
    const supplier = ops.saveSupplier({ name: '虚构列表供应商' }, actor);
    const raw = ops.saveItem({ name: '虚构列表纸板', kind: 'raw', unit: '张' }, actor);
    const arrival = (reference: string) =>
      flow.save(
        'arrival',
        { date: '2026-11-13', supplierId: supplier.id, reference, lines: [{ stockId: raw.id, item: raw, quantity: '10', unitPrice: '1', priceBasis: 'quantity', differenceReason: '虚构' }] },
        actor,
      );
    const pending = arrival('FICT-LIST-1'),
      cancelled = arrival('FICT-LIST-2');
    flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构取消', acknowledged: true }, f.who);
    const storedDoc = z.looseObject({ supplierName: z.string().optional() });
    const stored = (id: number) =>
      storedDoc.parse(JSON.parse(must(one(f.store.db, rows.flow_documents.pick({ document: true }), 'SELECT document FROM flow_documents WHERE id=?', id), '单据 ' + id).document));
    assert.equal(stored(pending.id).supplierName, undefined, '待入库的到货单库里还没记供应商名');
    const listed = f.service.list('arrival', f.who).records;
    for (const id of [pending.id, cancelled.id]) {
      const row = must(listed.find((r) => r.record.id === id), '到货单 ' + id);
      assert.equal(row.record.supplierName, '虚构列表供应商');
      assert.equal('supplierName' in row.input, false, '只补显示用的名字，编辑内容不带它');
    }
    assert.equal(stored(pending.id).supplierName, undefined, '库里不改');
  } finally {
    f.store.close();
  }
});

test('数据管理读记录直接调用：列表每条给显示用的 record 和编辑窗用的 input，选中的几条按编号读（含归档的）', async () => {
  const { ManagedRecords } = await import('../server/admin/managed-records.js');
  const f = basics();
  try {
    const reader = new ManagedRecords(f.store, new FlowService(f.store));
    const listed = reader.list('customers');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].record.name, '虚构开发客户');
    assert.equal(listed[0].input.name, '虚构开发客户');
    const picked = reader.selected('orders', [f.order.id]);
    const pickedOrder = must(picked.get(f.order.id), '选中订单');
    assert.equal(pickedOrder.record.id, f.order.id);
    assert.equal(pickedOrder.input.lines.length, 1);
  } finally {
    f.store.close();
  }
});

test('数据管理不能新建完工单：登记完工只有“登记完工”一个入口；已有的完工单照样能改', () => {
  const f = basics();
  try {
    const ops = new OperationsService(f.store);
    const raw = ops.saveItem({ name: '虚构开发纸板', kind: 'raw', unit: '张' }, f.who);
    assert.throws(
      () =>
        f.service.execute(
          command('production', 'create', [], { date: '2026-10-27', productId: f.product.id, goodQuantity: '1', operator: '虚构', materials: [{ stockId: raw.id, issued: '1' }] }),
          f.who,
          's',
        ),
      (e: unknown) => e instanceof AppError && e.status === 409 && /登记完工请到生产页用“登记完工”/.test(e.message),
    );
    assert.equal(count(f.store.db, "SELECT COUNT(*) FROM flow_documents WHERE kind='production'"), 0);
  } finally {
    f.store.close();
  }
});
