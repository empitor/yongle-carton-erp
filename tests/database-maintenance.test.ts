// 删除引擎删记录、归档和恢复、管理员直接改已确认的单据：原表、流水、归档标记、外键都对得上。
import { trackedOrder } from '../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { count, exists, many, one, rows } from '../server/core/index.js';
import { businessList, changeLifecycle } from '../server/lifecycle/index.js';
import { orderSchema } from '../shared/core/domain.js';
import { autoConfirmAssistant } from './assistant-fixture.js';
import { FlowService } from '../server/flow/index.js';
import { flowStatusText } from '../shared/business/physical-flow.js';
import { fixture } from './maintenance-fixture.js';
import { applyCorrection, archiveDoc, previewCorrection } from './receive-fixture.js';
import { correctDocument, planCorrection } from '../server/flow/index.js';
import { field } from '../server/assistant/chat/result-fields.js';
import { must } from './read-result.js';


// 每个模块删一条（数据都铺满：到货、生产任务、完工、送货）：原表没有这一行，归档标记也没有，外键检查为空
test('删除客户、产品、供应商、订单、采购单、库存品和四类单据：原表没有这一行，不留归档标记，外键对得上', () => {
  const flowKinds = ['arrival', 'task', 'production', 'delivery'];
  for (const module of ['customers', 'products', 'suppliers', 'orders', 'purchases', 'stock_items', ...flowKinds]) {
    const f = fixture();
    try {
      const arrival = f.arrival(),
        task = f.flow.save('task', { date: '2026-10-27', productId: f.product.id, quantity: '1000', unit: '只', orderIds: [f.order.id] }, f.who),
        production = f.production(),
        delivery = f.delivery();
      const targets: Record<string, { id: number; version: number }> = {
        customers: must(businessList(f.store, 'customers', true).find((r) => r.id === f.customer.id), 'customers'),
        products: must(businessList(f.store, 'products', true).find((r) => r.id === f.product.id), 'products'),
        suppliers: must(businessList(f.store, 'suppliers', true).find((r) => r.id === f.supplier.id), 'suppliers'),
        orders: must(businessList(f.store, 'orders', true).find((r) => r.id === f.order.id), 'orders'),
        purchases: must(businessList(f.store, 'purchases', true).find((r) => r.id === f.purchase.id), 'purchases'),
        stock_items: must(f.ops.items(true).find((i) => i.id === f.finished.id), 'stock_items'),
        arrival: f.flow.get(arrival.id), task: f.flow.get(task.id), production, delivery,
      };
      const row = targets[module];
      f.del(module, row);
      const table = flowKinds.includes(module) ? 'flow_documents' : module;
      assert.equal(exists(f.store.db, 'SELECT 1 FROM ' + table + ' WHERE id=?', row.id), false, module);
      const entity = flowKinds.includes(module) ? 'flow_' + module : module;
      assert.equal(exists(f.store.db, 'SELECT 1 FROM record_lifecycle WHERE entity=? AND record_id=?', entity, row.id), false, module);
      assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), [], module);
    } finally {
      f.store.close();
    }
  }
});

test('还有库存的库存品不能归档，但能删：库存品和它的流水删掉，采购明细不再挂它', () => {
  const f = fixture();
  try {
    f.arrival();
    const current = must(f.ops.items(true).find((r) => r.id === f.raw.id), '原料库存');
    assert.equal(current.balanceUnits, 1000000);
    const archived = changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: current.id, version: current.version }] }, f.who);
    assert.equal(archived.results[0].success, false);
    f.del('stock_items', current);
    assert.equal(f.store.db.prepare('SELECT id FROM stock_items WHERE id=?').get(current.id), undefined);
    assert.equal(f.flow.views.purchases(true)[0].lines[0].stockItemId, null);
    assert.deepEqual(f.flow.list('arrival', true)[0].movements, []);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('零库存仍有未完成生产工作时不能归档，但库存档案仍可直接删除', () => {
  const f = fixture();
  try {
    const task = f.flow.save(
      'task',
      {
        date: '2026-10-27',
        productId: f.product.id,
        quantity: '1000',
        unit: '只',
        orderIds: [f.order.id],
      },
      f.who,
    ); // 安排生产即下达，没有核对这一步
    const stock = must(f.ops.items(true).find((s) => s.id === f.finished.id), '成品库存');
    const result = changeLifecycle(
      f.store,
      'stock_items',
      { action: 'archive', items: [{ id: stock.id, version: stock.version }] },
      f.who,
    );
    assert.equal(result.results[0].success, false);
    assert.match(result.results[0].message, /未完成的生产任务/);
    f.del('stock_items', stock);
    assert.equal(
      f.store.db.prepare('SELECT id FROM stock_items WHERE id=?').get(stock.id),
      undefined,
    );
    assert.ok(f.flow.get(task.id));
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('归档只保留并隐藏记录，恢复只针对归档；未完成采购归档失败但删除仍成功', () => {
  const f = fixture();
  try {
    assert.equal(
      changeLifecycle(
        f.store,
        'purchases',
        { action: 'archive', items: [f.purchase].map(({ id, version }) => ({ id, version })) },
        f.who,
      ).results[0].success,
      false,
    );
    f.del('purchases', f.purchase);
    assert.equal(new FlowService(f.store).views.purchases(true).length, 0);
    f.store.db.prepare("UPDATE orders SET status='已发货' WHERE id=?").run(f.order.id);
    const item = { id: f.order.id, version: f.order.version };
    assert.equal(
      changeLifecycle(f.store, 'orders', { action: 'archive', items: [item] }, f.who).results[0]
        .success,
      true,
    );
    assert.equal(f.store.orders().length, 0);
    assert.equal(f.store.orders(true).length, 1);
    assert.equal(
      changeLifecycle(f.store, 'orders', { action: 'restore', items: [item] }, f.who).results[0]
        .success,
      true,
    );
    assert.equal(f.store.orders().length, 1);
  } finally {
    f.store.close();
  }
});
test('已确认生产和送货可直接物理删除并明确保留/重算库存，关联引用和统计同步', () => {
  const f = fixture();
  try {
    f.arrival();
    const production = f.production(),
      delivery = f.delivery();
    assert.equal(f.ops.balance(f.finished.id), 760000);
    f.del('delivery', delivery, 'recalculate');
    assert.equal(f.flow.list('delivery', true).length, 0);
    assert.equal(f.ops.balance(f.finished.id), 860000);
    assert.equal(must(trackedOrder(f.store, f.order.id), '订单').lines[0].shippedQuantity, 0);
    f.del('production', production);
    assert.equal(f.flow.list('production', true).length, 0);
    assert.equal(f.ops.balance(f.finished.id), 860000);
    assert.ok(
      f.store.db
        .prepare("SELECT 1 FROM stock_movements WHERE source_kind='database-maintenance'")
        .get(),
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('删单据选“库存数量不动”：留下的系统维护流水，修订原因写清是出库还是入库、带正负号的数量，和流水上的数量对得上', () => {
  const f = fixture();
  try {
    f.arrival();
    const production = f.production(),
      delivery = f.delivery();
    const before = f.ops.balance(f.finished.id);
    f.del('delivery', delivery, 'preserve');
    f.del('production', production, 'preserve');
    assert.equal(f.ops.balance(f.finished.id), before, '库存数量不动');
    const revisionDoc = z.looseObject({ source_kind: z.string(), delta_units: z.number() });
    const revisionRows = many(f.store.db, rows.stock_movement_revisions.pick({ reason: true, before_document: true, after_document: true }), 'SELECT reason,before_document,after_document FROM stock_movement_revisions ORDER BY id')
      .map((r) => ({ reason: r.reason, before: revisionDoc.parse(JSON.parse(r.before_document)), after: r.after_document ? z.record(z.string(), z.unknown()).parse(JSON.parse(r.after_document)) : null }));
    const out = must(revisionRows.find((r) => r.before.source_kind === 'flow_delivery'), '送货单修订记录'),
      made = revisionRows.find((r) => r.before.source_kind === 'flow_production' && r.before.delta_units > 0);
    // 原来写“关联记录删除后保留库存”，修订表的数量列又只写大小（1000 → 1000），看不出这笔是 -1000
    assert.equal(out.before.delta_units, -100000);
    assert.equal(out.reason, '送货单删除，这笔出库 -100 只留着、库存数量不动，改成“系统维护”流水');
    assert.deepEqual(out.after, { source_kind: 'database-maintenance', source_id: null }, '改的只是来源，数量没动');
    assert.ok(made, '完工入库那笔也有修订记录');
    assert.match(made.reason, /^完工单删除，这笔入库 \+\d+ 只留着、库存数量不动，改成“系统维护”流水$/);
    for (const r of revisionRows) assert.doesNotMatch(r.reason, /关联记录删除后保留库存/);
  } finally {
    f.store.close();
  }
});
test('已入库完工 860、已发货 100：更正成 850 不用先撤销送货，按净变化扣，原单已更正、替代单接手', () => {
  const f = fixture();
  try {
    f.arrival();
    const p = f.production();
    f.delivery();
    const n = f.flow.list(undefined, true).length;
    const v = { expectedVersion: p.version, reason: '虚构：多登记了 10 只', goodQuantity: '850' };
    const saved = f.flow.get(correctDocument(f.store, p.id, { ...v, previewDigest: planCorrection(f.store, p.id, v, f.who).previewDigest, requestId: randomUUID() }, f.who).replacementId);
    assert.deepEqual([saved.status, saved.correctionOf, f.flow.get(p.id).status], ['confirmed', p.id, 'reversed']);
    assert.equal(f.flow.list(undefined, true).length, n + 1);
    assert.equal(f.ops.balance(f.finished.id), 750000);
    assert.equal(f.ops.balance(f.raw.id), 100000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
test('AI删除、归档、恢复使用不同操作，已归档记录删除后在原表与归档中均不存在', async () => {
  // 测试开了自动确认：出了卡片立刻替人点（删除照样只出卡片）
  const a = autoConfirmAssistant(),
    f = fixture(a.store),
    thread = a.manager.create(f.who);
  const chat = async (text: string, name: string, args: Record<string, unknown>) => {
    a.replies.push({ toolCalls: [{ name, args }] }, { message: '服务器实际结果已返回' });
    return a.manager.chat(
      thread.id,
      a.input(text, randomUUID()),
      f.who,
      's',
      () => {},
      () => f.who,
    );
  };
  try {
    f.store.db.prepare("UPDATE orders SET status='已发货' WHERE id=?").run(f.order.id);
    await chat('归档订单 ' + f.order.number, 'records.propose_lifecycle', {
      module: 'orders',
      id: f.order.id,
      action: 'archive',
    });
    assert.ok(f.store.order(f.order.id, true));
    assert.equal(f.store.archived('orders', f.order.id), true);
    await chat('恢复订单 ' + f.order.number, 'records.propose_lifecycle', {
      module: 'orders',
      id: f.order.id,
      action: 'restore',
    });
    assert.equal(f.store.archived('orders', f.order.id), false);
    const proposed = await chat('删除订单001', 'records.delete', {
      module: 'orders',
      id: f.order.id,
    });
    // 删除只生成方案，人在确认卡片上确认后才执行。
    assert.ok(f.store.order(f.order.id, true));
    assert.equal(proposed.messages.at(-1)?.plans?.length, 1);
    // 确认卡片提交时带上卡片上看到的范围摘要
    const card = proposed.messages.at(-1)?.plans?.[0];
    assert.ok(card);
    a.manager.execute(card.id, { acknowledged: true, deletionDigest: field(card.args, 'deletionDigest') }, f.who, 's');
    assert.equal(f.store.order(f.order.id, true), undefined);
    assert.equal(f.store.archived('orders', f.order.id), false);
    const tools = f.store.db
      .prepare(
        "SELECT json_extract(document,'$.plan.tool') AS tool FROM assistant_previews WHERE result IS NOT NULL",
      )
      .all()
      .map((r) => r.tool);
    assert.ok(tools.includes('records.delete'));
    assert.equal(tools.filter((t) => t === 'records.propose_lifecycle').length, 2);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    a.close();
  }
});
test('有到货的采购可改计划到实收以下或更换供应商，旧实收关联解除且原库存数量不伪造', () => {
  const f = fixture();
  try {
    f.arrival();
    let p = new FlowService(f.store).views.purchases(true)[0];
    p = must(f.flow.stock.savePurchase({ ...p, status: p.baseStatus, lines: p.lines.map((l) => ({ ...l, quantity: '500' })) }, f.who, p.id), '改量后采购单');
    assert.equal(p.lines[0].quantity, '500');
    assert.equal(p.lines[0].receivedQuantity, '1000');
    assert.equal(p.status, '全部到货');
    const supplier = f.ops.saveSupplier({ name: '明确更正的另一供应商' }, f.who);
    p = must(f.flow.stock.savePurchase({ ...p, status: p.baseStatus, supplierId: supplier.id }, f.who, p.id), '改供应商后采购单');
    assert.equal(p.supplierId, supplier.id);
    assert.equal(p.lines[0].receivedQuantity, '0');
    assert.equal(f.ops.balance(f.raw.id), 1000000);
    assert.equal(f.flow.list('arrival')[0].lines[0].purchaseLineId, null);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('采购明细的计划数量可以改得比已到货少，已到货、库存流水和外键不受影响', () => {
  const f = fixture();
  try {
    f.arrival();
    const db = f.store.db,
      before = db.prepare('SELECT * FROM purchase_lines').all();
    db.prepare('UPDATE purchase_lines SET quantity_units=500000 WHERE id=?').run(before[0].id);
    assert.equal(must(one(db, rows.purchase_lines.pick({ received_units: true }), 'SELECT received_units FROM purchase_lines'), '采购明细').received_units, 1000000);
    assert.equal(f.ops.balance(f.raw.id), 1000000);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(must(one(db, z.object({ foreign_keys: z.number() }), 'PRAGMA foreign_keys'), '外键开关').foreign_keys, 1);
  } finally {
    f.store.close();
  }
});

test('已归档的完工单要先恢复再更正：归档时预览就拒，恢复后更正，库存按替代单算', () => {
  const f = fixture();
  try {
    f.arrival();
    const production = f.production();
    archiveDoc(f.flow, production.id, false, f.who, production.version);
    const v = () => ({ expectedVersion: f.flow.get(production.id).version, reason: '虚构：多登记了', goodQuantity: '850' });
    assert.throws(() => planCorrection(f.store, production.id, v(), f.who), /已归档，请先恢复再更正/);
    archiveDoc(f.flow, production.id, true, f.who, f.flow.get(production.id).version);
    const input = v(),
      saved = correctDocument(f.store, production.id, { ...input, previewDigest: planCorrection(f.store, production.id, input, f.who).previewDigest, requestId: randomUUID() }, f.who);
    assert.equal(f.flow.get(saved.replacementId).status, 'confirmed');
    assert.equal(f.ops.balance(f.finished.id), 850000);
    assert.equal(f.flow.list('production').length, 2);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('删除订单时解除采购明细按行关联的这张订单（列进影响清单），之后这条采购照常到货入库', () => {
  const f = fixture();
  try {
    const other = f.store.saveOrder(
      orderSchema.parse({
        customerId: f.customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: [{ productId: f.product.id, quantity: 500, unit: '只', unitPriceCents: 100 }],
      }),
    );
    const created = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-01',
        status: '已订货',
        lines: [{ stockItemId: f.raw.id, name: f.raw.name, quantity: '300', unit: '张', customerOrderId: other.id, priceBasis: 'quantity' }],
      },
      f.who,
    );
    const purchase = f.flow.views.purchases(true, created.id)[0];
    assert.equal(purchase.lines[0].customerOrderId, other.id, '这一行给另一张订单订料');
    const order = must(f.store.order(other.id), '订单'),
      selection = { module: 'orders', items: [{ id: order.id, version: order.version }] },
      plan = f.service.preview(selection, f.who);
    const entry = must(plan.impact.find((r) => r.table === 'purchase_lines'), '采购明细影响');
    assert.equal(entry.action, 'detach');
    assert.deepEqual(entry.fields, ['customer_order_id']);
    assert.match(entry.name, new RegExp(purchase.number));
    f.service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, f.who, 's');
    const after = f.flow.views.purchases(true, purchase.id)[0];
    assert.equal(after.lines[0].customerOrderId ?? null, null, '明细上不再记着删掉的订单');
    assert.equal(
      must(one(f.store.db, rows.purchase_lines.pick({ customer_order_id: true }), 'SELECT customer_order_id FROM purchase_lines WHERE id=?', after.lines[0].id), '采购明细').customer_order_id,
      null,
      '订单外键列已置空（由通用的外键规划解除，不再靠单独的规划规则）',
    );
    assert.ok(after.version > purchase.version, '采购单版本加一');
    assert.equal(f.store.order(other.id, true), undefined);
    // 这条采购到货：以前出入库流水挂到不存在的订单上，确认时报外键错误
    const arrival = f.flow.save(
      'arrival',
      {
        date: '2026-10-27',
        supplierId: f.supplier.id,
        reference: randomUUID(),
        lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '300', purchaseLineId: after.lines[0].id }],
      },
      f.who,
    );
    const done = f.base.check(arrival, {}, f.who);
    assert.equal(done.status, 'confirmed');
    assert.equal(f.flow.views.purchases(true, purchase.id)[0].lines[0].receivedUnits, 300_000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('删除预览和删除不把唛头文件、助手附件这类大文件内容读进内存，删的时候按主键删', () => {
  const f = fixture();
  try {
    const db = f.store.db,
      big = new Uint8Array(4 * 1024 * 1024);
    // 虚构的大文件：两份唛头文件挂在产品上，一个助手附件
    for (const n of [1, 2]) {
      const sha = String(n).padStart(64, '0');
      db.prepare('INSERT INTO mark_files(sha256,content,size,mime,file_name) VALUES(?,?,?,?,?)').run(sha, big, big.length, 'application/pdf', '虚构唛头' + n + '.pdf');
      db.prepare(
        "INSERT INTO product_marks(product_id,file_sha256,page,title,source_kind,created_by,created_at,updated_at) VALUES(?,?,0,'虚构唛头','manual','x','t','t')",
      ).run(f.product.id, sha);
    }
    db.prepare("INSERT INTO assistant_threads(id,user_id,title,document,created_at,updated_at) VALUES('fictional-thread','x','虚构','{}','t','t')").run();
    db.prepare(
      "INSERT INTO assistant_attachments(id,thread_id,user_id,upload_id,name,size,mime,kind,sha256,metadata,bytes,created_at) VALUES('fictional-file','fictional-thread','x','u','虚构.pdf',?,'application/pdf','pdf',?,'{}',?,'t')",
    ).run(big.length, '3'.padStart(64, '0'), big);
    const task = f.flow.save('task', { date: '2026-10-27', productId: f.product.id, quantity: '10', unit: '只', orderIds: [] }, f.who);
    const sql: string[] = [],
      prepare = db.prepare.bind(db);
    db.prepare = (text: string) => (sql.push(text), prepare(text));
    try {
      // 删一张不相干的生产任务，和删产品（唛头和没人再用的唛头文件一起删）
      f.del('task', task);
      f.del('products', must(f.store.product(f.product.id), '产品'));
    } finally {
      db.prepare = prepare;
    }
    const heavy = sql.filter((s) =>
      /"(content|bytes)"|\*\s+FROM\s+"?(mark_files|assistant_attachments|fin_attachments|flow_sources|inbox_files)\b/i.test(s),
    );
    assert.deepEqual(heavy, [], '没有读大文件内容的查询');
    assert.equal(count(db, 'SELECT COUNT(*) FROM mark_files'), 0, '唛头文件按主键删掉了');
    assert.equal(count(db, 'SELECT COUNT(*) FROM assistant_attachments'), 1, '不相干的附件不动');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('删除有更正关系的到货单：替代单删了，原单不再指向它、显示“已撤销”；原单删了，替代单不再引用它；外键列和单据内容里的字段一起清', () => {
  for (const target of ['replacement', 'original'] as const) {
    const f = fixture();
    try {
      const original = f.arrival();
      const current = () => f.flow.views.purchases(true, f.purchase.id)[0];
      const receipt = current().receipts.find((r) => r.effective) ?? assert.fail('采购单上没有有效的到货记录');
      const input = {
        expectedVersion: receipt.version,
        reason: '虚构更正：数量录错',
        items: [{ index: 0, lineId: receipt.correctionLines[0].lineId, quantity: '600' }],
      };
      const plan = previewCorrection(f.store, receipt.id, input, f.who),
        result = applyCorrection(f.store, receipt.id, { ...input, requestId: randomUUID(), previewDigest: plan.previewDigest }, f.who);
      const replacementId = Number(String(result.replacementReceiptId).slice(5));
      // 外键列，和单据内容里同名字段的类型（null 是没有这个键，'null' 是写成了 null）
      const mirrorRow = rows.flow_documents.pick({ status: true, correction_of: true, replaced_by: true })
        .extend({ correctionOfInDocument: z.string().nullable(), replacedByInDocument: z.string().nullable() });
      const row = (id: number) => must(one(f.store.db, mirrorRow, "SELECT status,correction_of,replaced_by,json_type(document,'$.correctionOf') AS correctionOfInDocument,json_type(document,'$.replacedBy') AS replacedByInDocument FROM flow_documents WHERE id=?", id), '单据 ' + id);
      // 更正之后：原单已撤销并指向替代单，替代单引用原单，列和单据内容两边同值（原单内容里没有 correctionOf 这一项）
      assert.deepEqual(row(original.id), {
        status: 'reversed',
        correction_of: null,
        replaced_by: replacementId,
        correctionOfInDocument: null,
        replacedByInDocument: 'integer',
      });
      assert.deepEqual(row(replacementId), {
        status: 'confirmed',
        correction_of: original.id,
        replaced_by: null,
        correctionOfInDocument: 'integer',
        replacedByInDocument: null,
      });
      assert.equal(flowStatusText(f.flow.get(original.id)), '已更正');
      // 只置空列、不清单据内容（比如以后加了镜像列却忘了在删除规则里登记）：库直接拒绝，不会留下两边不一致
      assert.throws(
        () => f.store.db.prepare('UPDATE flow_documents SET replaced_by=NULL WHERE id=?').run(original.id),
        /CHECK constraint failed/,
      );
      const detached = { status: 'reversed', correction_of: null, replaced_by: null, correctionOfInDocument: null, replacedByInDocument: null };
      if (target === 'original') {
        const done = f.del('arrival', f.flow.get(original.id));
        const entry = done.impact.find((r) => r.table === 'flow_documents' && r.id === replacementId);
        assert.equal(entry?.action, 'detach');
        assert.deepEqual(entry?.fields, ['correction_of'], '影响清单按“更正的原单”显示，不另算一项单据内关联');
        assert.equal(exists(f.store.db, 'SELECT 1 FROM flow_documents WHERE id=?', original.id), false);
        // 替代单留着，仍是有效到货；不再引用被删的原单（删除规则把单据内容里的这一项写成 null）
        assert.deepEqual(row(replacementId), { ...detached, status: 'confirmed', correctionOfInDocument: 'null' });
        assert.equal(current().lines[0].receivedQuantity, '600');
      } else {
        const done = f.del('arrival', f.flow.get(replacementId));
        const entry = done.impact.find((r) => r.table === 'flow_documents' && r.id === original.id);
        assert.equal(entry?.action, 'detach');
        assert.deepEqual(entry?.fields, ['replaced_by']);
        assert.equal(exists(f.store.db, 'SELECT 1 FROM flow_documents WHERE id=?', replacementId), false);
        // 原单留着，仍是已撤销，只是不再指向被删的替代单：界面上从“已更正”变成“已撤销”
        assert.deepEqual(row(original.id), detached);
        assert.equal(flowStatusText(f.flow.get(original.id)), '已撤销');
        assert.equal(current().receipts.find((r) => r.id === receipt.id)?.replacedBy, null);
        assert.equal(current().receipts.some((r) => r.effective), false);
      }
      assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      f.store.close();
    }
  }
});
