// 单据表（server/flow/document-store.ts、建表的 CHECK 和外键）：镜像列按单据内容算，库里核对列和内容一致；
// 原件表 flow_sources（server/flow/sources.ts）的种类只在列里。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { one, rows } from '../server/core/index.js';
import { insertFlowDocument, writeFlowDocument } from '../server/flow/document-store.js';
import { replaceFlowDocument } from '../server/flow/maintenance-writes.js';
import { storedDocument } from '../server/flow/read.js';
import { insertSource, updateSourceDocument } from '../server/flow/sources.js';
import { Store } from '../server/core/db.js';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk as actor } from './flow-fixture.js';
import type { FlowDocument } from '../shared/business/index.js';
import { z } from 'zod';
import { StoredDataError } from '../server/core/errors.js';
import { finishedStockOfProduct } from '../server/flow/stock-batches.js';

// 各种单据最少的完整内容（库里的单据结构，shared/business/flow-document.ts），测试里只改要看的字段
const date = '2026-10-20';
const task = (extra: Partial<FlowDocument<'task'>> = {}): FlowDocument<'task'> => ({
  kind: 'task', date, plannedDate: date, notes: '', productId: 1, quantity: '10', unit: '只', orderIds: [], ...extra,
});
const production = (extra: Partial<FlowDocument<'production'>> = {}): FlowDocument<'production'> => ({
  kind: 'production', date, notes: '', taskId: null, productId: 1, finishedStockId: null, goodQuantity: '1', scrapQuantity: '0', operator: '虚构机长', materials: [], ...extra,
});
const delivery = (extra: Partial<FlowDocument<'delivery'>> = {}): FlowDocument<'delivery'> => ({
  kind: 'delivery', date, plannedDate: date, notes: '', customerId: 1, address: '', contact: '', phone: '', allowOverdelivery: false, overdeliveryReason: '', lines: [], ...extra,
});
const arrival = (extra: Partial<FlowDocument<'arrival'>> = {}): FlowDocument<'arrival'> => ({
  kind: 'arrival', date, notes: '', supplierId: 1, reference: '虚构-1', sourceId: null, lines: [], ...extra,
});
/** 单据表从内容算出来的镜像列（计划日、送达日、订货批次、更正关系） */
const mirrorColumns = (db: DatabaseSync, id: number) =>
  one(
    db,
    rows.flow_documents.pick({ planned_date: true, delivered_at: true, order_batch_id: true, correction_of: true, replaced_by: true }),
    'SELECT planned_date,delivered_at,order_batch_id,correction_of,replaced_by FROM flow_documents WHERE id=?',
    id,
  );
/** 镜像列都空着（单据内容里没有这几项） */
const noMirrors = { planned_date: null, delivered_at: null, order_batch_id: null, correction_of: null, replaced_by: null };

test('单据表的镜像列：写入函数按单据内容算列；库里 CHECK 核对列和内容一致、哪种单据才有；外键拦住失效的批次和更正关系', () => {
  const f = flowFixture();
  try {
    const db = f.store.db,
      at = '2026-10-20T01:00:00.000Z';
    const add = (status: 'draft' | 'confirmed', document: FlowDocument) => insertFlowDocument(f.store, { date, status, document, actor, at });
    const columns = (id: number) => mirrorColumns(db, id);
    assert.equal(one(db, z.object({ strict: z.number() }), "SELECT strict FROM pragma_table_list WHERE name='flow_documents'")?.strict, 1);
    // 列的取法和 CHECK 是同一个定义：各种单据都写得进去，列的值从内容里算出来
    const taskId = add('confirmed', task({ plannedDate: '2026-10-22', correctionOf: null }));
    assert.deepEqual(columns(taskId), { ...noMirrors, planned_date: '2026-10-22' });
    const productionId = add('draft', production({ taskId, correctionOf: null }));
    assert.deepEqual(columns(productionId), noMirrors, '完工单没有计划日');
    const deliveryId = add('confirmed', delivery({ plannedDate: '2026-10-21', shippedAt: at, deliveredAt: '2026-10-23' }));
    assert.deepEqual(columns(deliveryId), { ...noMirrors, planned_date: '2026-10-21', delivered_at: '2026-10-23' });
    const planned = { ...arrival({ reference: '虚构-2' }), plannedDate: '2026-10-28' };
    assert.throws(() => add('confirmed', planned), /plannedDate/, '到货单没有计划日，写的时候按结构拦下');
    const direct = add('confirmed', arrival({ reference: '虚构-2' }));
    assert.deepEqual(columns(direct), noMirrors);
    const waiting = add('draft', arrival());
    writeFlowDocument(f.store, waiting, arrival({ notes: '改过' }), { date: '2026-10-26' });
    assert.deepEqual(columns(waiting), noMirrors);
    assert.throws(() => writeFlowDocument(f.store, waiting, delivery()), /单据内容和单据种类对不上/, '写的种类要和这张单据一样');

    const rejects = (pattern: RegExp, sql: string, ...params: (string | number)[]) =>
      assert.throws(() => db.prepare(sql).run(...params), pattern, sql);
    const mismatch = /CHECK constraint failed/;
    // 只改列、不改内容
    rejects(mismatch, 'UPDATE flow_documents SET planned_date=? WHERE id=?', '2026-11-01', taskId);
    rejects(mismatch, 'UPDATE flow_documents SET planned_date=? WHERE id=?', '2026-11-01', direct);
    rejects(mismatch, 'UPDATE flow_documents SET delivered_at=NULL WHERE id=?', deliveryId);
    rejects(mismatch, 'UPDATE flow_documents SET correction_of=? WHERE id=?', waiting, direct);
    // 只改内容、不改列
    rejects(mismatch, "UPDATE flow_documents SET document=json_set(document,'$.plannedDate','2026-11-01') WHERE id=?", taskId);
    rejects(mismatch, "UPDATE flow_documents SET document=json_set(document,'$.deliveredAt','2026-10-24') WHERE id=?", deliveryId);
    rejects(mismatch, "UPDATE flow_documents SET document=json_set(document,'$.replacedBy',?) WHERE id=?", waiting, direct);
    // 直接插入：内容里带了字段却没写列；内容不是 JSON 对象；日期不是真实日期
    const insert =
      "INSERT INTO flow_documents(kind,number,date,status,actor_id,actor_name,created_at,updated_at,document) VALUES('task',?,?,'draft','t','虚构','t','t',?)";
    rejects(mismatch, insert, '虚构-直接-1', '2026-10-20', JSON.stringify({ plannedDate: '2026-10-20' }));
    rejects(mismatch, insert, '虚构-直接-2', '2026-10-20', '不是 JSON');
    rejects(mismatch, insert, '虚构-直接-3', '2026-10-20', '[]');
    rejects(mismatch, insert, '虚构-直接-4', '2026-02-30', '{}');
    // 哪种单据才有（列和内容一起改，过得了一致性那一条，过不了这一条）
    rejects(
      /delivered_at IS NULL OR kind='delivery'/,
      "UPDATE flow_documents SET delivered_at='2026-10-24',document=json_set(document,'$.deliveredAt','2026-10-24') WHERE id=?",
      direct,
    );
    // 有替代单的原单一定是已撤销：状态还是已确认就不许挂 replaced_by
    rejects(
      /replaced_by IS NULL OR status='reversed'/,
      "UPDATE flow_documents SET replaced_by=?,document=json_set(document,'$.replacedBy',?) WHERE id=?",
      waiting,
      waiting,
      direct,
    );
    // 订货批次：只有到货单能挂；不存在的批次挂不上；被到货单引用着的批次删不掉
    const batch = Number(
      db
        .prepare("INSERT INTO order_batches(number,supplier_id,order_date,actor_id,actor_name,created_at,updated_at) VALUES('虚构批次-1',?,'2026-10-01','t','虚构','t','t')")
        .run(f.supplier.id).lastInsertRowid,
    );
    const setBatch = "UPDATE flow_documents SET order_batch_id=?,document=json_set(document,'$.orderBatchId',?) WHERE id=?";
    rejects(/order_batch_id IS NULL OR kind='arrival'/, setBatch, batch, batch, deliveryId);
    rejects(/FOREIGN KEY constraint failed/, setBatch, batch + 999, batch + 999, direct);
    db.prepare(setBatch).run(batch, batch, direct);
    assert.equal(columns(direct)?.order_batch_id, batch);
    rejects(/FOREIGN KEY constraint failed/, 'DELETE FROM order_batches WHERE id=?', batch);
    // 更正关系：替代单引用着原单、原单指向替代单，两边都删不掉；不存在的原单引用不上
    const original = add('confirmed', arrival({ reference: '虚构-3' }));
    const replacement = add('confirmed', arrival({ reference: '虚构-3', correctionOf: original }));
    const reversal = { reason: '虚构', by: '虚构', at, movements: [] };
    writeFlowDocument(f.store, original, arrival({ reference: '虚构-3', replacedBy: replacement, reversal }), { status: 'reversed' });
    assert.deepEqual(columns(replacement), { ...noMirrors, correction_of: original });
    assert.deepEqual(columns(original), { ...noMirrors, replaced_by: replacement });
    rejects(/FOREIGN KEY constraint failed/, 'DELETE FROM flow_documents WHERE id=?', original);
    rejects(/FOREIGN KEY constraint failed/, 'DELETE FROM flow_documents WHERE id=?', replacement);
    assert.throws(
      () => add('confirmed', arrival({ reference: '虚构-4', correctionOf: 999999 })),
      /FOREIGN KEY constraint failed/,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('库里的单据内容只存单据自己的字段：到货和送货确认、取消、撤销以后都不带视图里行上的列和派生字段（种类、单号、状态、版本、完工进度……）', () => {
  const f = flowFixture();
  try {
    const stored = (id: number) =>
      Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(String(f.store.db.prepare('SELECT document FROM flow_documents WHERE id=?').get(id)?.document))));
    const viewOnly = ['id', 'kind', 'number', 'status', 'version', 'actorName', 'createdAt', 'updatedAt', 'archived', 'actualDate'];
    viewOnly.push('hasProduction', 'actualStartDate', 'actualCompletionDate', 'completed', 'pendingCompleted', 'progress');
    const done = f.arrive('虚构送货单-存', '10');
    f.stockIn('10');
    const order = f.order(10),
      line = { orderId: order.id, orderLineId: order.lines[0].id, stockId: finishedStockOfProduct(f.store, f.product.id), quantity: '10' };
    const shipped = f.confirm('delivery', { customerId: f.customer.id, lines: [line] });
    const task = f.task({ productId: f.product.id, quantity: '10', unit: '只', orderIds: [] });
    f.flow.cancel(task.id, { version: task.version, reason: '虚构：不做了', acknowledged: true }, actor);
    f.flow.reverse(done.id, { version: done.version, reason: '虚构：发错了', acknowledged: true }, actor);
    for (const id of [done.id, task.id, shipped.id]) assert.deepEqual(stored(id).filter((k) => viewOnly.includes(k)), [], '单据 ' + id);
  } finally {
    f.store.close();
  }
});

test('读库里的单据内容对不上结构（多了一个键）：报服务端错误（500、不是“输入不对”的 400），说明里写明是哪张单据', (t) => {
  // 读库对不上时服务端会写一条日志（server/core/sql.ts），这里是故意造的，接住不打到测试输出里；测试结束自动还原
  t.mock.method(console, 'error', () => {});
  const f = flowFixture();
  try {
    const task = f.task({ productId: f.product.id, quantity: '10', unit: '只', orderIds: [] });
    f.store.db.prepare("UPDATE flow_documents SET document=json_set(document,'$.虚构多出来的',1) WHERE id=?").run(task.id);
    const stored = (e: unknown) =>
      e instanceof StoredDataError && e.status === 500 && e.detail.includes('单据 ' + task.id + '，单号 ' + task.number + '，生产任务') && e.detail.includes('虚构多出来的');
    assert.throws(() => f.flow.get(task.id), stored, '读单张');
    assert.throws(() => f.flow.list('task'), stored, '读列表');
  } finally {
    f.store.close();
  }
});

test('写之前的核对不过（服务端拼出了多一个键的内容）：报服务端错误，不是 zod 的“输入不对”，说明里写明是哪张单据，库里没变', () => {
  const f = flowFixture();
  try {
    const task = f.task({ productId: f.product.id, quantity: '10', unit: '只', orderIds: [] }),
      before = f.store.db.prepare('SELECT document,version FROM flow_documents WHERE id=?').get(task.id);
    const wrong = { ...f.flow.get(task.id, 'task'), 虚构多出来的: 1 },
      content = { ...storedDocument(f.store, task.id, 'task'), 虚构多出来的: 1 },
      server = (which: string) => (e: unknown) => e instanceof Error && !(e instanceof z.ZodError) && e.message.includes(which) && e.message.includes('虚构多出来的');
    assert.throws(() => writeFlowDocument(f.store, task.id, content), server('单据 ' + task.id + '，单号 ' + task.number));
    assert.throws(() => insertFlowDocument(f.store, { date, status: 'confirmed', document: content, actor, at: date }), server('新建生产任务'));
    assert.throws(() => replaceFlowDocument(f.store, task.id, wrong), server('单据 ' + task.id), '本机管理员连带改单据交回视图也一样');
    assert.deepEqual(f.store.db.prepare('SELECT document,version FROM flow_documents WHERE id=?').get(task.id), before);
  } finally {
    f.store.close();
  }
});

test('原件种类只存在 kind 列里：写入剥掉 JSON 里的 kind，库拒收不合规的种类', () => {
  const store = new Store(':memory:');
  try {
    const fixtureActor = { ...actor, id: 'fixture' },
      bytes = new Uint8Array([1]);
    const id = randomUUID();
    insertSource(store, { id, kind: 'arrival', fileName: '虚构.png', hash: 'a'.repeat(64), format: 'png', bytes, document: { result: null, kind: 'arrival' }, actor: fixtureActor });
    updateSourceDocument(store, id, { result: { marks: [] }, kind: 'arrival' });
    const row = one(
      store.db,
      z.object({ kind: z.string(), jsonKind: z.string().nullable() }),
      "SELECT kind,json_type(document,'$.kind') AS jsonKind FROM flow_sources WHERE id=?",
      id,
    );
    assert.deepEqual(row, { kind: 'arrival', jsonKind: null }, '种类以列为准，整份替换 JSON 不改种类');
    const raw = (kind: string | null, document: string) =>
      store.db
        .prepare('INSERT INTO flow_sources(id,kind,file_name,hash,format,bytes,document,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), kind, '虚构.png', 'b'.repeat(64), 'png', bytes, document, 'fixture', new Date().toISOString());
    assert.throws(() => raw('arrival', JSON.stringify({ result: null, kind: 'arrival' })), /CHECK/, 'JSON 里不许再带 kind');
    assert.throws(() => raw('order', JSON.stringify({ result: null })), /CHECK/, '只认到货原件');
    assert.throws(() => raw('shipping-mark', JSON.stringify({ result: null })), /CHECK/, '唛头不识别了，不收唛头原件');
    assert.throws(() => raw(null, JSON.stringify({ result: null })), /NOT NULL/, '种类必填');
    assert.throws(() => raw('arrival', '{坏的'), /CHECK/, 'document 必须是 JSON');
  } finally {
    store.close();
  }
});
