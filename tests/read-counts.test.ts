// 读取只读用到的记录：查询走索引、按编号读、语句条数不随数据量增长。只看语句和查询计划，不比快慢。
import { pageActor } from './actor-fixture.js';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/core/db.js';
import { count } from '../server/core/index.js';
import type { RecordIds } from '../server/operations/record-scope.js';
import type { StockItemView } from '../shared/business/index.js';
import { OperationsService } from '../server/operations/service.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { FlowService } from '../server/flow/service.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { quantityUnits } from '../shared/core/quantity.js';
import type { Actor } from '../server/core/auth.js';
import { saveDoc } from './receive-fixture.js';
import { stackActor as editorActor, stackFixture } from './stack-fixture.js';
import { DataManagementService } from '../server/admin/data-management-service.js';
import { ManualProductionCompletion } from '../server/flow/production-completion.js';
import { ProductionCompletion } from '../server/flow/batch-completion.js';
import { buildToday } from '../server/business/workbench.js';
import { orderDashboard } from '../server/business/record-lists.js';
import { changeLifecycle } from '../server/business/lifecycle.js';

const actor: Actor = pageActor({ id: 'perf-operator', name: '虚构测试操作员', permissions: ['business:edit'] });

const superActor = (): Actor => ({
  ...actor,
  role: 'super_admin',
  superAdminMode: true,
  superAdminUntil: Date.now() + 600000,
});

const owner = () => localAdministratorActor(superActor());

/** 运行 run 时发出的 SQL 语句和 run 的结果 */
function sqlOf<T>(store: Store, run: () => T) {
  const seen: string[] = [],
    prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql: string) => {
    seen.push(sql);
    return prepare(sql);
  };
  try {
    return { seen, result: run() };
  } finally {
    store.db.prepare = prepare;
  }
}
/** 一句的查询计划（参数都填 fill，不执行） */
const planOf = (store: Store, sql: string, fill: string | number = 1) =>
  store.db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(...Array<string | number>((sql.match(/\?/g) || []).length).fill(fill))
    .map((r) => String(r.detail))
    .join(' | ');
/** 测试数据里一定有的记录：没有就让测试失败 */
function required<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error('测试数据：没有' + what);
  return value;
}

test('读取用的索引新库就有，重新打开不变，查询走索引', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-perf-index-'));
  try {
    const file = join(dir, 'erp.sqlite');
    const names = (store: Store) => store.db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('stock_movements_date','flow_sources_hash','flow_refs_purchase') ORDER BY name").all().map((r) => r.name);
    const first = new Store(file);
    assert.deepEqual(names(first), ['flow_refs_purchase', 'flow_sources_hash', 'stock_movements_date']);
    first.close();
    const again = new Store(file);
    assert.deepEqual(names(again), ['flow_refs_purchase', 'flow_sources_hash', 'stock_movements_date']);
    assert.match(String(again.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM flow_sources WHERE hash='x'").all().map((r) => r.detail).join(' ')), /flow_sources_hash/);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('单据按镜像列查都走索引：今日页送货分三段各用各的索引、合并后按主键取，不扫全部送货单；批次的到货单按列找', () => {
  const store = new Store(':memory:');
  try {
    const flow = new FlowService(store);
    const { seen } = sqlOf(store, () => flow.list('delivery', false, '2026-10-08'));
    const plan = (sql: string) => planOf(store, sql, '2026-10-08');
    // 新库没有统计信息（没跑过 ANALYZE）时也得是这个计划
    const union = seen.find((sql) => sql.includes('UNION') && sql.includes("kind='delivery'"));
    assert.ok(union, '今日页送货是三段合并的一句');
    const delivery = plan(union);
    assert.match(delivery, /SEARCH flow_documents USING INTEGER PRIMARY KEY \(rowid=\?\)/, delivery);
    assert.match(delivery, /INDEX flow_documents_kind \(kind=\? AND status=\?\)/, '待送货的');
    assert.match(delivery, /INDEX flow_documents_kind \(kind=\? AND status=\? AND date>\?\)/, '本月已出库的');
    assert.match(delivery, /INDEX flow_documents_plan \(kind=\? AND planned_date=\?\)/, '计划在这天的');
    assert.doesNotMatch(delivery, /SCAN flow_documents|flow_documents_kind \(kind=\?\)/, '不扫全部送货单：' + delivery);
    // 订货批次详情和“批次是否已空”（server/operations/batches.ts）的写法
    assert.match(plan('SELECT id,number,date,status,document FROM flow_documents WHERE order_batch_id=? ORDER BY date,id'), /INDEX flow_documents_batch \(order_batch_id=\?\)/);
    assert.match(plan('SELECT 1 FROM flow_documents WHERE order_batch_id=? LIMIT 1'), /INDEX flow_documents_batch \(order_batch_id=\?\)/);
    // 某天的生产任务（server/flow/daily.ts）：只在生产任务里找，不扫别的单据
    assert.match(plan("SELECT id FROM flow_documents WHERE kind='task' AND (date=? OR planned_date=?)"), /INDEX flow_documents_(kind|plan)/);
  } finally {
    store.close();
  }
});

test('库存余额、期初只读覆盖索引，不回表读流水', () => {
  const store = new Store(':memory:');
  try {
    const ops = new OperationsService(store),
      item = ops.saveItem({ name: '虚构覆盖索引纸板', kind: 'raw', unit: '张' }, actor);
    ops.move(
      item.id,
      { action: 'in', quantity: '10', date: '2026-10-01', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: item.version },
      actor,
    );
    // 记下库存列表和单个余额实际发出的流水汇总语句，再看它们的查询计划
    const { seen } = sqlOf(store, () => {
      assert.equal(ops.repo.items(true)[0].id, item.id);
      assert.equal(ops.repo.balance(item.id), 10000);
    });
    const sums = seen.filter((sql) => /SUM\(delta_units\)/i.test(sql) && sql.includes('FROM stock_movements'));
    assert.equal(sums.length, 2, '全部余额、单个余额各一句');
    const plan = (sql: string) => planOf(store, sql, item.id);
    for (const sql of sums) assert.match(plan(sql), /USING COVERING INDEX stock_movements_item/, sql);
    // 成本计算取期初结存的写法（server/finance/costing.ts）：某个库存品某天以前的变动合计
    assert.match(
      plan('SELECT sum(x.delta_units) FROM stock_movements x WHERE x.item_id=? AND x.date<?'),
      /USING COVERING INDEX stock_movements_item \(item_id=\? AND date<\?\)/,
    );
  } finally {
    store.close();
  }
});

test('数据管理改一条记录只按编号读选中的那条；本机管理员改订单只读挂着这张订单的送货单和生产任务，不组装全部记录', () => {
  const f = stackFixture(),
    who = owner(),
    service = new DataManagementService(f.store);
  try {
    const target = f.order([f.line(f.pa)]),
      others = [f.order([f.line(f.pa)]), f.order([f.line(f.pb)])];
    for (const o of [target, ...others]) {
      saveDoc(f.flow, 'task', { date: '2026-10-02', productId: o.lines[0].productId, quantity: '100', unit: '只', orderIds: [o.id] }, editorActor);
      if (o.lines[0].productId === f.pa.id)
        saveDoc(f.flow, 'delivery', { date: '2026-10-06', customerId: f.customer.id, lines: [{ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.fa.id, quantity: '10' }] }, editorActor);
    }
    const record = (run: () => void) => sqlOf(f.store, run).seen;
    const command = (module: string, row: { id: number; version: number }, patch: Record<string, unknown>) => ({
      requestId: randomUUID(),
      module,
      action: 'update',
      items: [{ id: row.id, version: row.version }],
      patch,
      reason: '虚构维护',
    });
    // 整张订单列表、整类单据列表的读法（不带编号范围）
    const wholeOrders = (sql: string) => /FROM orders ORDER BY/.test(sql),
      wholeFlow = (sql: string) => /^SELECT \* FROM flow_documents( WHERE kind=\?)? ORDER BY/.test(sql),
      wholeProducts = (sql: string) => /FROM products ORDER BY/.test(sql);
    // 挂着它的任务安排时已下达，订单的生产状态变过（版本号加一），按现在的版本改
    const order = required(f.store.order(target.id, true), '订单');
    let seen = record(() => service.execute(command('orders', order, { notes: '虚构改备注' }), who, 's'));
    assert.equal(f.store.order(target.id)?.notes, '虚构改备注');
    assert.deepEqual(seen.filter(wholeOrders), [], '不组装全部订单');
    assert.deepEqual(seen.filter(wholeFlow), [], '不读全部送货单、生产任务');
    assert.ok(seen.some((sql) => sql.includes('flow_refs WHERE order_id=?')), '按单据关联圈出这张订单的单据');
    const product = required(f.store.product(f.pa.id), '产品');
    seen = record(() => service.execute(command('products', product, { name: '虚构箱A改名' }), who, 's'));
    assert.equal(f.store.product(f.pa.id)?.name, '虚构箱A改名');
    assert.deepEqual(seen.filter(wholeProducts), [], '不组装全部产品');
    const task = required(f.flow.list('task').find((t) => t.orderIds.includes(target.id)), '生产任务');
    seen = record(() => service.execute(command('task', task, { notes: '虚构任务备注' }), who, 's'));
    assert.equal(f.flow.get(task.id).notes, '虚构任务备注');
    assert.deepEqual(seen.filter(wholeFlow), [], '不组装全部生产任务');
  } finally {
    f.store.close();
  }
});

test('读一张订单、读全部订单：语句条数不随订单量增长，读一张不扫送货单、单据关联、订单明细整张表', () => {
  const counts = [30, 300].map((n) => {
    const f = stackFixture(),
      db = f.store.db;
    const insertOrder = db.prepare("INSERT INTO orders(id,number,customer_id,customer_name,order_date,delivery_date,status,notes,total_cents,created_at,updated_at) VALUES(?,?,?,?,'2026-10-01','2026-10-30','已确认','',0,'t','t')"),
      insertLine = db.prepare("INSERT INTO order_lines(order_id,product_id,product_name,specification,quantity,unit_price_e4) VALUES(?,?,'虚构','',100,10000)"),
      insertFlow = db.prepare("INSERT INTO flow_documents(kind,number,date,planned_date,status,document,actor_id,actor_name,created_at,updated_at) VALUES('delivery',?,'2026-10-06','2026-10-06','confirmed',?,'t','t','t','t')"),
      insertRef = db.prepare('INSERT INTO flow_refs(document_id,order_id,order_line_id,stock_id) VALUES(?,?,?,?)');
    try {
      db.exec('BEGIN');
      for (let i = 1; i <= n; i++) {
        insertOrder.run(i, 'B-' + i, f.customer.id, '虚构客户');
        const line = Number(insertLine.run(i, f.pa.id).lastInsertRowid);
        if (i % 2 === 0) continue;
        const document = JSON.stringify({ date: '2026-10-06', plannedDate: '2026-10-06', customerId: f.customer.id, lines: [{ orderId: i, orderLineId: line, stockId: f.fa.id, quantity: '1' }] });
        insertRef.run(Number(insertFlow.run('SH-' + i, document).lastInsertRowid), i, line, f.fa.id);
      }
      db.exec('COMMIT');
      const one = sqlOf(f.store, () => assert.equal(f.store.order(1)?.lines[0].shippedQuantity, 1)).seen;
      for (const sql of one) assert.doesNotMatch(planOf(f.store, sql), /SCAN (flow_documents|flow_refs|order_lines)\b/, sql);
      const all = sqlOf(f.store, () => assert.equal(f.store.orders().length, n)).seen;
      assert.deepEqual(f.store.ordersByIds([1, n], true).map((o) => o.id).sort((a, b) => a - b), [1, n]);
      return [one.length, all.length];
    } finally {
      f.store.close();
    }
  });
  assert.deepEqual(counts[0], counts[1], '30 张和 300 张订单发出的语句一样多：' + JSON.stringify(counts));
});

// —— 批量完工、完工预览摘要：只读用到的记录 ——
// import 写在这里是为了只往文件末尾追加；ES 模块的 import 不论写在哪都先加载。

/** 一次被记下的读取：哪个函数、按编号读的那个参数、读回的编号 */
type WatchedRead = { name: string; byIds: RecordIds; ids: number[] };
/** 记下的调用里由 from 直接发起的那些；idsArg 取出按编号读的那个参数 */
function directCalls<A extends readonly unknown[]>(
  from: RegExp,
  name: string,
  calls: readonly { arguments: A; result?: readonly { id: number }[]; stack: Error }[],
  idsArg: (args: A) => RecordIds,
): WatchedRead[] {
  // 第 0 行是 Error，第 1 行是 mock 的转手，第 2 行是直接调用方
  return calls
    .filter((c) => from.test(String(c.stack.stack).split('\n')[2] || ''))
    .map((c) => ({ name, byIds: idsArg(c.arguments), ids: (c.result ?? []).map((r) => r.id) }));
}

/** 记下由 from 直接发起的 list、items、purchases 调用；reset 清空记下的，restore 复原。 */
function watchReads(from: RegExp) {
  const spies = {
    list: mock.method(FlowService.prototype, 'list'),
    items: mock.method(OperationsRepository.prototype, 'items'),
    purchases: mock.method(OperationsRepository.prototype, 'purchases'),
  };
  return {
    calls: () => [
      ...directCalls(from, 'list', spies.list.mock.calls, (a) => a[3]),
      ...directCalls(from, 'items', spies.items.mock.calls, (a) => a[1]),
      ...directCalls(from, 'purchases', spies.purchases.mock.calls, (a) => a[1]),
    ],
    reset() {
      for (const spy of Object.values(spies)) spy.mock.resetCalls();
    },
    restore() {
      for (const spy of Object.values(spies)) spy.mock.restore();
    },
  };
}

/** 完工用的虚构数据：一张订单的产品、关联采购单上的纸板，另有无关的订单、纸板、采购单。 */
function completionWorld() {
  const store = new Store(':memory:'), ops = new OperationsService(store), flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构完工客户' }));
  const product = store.saveProduct(productSchema.parse({ name: '虚构完工纸箱' })),
    other = store.saveProduct(productSchema.parse({ name: '虚构无关纸箱' }));
  const order = (p: { id: number }) =>
    store.saveOrder(orderSchema.parse({ customerId: customer.id, orderDate: '2026-10-01', deliveryDate: '2026-10-30', status: '已确认', lines: [{ productId: p.id, quantity: 100, unitPriceCents: 100 }] }));
  const supplier = ops.saveSupplier({ name: '虚构完工供应商' }, actor);
  const board = (name: string) => {
    const item = ops.saveItem({ name, kind: 'raw', unit: '张' }, actor);
    ops.move(item.id, { expectedVersion: item.version, requestId: randomUUID(), action: 'in', quantity: '100', date: '2026-10-01', notes: '虚构期初', acknowledged: true }, actor);
    return item;
  };
  const buy = (item: StockItemView, customerOrderId: number | null) =>
    ops.savePurchase({ supplierId: supplier.id, customerOrderId, orderDate: '2026-10-01', status: '待订货', lines: [{ ...item, stockItemId: item.id, quantity: '10', unitPrice: '1.2345', priceBasis: 'quantity' }] }, actor);
  const task = (p: { id: number }, o: { id: number }, quantity: string) =>
    saveDoc(flow, 'task', { productId: p.id, quantity, unit: '只', date: '2026-10-02', plannedDate: '2026-10-02', orderIds: [o.id] }, actor);
  const mine = order(product), shared = board('虚构关联纸板');
  buy(shared, mine.id);
  return { store, ops, flow, product, other, order, board, buy, task, mine, shared };
}

test('批量完工只按编号读用到的生产任务、采购单和库存品，循环里不再重读；同产品前面新建的成品档案后面的任务照样用上', () => {
  const w = completionWorld(), { store, ops, flow } = w;
  // 读在完工方案里（completion-plan.ts，batch-completion.ts 调它）
  const watch = watchReads(/batch-completion\.ts|completion-plan\.ts/);
  try {
    const others = w.order(w.other), idle = w.order(w.other);
    const otherBoard = w.board('虚构别单纸板'), otherPurchase = w.buy(otherBoard, others.id);
    // 和这批任务都无关的纸板、采购单（挂在没有生产任务的订单上）
    const noise = Array.from({ length: 12 }, (_, i) => w.board('虚构无关纸板' + i)),
      noisePurchases = noise.map((item) => w.buy(item, idle.id));
    const otherFinished = ops.saveItem({ name: '虚构无关成品', kind: 'finished', unit: '只', productId: w.other.id }, actor);
    const first = w.task(w.product, w.mine, '3'), second = w.task(w.product, w.mine, '2');
    const unrelated = [w.task(w.other, others, '2'), w.task(w.other, others, '2')];
    const run = (input: Record<string, unknown>) =>
      new ProductionCompletion(store).execute({ requestId: randomUUID(), date: '2026-10-03', operator: '虚构生产人员', allocation: 'shared-proportional', ...input }, actor);
    const noiseItems = new Set([...noise.map((i) => i.id), otherFinished.id]),
      noisePurchaseIds = new Set(noisePurchases.map((p) => p.id));
    const checkReads = (label: string, unexpectedTasks: number[], unexpectedItems: Set<number>, unexpectedPurchases: Set<number>) => {
      const calls = watch.calls();
      for (const c of calls) assert.ok(Array.isArray(c.byIds), label + '：' + c.name + ' 要按编号读');
      // 库存品、采购单各读一次，循环里不再读
      assert.deepEqual(calls.map((c) => c.name).sort(), ['items', 'list', 'purchases'], label);
      const read = (name: string) => calls.filter((c) => c.name === name).flatMap((c) => c.ids);
      assert.deepEqual(read('list').filter((id) => unexpectedTasks.includes(id)), [], label + '：读到了无关的生产任务');
      assert.deepEqual(read('items').filter((id) => unexpectedItems.has(id)), [], label + '：读到了无关的库存品');
      assert.deepEqual(read('purchases').filter((id) => unexpectedPurchases.has(id)), [], label + '：读到了无关的采购单');
    };

    // 指定任务：顺序按指定的；原料不指定也能从关联采购单唯一匹配；这个产品原来没有成品档案，第一个任务新建、第二个任务用同一个
    const result = run({ taskIds: [second.id, first.id], materials: [{ unit: '张', issued: '5', returned: '0' }] });
    assert.deepEqual(result.results.map((r) => r.taskId), [second.id, first.id]);
    assert.deepEqual(result.materials.map((m) => m.stockId), [w.shared.id]);
    assert.equal(new Set(result.results.map((r) => r.finishedStockId)).size, 1);
    assert.equal(count(store.db, "SELECT COUNT(*) FROM stock_items WHERE kind='finished' AND product_id=?", w.product.id), 1);
    assert.equal(result.count, 5, '一个成品档案、两张完工各登记和确认（任务安排时已下达）');
    checkReads('指定任务', unrelated.map((t) => t.id), new Set([...noiseItems, otherBoard.id]), new Set([...noisePurchaseIds, otherPurchase.id]));

    // 全部待完工：SQL 先按状态筛，取消的任务、完工单不读；顺序和全量列表筛出来的一样
    watch.reset();
    const third = w.task(w.product, w.mine, '2'), dropped = w.task(w.product, w.mine, '2');
    flow.cancel(dropped.id, { version: dropped.version, reason: '虚构取消', acknowledged: true }, actor);
    const expected = flow.list('task').filter((t) => ['draft', 'confirmed'].includes(t.status) && quantityUnits(t.completed) < quantityUnits(t.quantity)).map((t) => t.id);
    assert.deepEqual(expected.sort((a, b) => a - b), [unrelated[0].id, unrelated[1].id, third.id].sort((a, b) => a - b));
    const all = run({ allActive: true, materials: [{ stockId: w.shared.id, unit: '张', issued: '10', returned: '0' }] });
    assert.deepEqual(all.results.map((r) => r.taskId), flow.list('task').filter((t) => expected.includes(t.id)).map((t) => t.id));
    const productions = store.db.prepare("SELECT id FROM flow_documents WHERE kind='production'").all().map((r) => Number(r.id));
    // 这回别的产品的任务也在这批里，它的成品档案、别单纸板是要读的；挂在空订单上的纸板、采购单仍然不读
    checkReads('全部待完工', [dropped.id, ...productions], new Set(noise.map((i) => i.id)), noisePurchaseIds);
    const listed = required(watch.calls().find((c) => c.name === 'list'), '读生产任务的调用').byIds;
    assert.ok(typeof listed === 'object' && !listed.includes(dropped.id), '取消的任务不进编号');
  } finally {
    watch.restore();
    store.close();
  }
});

test('完工预览摘要只看这次完工会读到的记录：无关的单据、库存品、产品、订单变了不用重新预览，相关的变了照样要重新预览', () => {
  const w = completionWorld(), { store, ops, flow } = w,
    completion = new ManualProductionCompletion(store);
  try {
    const first = w.task(w.product, w.mine, '3');
    type Material = { stockId?: number; unit: string; issued: string; returned: string };
    const input = (materials: Material[] = [{ unit: '张', issued: '3', returned: '0' }]) => ({ requestId: randomUUID(), taskIds: [first.id], date: '2026-10-03', operator: '虚构生产人员', allocation: 'shared-proportional' as const, materials });
    const execute = (v: ReturnType<typeof input>, digest: string) => completion.execute({ input: v, previewDigest: digest }, actor);
    // 算摘要不再读整张表的版本号
    let v = input();
    const previewed = sqlOf(store, () => completion.preview(v, actor));
    let p = previewed.result;
    assert.deepEqual(previewed.seen.filter((sql) => /FROM (flow_documents|stock_items|products|orders) ORDER BY id/.test(sql)), []);
    // 相关：这个产品新建了成品档案（预览时要新建，执行时会用它，结果不同）
    ops.saveItem({ name: '虚构后建成品', kind: 'finished', unit: '只', productId: w.product.id }, actor);
    assert.throws(() => execute(v, p.previewDigest), /已变化/);
    // 相关：关联这张订单的采购单多了一张（原料不再唯一匹配；旧摘要不看采购单，这里也拦下）
    v = input();
    p = completion.preview(v, actor);
    w.buy(w.board('虚构后加纸板'), w.mine.id);
    assert.throws(() => execute(v, p.previewDigest), /已变化/);
    assert.throws(() => completion.preview(input(), actor), /原料未唯一匹配/);
    // 相关：生产任务改了计划日
    v = input([{ stockId: w.shared.id, unit: '张', issued: '3', returned: '0' }]);
    p = completion.preview(v, actor);
    flow.schedule(first.id, { plannedDate: '2026-11-03', expectedVersion: flow.get(first.id).version, requestId: randomUUID() }, actor);
    assert.throws(() => execute(v, p.previewDigest), /已变化/);
    // 无关：别的产品、订单、纸板、成品档案、生产任务、到货单
    v = input([{ stockId: w.shared.id, unit: '张', issued: '3', returned: '0' }]);
    p = completion.preview(v, actor);
    const others = w.order(w.other);
    store.saveProduct(productSchema.parse({ name: '虚构又一个纸箱' }));
    const loose = w.board('虚构无关纸板');
    ops.saveItem({ name: '虚构无关成品', kind: 'finished', unit: '只', productId: w.other.id }, actor);
    w.task(w.other, others, '5');
    w.buy(loose, others.id);
    const done = execute(v, p.previewDigest);
    assert.equal(done.verified, true);
    assert.equal(flow.get(first.id, 'task').completed, '3');
    assert.equal(done.results[0].goodQuantity, '3');
  } finally {
    store.close();
  }
});

// —— 今日页、经营概况算上已归档的：已归档的只按日期圈出这段时间的再按编号读 ——
test('今日页、经营概况的月度统计只读这段时间里已归档的订单和采购单，不把全部历史（连已归档的）组装一遍', () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构归档客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构归档纸箱' })),
    supplier = ops.saveSupplier({ name: '虚构归档供应商' }, actor);
  const archived = (entity: 'orders' | 'purchases', record: { id: number; version: number }) => {
    assert.ok(changeLifecycle(store, entity, { action: 'archive', items: [{ id: record.id, version: record.version }] }, actor).results[0].success);
    return record.id;
  };
  const order = (orderDate: string) =>
    store.saveOrder(orderSchema.parse({ customerId: customer.id, orderDate, deliveryDate: '2026-12-30', status: '待确认', lines: [{ productId: product.id, quantity: 10, unitPriceCents: 100 }] }));
  const purchase = (orderDate: string) =>
    ops.savePurchase({ supplierId: supplier.id, orderDate, status: '已取消', lines: [{ name: '虚构纸板', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm', quantity: '5', priceBasis: 'quantity' }] }, actor);
  archived('orders', order('2026-01-05'));
  archived('purchases', purchase('2026-01-02'));
  const recentOrder = archived('orders', order('2026-10-05')),
    recentPurchase = archived('purchases', purchase('2026-10-02'));
  const spies = {
    orders: mock.method(store, 'orders'),
    ordersByIds: mock.method(store, 'ordersByIds'),
    purchases: mock.method(OperationsRepository.prototype, 'purchases'),
  };
  try {
    buildToday(store, '2026-10-31');
    orderDashboard(store, { start: '2026-10-01', end: '2026-10-31' });
    assert.ok(spies.orders.mock.calls.every((c) => !c.arguments[0]), '整批读的订单不带已归档的');
    assert.ok(spies.purchases.mock.calls.every((c) => !c.arguments[0] || c.arguments[1] !== undefined), '带已归档的采购单只按编号读');
    // 带已归档读的（period-records.ts 发起的）只读到这段时间里的那一张
    const fromPeriod = /period-records/;
    assert.deepEqual(
      [
        ...directCalls(fromPeriod, 'orders', spies.ordersByIds.mock.calls, (a) => a[0]),
        ...directCalls(fromPeriod, 'purchases', spies.purchases.mock.calls.filter((c) => c.arguments[0]), (a) => a[1]),
      ].map((r) => [r.name, r.ids]),
      [
        ['orders', [recentOrder]],
        ['orders', [recentOrder]],
        ['purchases', [recentPurchase]],
      ],
    );
  } finally {
    for (const spy of Object.values(spies)) spy.mock.restore();
    store.close();
  }
});
