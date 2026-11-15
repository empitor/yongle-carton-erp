// 送货明细的材质、楞型（server/flow/validate-delivery.ts 补，server/documents/delivery-form.ts 印）：出库核对时按产品补进明细存下，
// 产品没填的为空；导出送货单的“材质 / 配纸”“楞型”两列按明细印，待送货的（明细出库时才补）按产品现在的印；
// 更正送货单时原样留下的行沿用出库时的（和单价一样），新加的行按产品现在的补。内存库、虚构数据。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../server/core/auth.js';
import type { Store } from '../server/core/db.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { DocumentTemplateSettings } from '../server/documents/settings.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { storedDocument } from '../server/flow/read.js';
import { defaultTemplateColumns } from '../shared/documents/index.js';
import { orderSchema, productSchema, specification } from '../shared/core/domain.js';
import { actor } from './assistant-fixture.js';
import { localAdmin, workbenchFixture } from './flow-fixture.js';
import { shipOnDocDate } from './ship-date.js';

/**
 * 一张两行的送货单：第一行是工作台的产品（材质 K=A、楞型 BC，订单 100 只），第二行是材质楞型都没填的产品（另一张订单 50 只）；
 * 两个成品库存各入库 100 只。draft() 安排送货（待送货），ship(id) 核对出库（出库日按单据日期）。
 */
function setup(t: TestContext) {
  const f = workbenchFixture(actor);
  t.after(() => f.store.close());
  const plain = f.store.saveProduct(productSchema.parse({ name: '虚构无材质纸箱' }));
  const second = f.store.saveOrder(
    orderSchema.parse({
      customerId: f.customer.id,
      orderDate: f.order.orderDate,
      deliveryDate: f.order.deliveryDate,
      status: '已确认',
      lines: [{ productId: plain.id, quantity: 50, unit: '只', unitPriceCents: 200 }],
    }),
  );
  const stock = (productId: number, spec: string) => {
    const it = f.ops.saveItem({ name: '虚构成品' + productId, kind: 'finished', unit: '只', productId, specification: spec }, actor);
    f.ops.move(it.id, { expectedVersion: it.version, requestId: randomUUID(), action: 'in', quantity: '100', date: f.order.orderDate, notes: '虚构期初', acknowledged: true }, actor);
    return it.id;
  };
  const boxed = stock(f.product.id, specification(f.product)),
    bare = stock(plain.id, specification(plain));
  const draft = () =>
    f.flow.save(
      'delivery',
      {
        date: f.order.orderDate,
        customerId: f.customer.id,
        lines: [
          { stockId: boxed, orderId: f.order.id, orderLineId: f.order.lines[0].id, quantity: '40' },
          { stockId: bare, orderId: second.id, orderLineId: second.lines[0].id, quantity: '20' },
        ],
      },
      actor,
    );
  const ship = (id: number) =>
    f.flow.confirm(id, { previewDigest: f.flow.preview(id, actor).previewDigest, requestId: randomUUID(), acknowledged: true, ...shipOnDocDate(f.flow, id) }, actor);
  return { ...f, plain, second, draft, ship };
}

/** 送货单模板：默认几列后面加上材质、楞型两列 */
function addMaterialColumns(store: Store) {
  const settings = new DocumentTemplateSettings(store),
    state = settings.get();
  settings.save(
    {
      expectedRevision: state.revision,
      templates: state.templates.map((t) => (t.kind === 'delivery' ? { ...t, columns: [...defaultTemplateColumns('delivery'), 'material', 'flute'] } : t)),
    },
    actor,
  );
}
/** 送货单每行最后两列（材质、楞型） */
const lastTwo = (rows: string[][]) => rows.map((r) => r.slice(-2));
/** 改产品的材质、楞型（别的照旧） */
const remake = (store: Store, id: number, patch: { material: string; flute: string }) => {
  const p = store.product(id, true);
  assert.ok(p, '虚构产品在');
  store.saveProduct(productSchema.parse({ ...p, ...patch }), id, p.version);
};

test('送货单核对出库：明细按产品补上材质、楞型存进单据，产品没填的存空；待送货时还没有', (t) => {
  const f = setup(t);
  const d = f.draft();
  assert.deepEqual(storedDocument(f.store, d.id, 'delivery').lines.map((l) => [l.material, l.flute]), [[undefined, undefined], [undefined, undefined]]);
  f.ship(d.id);
  assert.deepEqual(storedDocument(f.store, d.id, 'delivery').lines.map((l) => [l.material, l.flute]), [['K=A', 'BC'], ['', '']]);
  assert.deepEqual(f.flow.get(d.id, 'delivery').lines.map((l) => [l.material, l.flute]), [['K=A', 'BC'], ['', '']], '单据详情的数据里也有');
});

test('导出已出库的送货单：材质、楞型两列按明细印（产品没填的印空，出库后产品改了也照出库时的）；别的内容和不加这两列时一样', (t) => {
  const f = setup(t);
  const d = f.draft();
  f.ship(d.id);
  remake(f.store, f.product.id, { material: '虚构改过的材质', flute: 'E' });
  const docs = new BusinessDocuments(f.store),
    plain = docs.form('delivery', d.id).form;
  addMaterialColumns(f.store);
  const form = docs.form('delivery', d.id).form;
  assert.deepEqual(form.headers.slice(-2), ['材质 / 配纸', '楞型']);
  assert.deepEqual(lastTwo(form.rows), [['K=A', 'BC'], ['', '']]);
  assert.deepEqual(form.headers.slice(0, -2), plain.headers);
  assert.deepEqual(form.rows.map((r) => r.slice(0, -2)), plain.rows);
  assert.deepEqual([form.fields, form.notes, form.signatures, form.title, form.number], [plain.fields, plain.notes, plain.signatures, plain.title, plain.number]);
});

test('导出待送货的送货单（明细出库核对时才补）：材质、楞型按产品现在的印，和品名、规格一样', (t) => {
  const f = setup(t);
  const d = f.draft();
  addMaterialColumns(f.store);
  assert.deepEqual(lastTwo(new BusinessDocuments(f.store).form('delivery', d.id).form.rows), [['K=A', 'BC'], ['', '']]);
});

/** 更正一张送货单（加行、换挂要本机管理员），返回替代单库里每行的数量、材质、楞型 */
function correctLines(f: ReturnType<typeof setup>, id: number, lines: { index?: number; orderLineId?: number; quantity: string }[], who: Actor = actor) {
  const input = { expectedVersion: f.flow.get(id).version, reason: '虚构：点错数量', lines },
    plan = planCorrection(f.store, id, input, who);
  const done = correctDocument(f.store, id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, who);
  return storedDocument(f.store, done.replacementId, 'delivery').lines.map((l) => [l.quantity, l.material, l.flute]);
}

test('更正送货单：原样留下的行沿用出库时的材质、楞型，和单价一样（出库后产品补填了也不跟着变）', (t) => {
  const f = setup(t);
  const d = f.draft();
  f.ship(d.id);
  remake(f.store, f.plain.id, { material: '虚构补填的材质', flute: 'E' });
  assert.deepEqual(correctLines(f, d.id, [{ index: 0, quantity: '30' }, { index: 1, quantity: '20' }]), [
    ['30', 'K=A', 'BC'],
    ['20', '', ''],
  ]);
});

test('更正送货单新加的行：按产品现在的材质、楞型补（本机管理员删掉一行、按同一条订单明细新加一行）', (t) => {
  const f = setup(t);
  const d = f.draft();
  f.ship(d.id);
  remake(f.store, f.plain.id, { material: '虚构补填的材质', flute: 'E' });
  assert.deepEqual(correctLines(f, d.id, [{ index: 0, quantity: '40' }, { orderLineId: f.second.lines[0].id, quantity: '20' }], localAdmin()), [
    ['40', 'K=A', 'BC'],
    ['20', '虚构补填的材质', 'E'],
  ]);
});
