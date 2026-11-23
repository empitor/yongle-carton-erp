// 快照登记（shared/business/flow/flow-snapshot.ts 的 keepSnapshot），纯数据、虚构值：快照字段从单据结构派生（snapshot-fixture.ts），
// 每种单据每个快照字段都要登记了引用；引用没变换回原单的，换了用新单的，送货金额按留下的单价重算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowDocumentSchema, type FlowDocument, keepSnapshot, lineMoney } from '../shared/business/index.js';
import { flowKinds, type FlowKind } from '../shared/core/index.js';
import { assertSnapshots, markedContent, snapshotFields } from './snapshot-fixture.js';

const date = '2026-11-01';
/** 每种单据最少的内容（库里的单据结构补上默认值），快照字段都还没有 */
const docs = {
  arrival: flowDocumentSchema('arrival').parse({
    date, supplierId: 1, reference: '虚构单号',
    lines: [{ stockId: 2, purchaseLineId: 3, item: { name: '虚构纸板', unit: '张' }, quantity: '10' }],
  }),
  task: flowDocumentSchema('task').parse({ date, plannedDate: date, productId: 1, quantity: '10' }),
  production: flowDocumentSchema('production').parse({
    date, productId: 1, finishedStockId: 2, goodQuantity: '10', operator: '虚构机长', materials: [{ stockId: 3, issued: '5' }],
  }),
  delivery: flowDocumentSchema('delivery').parse({
    date, plannedDate: date, customerId: 1, lines: [{ orderId: 1, orderLineId: 2, stockId: 3, quantity: '10' }],
  }),
};
/** 同一张单据填满标记值：当原单 */
const marked = <K extends FlowKind>(kind: K, doc: FlowDocument<K>): FlowDocument<K> => flowDocumentSchema(kind).parse(markedContent(doc));

test('每种单据的快照字段都登记了：引用都没变时，全部换回原单的', () => {
  for (const kind of flowKinds) assertSnapshots(keepSnapshot(marked(kind, docs[kind]), docs[kind]));
});

test('到货单换了供应商、采购明细、数量：供应商名、采购单编号和单号、面积金额用新单的', () => {
  const [line] = docs.arrival.lines;
  const after = keepSnapshot(marked('arrival', docs.arrival), {
    ...docs.arrival,
    supplierId: 9,
    supplierName: '虚构新供应商',
    lines: [{ ...line, purchaseLineId: 8, quantity: '20', purchaseId: 7, purchaseNumber: '虚构采购单', supplierName: '虚构新供应商', area: '1', amount: '2' }],
  });
  assertSnapshots(after, { doc: ['supplierName'], lines: { 0: ['area', 'amount', 'purchaseId', 'purchaseNumber', 'supplierName'] } });
  const [l] = after.lines;
  assert.deepEqual([after.supplierName, l.supplierName, l.purchaseId, l.purchaseNumber, l.area, l.amount], ['虚构新供应商', '虚构新供应商', 7, '虚构采购单', '1', '2']);
});

test('送货单只改了数量：订单明细抄来的都留着原单的，金额按新数量乘留下的单价', () => {
  const before = marked('delivery', docs.delivery),
    after = keepSnapshot(before, { ...docs.delivery, lines: [{ ...docs.delivery.lines[0], quantity: '20', unitPriceExact: '9.0000', amountExact: '180.00' }] });
  assertSnapshots(after, { lines: { 0: ['amountExact'] } });
  assert.equal(after.lines[0].amountExact, lineMoney('20', before.lines[0].unitPriceExact ?? null));
});

test('送货单换了客户、换挂到别的订单明细：客户名和这一行抄来的全用新单的，金额按新单价算', () => {
  const fresh = { productName: '虚构现在的品名', unitPriceExact: '2.0000', amountExact: '0.00', taxRate: '13', material: '虚构材质', length: 300 };
  const after = keepSnapshot(marked('delivery', docs.delivery), {
    ...docs.delivery,
    customerId: 9,
    customerName: '虚构新客户',
    lines: [{ ...docs.delivery.lines[0], orderLineId: 5, stockId: 6, ...fresh }],
  });
  assertSnapshots(after, { doc: ['customerName'], lines: { 0: snapshotFields.delivery.lines?.keys ?? [] } });
  const [l] = after.lines;
  assert.deepEqual([after.customerName, l.productName, l.unitPriceExact, l.taxRate, l.material, l.length], ['虚构新客户', '虚构现在的品名', '2.0000', '13', '虚构材质', 300]);
  assert.equal(l.amountExact, lineMoney('10', '2.0000'));
});

test('原单两行挂同一条订单明细、单价不同：新单每行按顺序对上原单还没用过的一行，这一行的快照都从它取，对不上的用新单的', () => {
  const line = (quantity: string, unitPriceExact: string, amountExact: string, productName: string) => ({
    ...docs.delivery.lines[0], quantity, unitPriceExact, amountExact, productName,
  });
  const old = { ...docs.delivery, lines: [line('10', '1.0000', '10.00', '虚构甲'), line('5', '2.0000', '10.00', '虚构乙')] };
  const after = keepSnapshot(old, { ...docs.delivery, lines: [line('10', '3.0000', '30.00', '现在'), line('6', '3.0000', '18.00', '现在'), line('5', '3.0000', '15.00', '现在')] });
  assert.deepEqual(after.lines.map((l) => [l.quantity, l.unitPriceExact, l.amountExact, l.productName]), [
    ['10', '1.0000', '10.00', '虚构甲'],
    ['6', '2.0000', lineMoney('6', '2.0000'), '虚构乙'],
    ['5', '3.0000', lineMoney('5', '3.0000'), '现在'],
  ]);
});

test('原单上没有的快照（待核对时还没抄）：用新单的', () => {
  assert.equal(keepSnapshot(docs.task, { ...docs.task, productName: '虚构现在的产品' }).productName, '虚构现在的产品');
  const [l] = keepSnapshot(docs.delivery, { ...docs.delivery, lines: [{ ...docs.delivery.lines[0], unitPriceExact: '2.0000', amountExact: '20.00' }] }).lines;
  assert.deepEqual([l.unitPriceExact, l.amountExact], ['2.0000', lineMoney('10', '2.0000')]);
});

test('到货明细的纸板资料、完工领料没有快照字段（要有的话 keepSnapshot 得先管到这一层）', () => {
  assert.deepEqual(snapshotFields.arrival.item?.keys, []);
  assert.deepEqual(snapshotFields.production.materials?.keys, []);
});

test('原单和新单种类不一样是程序写错了：当场报错', () => {
  assert.throws(() => keepSnapshot<'task' | 'production'>(docs.task, docs.production), /种类不一样/);
});
