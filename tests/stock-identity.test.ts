// 同一种货只有一个库存品（shared/business/stock-identity.ts 的查重键、server/operations/stock-items.ts、到货自动对应）：
// 原材料按查重键不重复（归档的也算），到货没选库存品时入到一样的那个，核对入库的预览和实际一致。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { count, one, rows as tableRows } from '../server/core/index.js';
import type { Actor } from '../server/core/auth.js';
import { productSchema } from '../shared/core/domain.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { rawStockKey, sameRawSpec } from '../shared/business/stock-identity.js';
import { StockConflictError } from '../server/operations/stock-items.js';
import { changeLifecycle } from '../server/business/lifecycle.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { viewOfKind } from '../server/flow/read.js';
import { businessFixture, clerk } from './flow-fixture.js';
import { ofKind, saveDoc } from './receive-fixture.js';

test('原材料查重键：文字不分大小写和全半角、去掉首尾空白、中间空白并成一个，空值和空串一样，尺寸换成毫米比；名称、规格说明不同就是不同的货', () => {
  const base = { name: '牛卡纸板', specification: 'A级', length: 1200, width: 800, height: null, dimensionUnit: 'mm', material: 'K=K', flute: 'B' };
  const key = rawStockKey(base);
  // 文字：首尾空白、大小写、全角半角都不算差别；中间连续的空白并成一个（不是去掉）
  assert.equal(rawStockKey({ ...base, name: '  牛卡纸板 ', material: 'k=k', flute: 'b' }), key);
  assert.equal(rawStockKey({ ...base, specification: 'Ａ级' }), key);
  assert.equal(rawStockKey({ ...base, material: 'K  =\t K' }), rawStockKey({ ...base, material: 'k = k' }));
  assert.notEqual(rawStockKey({ ...base, material: 'K = K' }), key);
  // 空值和空串一样
  for (const blank of [null, undefined, '', '   '])
    assert.equal(rawStockKey({ ...base, specification: blank }), rawStockKey({ ...base, specification: '' }), String(blank));
  assert.equal(rawStockKey({ name: '纸板', material: null, flute: undefined }), rawStockKey({ name: '纸板', material: '', flute: '' }));
  // 尺寸：写了单位的换成毫米比，数字写法不同不算
  assert.equal(rawStockKey({ ...base, length: 120, width: 80, dimensionUnit: 'cm' }), key);
  assert.equal(rawStockKey({ ...base, length: 1200.0, width: 8e2 }), key);
  assert.equal(rawStockKey({ ...base, height: undefined }), key);
  assert.equal(rawStockKey({ ...base, length: 12.5, width: 8, dimensionUnit: 'cm' }), rawStockKey({ ...base, length: 125, width: 80 }));
  // 没写单位的不换算，和写了单位的是不同的货；长宽高都没填时单位不算数
  assert.notEqual(rawStockKey({ ...base, dimensionUnit: null }), key);
  assert.notEqual(
    rawStockKey({ ...base, length: 120, width: 80, dimensionUnit: null }),
    rawStockKey({ ...base, length: 120, width: 80, dimensionUnit: 'cm' }),
  );
  assert.equal(rawStockKey({ name: '纸板', dimensionUnit: 'mm' }), rawStockKey({ name: '纸板', dimensionUnit: null }));
  assert.equal(rawStockKey({ name: '纸板', length: null }), rawStockKey({ name: '纸板' }));
  // 名称、规格说明、材质、楞型、尺寸任何一项不同都是不同的货；备注不算
  for (const patch of [{ name: '牛卡纸板（优等）' }, { specification: 'B级' }, { material: 'K=A' }, { flute: 'C' }, { length: 1201 }, { height: 5 }])
    assert.notEqual(rawStockKey({ ...base, ...patch }), key, JSON.stringify(patch));
  const withNotes = { ...base, notes: '另一句备注' };
  assert.equal(rawStockKey(withNotes), key);
  // 规格比对（到货选库存品、采购明细关联库存品、到货对采购明细）用同一套规则，只是不看名称
  assert.ok(sameRawSpec({ ...base, name: '别的名字', material: 'k=k', length: 120, width: 80, dimensionUnit: 'cm' }, base));
  assert.ok(sameRawSpec({ name: '纸板', dimensionUnit: 'mm' }, { name: '纸板' }), '没填尺寸时尺寸单位不算数');
  for (const patch of [{ specification: 'B级' }, { material: 'K=A' }, { flute: 'C' }, { length: 1201 }, { dimensionUnit: null }])
    assert.ok(!sameRawSpec({ ...base, ...patch }, base), JSON.stringify(patch));
});

test('同一种货只有一个库存品：成品要先选产品、一个产品一个成品库存，原材料一样的不能有第二个，归档的也算；提示写出已有那个并带上编号', () => {
  const f = businessFixture();
  try {
    const stockCount = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_items');
    const before = stockCount();
    const conflict = (stockId: number, archived: boolean, message: RegExp) => (e: unknown) => {
      assert.ok(e instanceof StockConflictError, String(e));
      assert.deepEqual([e.status, e.code, e.details.stockId, e.details.archived], [409, 'stock-exists', stockId, archived]);
      assert.match(e.message, message);
      return true;
    };
    // 成品：不选产品不能建；这个产品已经有成品库存就不能再建
    assert.throws(() => f.ops.saveItem({ name: '虚构成品二', kind: 'finished', unit: '只' }, f.actor), /成品库存要先选产品/);
    assert.throws(
      () => f.ops.saveItem({ name: '虚构成品二', kind: 'finished', unit: '只', productId: f.product.id }, f.actor),
      conflict(f.finished.id, false, /^产品“虚构纸箱”已经有成品库存“虚构纸箱”，一个产品只有一个成品库存，不用再建。$/),
    );
    // 原材料：不关联产品；名称、规格说明、尺寸、材质、楞型规范化后一样的不能有第二个
    assert.throws(
      () => f.ops.saveItem({ name: '虚构新纸板', kind: 'raw', unit: '张', productId: f.product.id }, f.actor),
      /原材料不关联产品，只有成品库存关联产品；改成原材料时请同时清掉关联的产品。/,
    );
    assert.throws(
      () => f.ops.saveItem({ name: ' 虚构纸板  ', kind: 'raw', unit: '张', specification: null }, f.actor),
      conflict(
        f.raw.id,
        false,
        /^已经有一样的原材料“虚构纸板”：名称、规格说明、尺寸、材质、楞型都相同就是同一种货，不用再建；质量不同的纸板请用名称或规格说明区分。$/,
      ),
    );
    // 规格说明不同就是不同的货，可以建；改成和别的原材料一样也不行；改自己（查重的几项不变）不算撞
    const better = f.ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张', specification: '优等' }, f.actor);
    assert.throws(
      () => f.ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张', version: better.version }, f.actor, better.id),
      conflict(f.raw.id, false, /已经有一样的原材料“虚构纸板”/),
    );
    const noted = f.ops.saveItem(
      { name: '虚构纸板', kind: 'raw', unit: '张', specification: '优等', notes: '虚构备注', version: better.version },
      f.actor,
      better.id,
    );
    assert.equal(noted.notes, '虚构备注');
    // 归档的也算：提示去恢复
    const glue = f.ops.repo.items(true, f.glue.id)[0];
    assert.ok(changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: glue.id, version: glue.version }] }, f.actor).results[0].success);
    assert.throws(
      () => f.ops.saveItem({ name: '虚构衬板', kind: 'raw', unit: '张' }, f.actor),
      conflict(f.glue.id, true, /^已经有一样的原材料“虚构衬板”（已归档）：.*请到已归档里恢复它，不用再建。$/),
    );
    const spare = f.store.saveProduct(productSchema.parse({ name: '虚构备用纸箱' })),
      parked = f.ops.saveItem({ name: '虚构备用成品', kind: 'finished', unit: '只', productId: spare.id }, f.actor);
    assert.ok(changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: parked.id, version: parked.version }] }, f.actor).results[0].success);
    assert.throws(
      () => f.ops.saveItem({ name: '虚构备用成品二', kind: 'finished', unit: '只', productId: spare.id }, f.actor),
      conflict(parked.id, true, /^产品“虚构备用纸箱”已经有成品库存“虚构备用纸箱”（已归档），一个产品只有一个成品库存，请到已归档里恢复它，不用再建。$/),
    );
    assert.equal(stockCount(), before + 2, '被拒绝的一个都没建');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('到货没选库存品：已经有一样的原材料（归档的也算）就入到它那里，归档的自动恢复并写审计；一样的几行只建一个', () => {
  const f = businessFixture();
  try {
    const glue = f.ops.repo.items(true, f.glue.id)[0];
    assert.ok(changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: glue.id, version: glue.version }] }, f.actor).results[0].success);
    const before = f.ops.repo.items(true).filter((i) => i.kind === 'raw').length;
    const doc = f.confirm('arrival', {
      supplierId: f.supplier.id,
      reference: randomUUID(),
      lines: [
        { item: { name: '虚构衬板 ', unit: '张' }, quantity: '30', differenceReason: '虚构无单收货' },
        { item: { name: '虚构新纸板', unit: '张', material: 'K' }, quantity: '10', differenceReason: '虚构无单收货' },
        { item: { name: '虚构新纸板', unit: '张', material: 'k' }, quantity: '5', differenceReason: '虚构无单收货' },
      ],
    });
    assert.equal(doc.lines[0].stockId, f.glue.id);
    assert.equal(f.store.archived('stock_items', f.glue.id), false);
    assert.equal(f.ops.repo.balance(f.glue.id), 30000);
    assert.equal(doc.lines[1].stockId, doc.lines[2].stockId);
    assert.equal(f.ops.repo.balance(Number(doc.lines[1].stockId)), 15000);
    assert.equal(f.ops.repo.items(true).filter((i) => i.kind === 'raw').length, before + 1, '只新建了“虚构新纸板”一个');
    const restored = one(f.store.db, tableRows.business_audit.pick({ document: true }), "SELECT document FROM business_audit WHERE entity='stock_items' AND record_id=? AND action='restore'", f.glue.id);
    assert.ok(restored);
    // 审计看得出是哪张到货单自动恢复、自动新建的，和人手动新建分得开
    const auditDocument = z.object({ reason: z.string(), document: z.string() });
    const restoredDoc = auditDocument.parse(JSON.parse(restored.document) as unknown);
    assert.match(restoredDoc.reason, /到货入库时自动恢复已归档的库存品/);
    assert.equal(restoredDoc.document, '到货单 ' + doc.number);
    const created = one(f.store.db, tableRows.business_audit.pick({ source: true, document: true }), "SELECT source,document FROM business_audit WHERE entity='stock_items' AND record_id=? AND action='create'", doc.lines[1].stockId);
    assert.ok(created);
    assert.equal(created.source, AUDIT_SOURCE.page, '登记到货是在页面上做的，自动新建的那条也记页面，靠原因分');
    assert.deepEqual(
      [auditDocument.parse(JSON.parse(created.document) as unknown).reason, auditDocument.parse(JSON.parse(created.document) as unknown).document],
      ['到货入库时自动新建', '到货单 ' + doc.number],
    );
    const manual = one(f.store.db, tableRows.business_audit.pick({ source: true, document: true }), "SELECT source,document FROM business_audit WHERE entity='stock_items' AND record_id=? AND action='create'", f.glue.id);
    assert.ok(manual);
    assert.equal(manual.source, AUDIT_SOURCE.page);
    assert.equal(auditDocument.partial().parse(JSON.parse(manual.document) as unknown).reason, undefined, '人手动新建的没有自动新建的原因');
  } finally {
    f.store.close();
  }
});

/** 用普通业务账号登记并核对入库一张到货单（不走本机管理员那条路） */
const arriveAs = (f: ReturnType<typeof businessFixture>, who: Actor, lines: unknown[], patch: Record<string, unknown> = {}) => {
  const d = saveDoc(f.flow, 'arrival', { date: '2026-10-27', supplierId: f.supplier.id, reference: randomUUID(), lines, ...patch }, who),
    p = f.flow.preview(d.id, who);
  return viewOfKind(f.flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, who), 'arrival');
};

test('同一种纸板只差大小写、全半角、厘米毫米写法：到货自动并进已有的以后，分批到货（选不选都一样）、改采购单都照常', () => {
  const f = businessFixture();
  try {
    const board = f.ops.saveItem(
      { name: '虚构牛卡', kind: 'raw', unit: '张', material: 'K=K', flute: 'BC', length: 1200, width: 800, dimensionUnit: 'mm' },
      clerk,
    );
    // 采购明细写成小写、全角、厘米，没关联库存品
    const purchase = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-01',
        status: '已订货',
        lines: [{ name: '虚构牛卡', unit: '张', material: 'k=k', flute: 'ｂｃ', length: 120, width: 80, dimensionUnit: 'cm', quantity: '100' }],
      },
      clerk,
    );
    const line = () => f.ops.repo.purchases(true, purchase.id)[0].lines[0];
    const arrive = (quantity: string, select: boolean) => {
      const pl = line();
      return arriveAs(f, clerk, [{ purchaseLineId: pl.id, ...(select ? { stockId: pl.stockItemId } : {}), item: { ...pl }, quantity }]);
    };
    // 第一次到货：没选库存品，自动并进已有的那个，采购明细也关联上它
    assert.equal(arrive('40', false).lines[0].stockId, board.id);
    assert.equal(line().stockItemId, board.id);
    // 第二次明确选它、第三次不选：都入同一个，结果一样
    assert.equal(arrive('30', true).lines[0].stockId, board.id);
    assert.equal(arrive('30', false).lines[0].stockId, board.id);
    assert.equal(f.ops.repo.balance(board.id), 100_000);
    assert.equal(line().receivedQuantity, '100');
    // 采购单照常能改（只改备注）
    const p = f.ops.repo.purchases(true, purchase.id)[0];
    assert.equal(f.ops.savePurchase({ ...p, status: p.baseStatus, notes: '虚构改备注' }, clerk, purchase.id).notes, '虚构改备注');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('同一张到货单里只差大小写的两行并进同一个库存品：更正到货单、撤销后重新登记，都照常', () => {
  const f = businessFixture();
  try {
    const doc = arriveAs(f, clerk, [
      { item: { name: '虚构新纸板', unit: '张', material: 'K' }, quantity: '10', differenceReason: '虚构无单收货' },
      { item: { name: '虚构新纸板', unit: '张', material: 'k' }, quantity: '5', differenceReason: '虚构无单收货' },
    ]);
    const stockId = Number(doc.lines[0].stockId);
    assert.equal(doc.lines[1].stockId, stockId);
    // 更正到货单：第一行 10 改成 8，替代单的两行还是同一个库存品
    const input = { expectedVersion: f.flow.get(doc.id).version, reason: '虚构更正', lines: [{ index: 0, quantity: '8' }, { index: 1, quantity: '5' }] };
    const plan = planCorrection(f.store, doc.id, input, clerk);
    const corrected = ofKind(correctDocument(f.store, doc.id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, clerk), 'arrival');
    const replacement = f.flow.get(corrected.replacementFlowId, 'arrival');
    assert.deepEqual(replacement.lines.map((l) => l.stockId), [stockId, stockId]);
    assert.equal(f.ops.repo.balance(stockId), 13_000);
    // 撤销后重新登记（到货不再按原单重新填写）：走同一个核对，照常入库
    f.flow.reverse(replacement.id, { version: replacement.version, reason: '虚构登记错了', acknowledged: true }, f.actor);
    assert.equal(f.ops.repo.balance(stockId), 0);
    const redo = arriveAs(f, clerk, replacement.lines.map((l) => ({ stockId: l.stockId, item: l.item, quantity: l.quantity, differenceReason: l.differenceReason })));
    assert.equal(redo.correctionOf ?? null, null);
    assert.equal(f.ops.repo.balance(stockId), 13_000);
  } finally {
    f.store.close();
  }
});

test('已有原材料只选了尺寸单位、没填尺寸：同名、没写单位的到货行自动并进去，之后明确选它也照常', () => {
  const f = businessFixture();
  try {
    const board = f.ops.saveItem({ name: '虚构纸板X', kind: 'raw', unit: '张', dimensionUnit: 'mm' }, clerk);
    const line = (patch: Record<string, unknown> = {}) => [{ item: { name: '虚构纸板X', unit: '张' }, quantity: '10', differenceReason: '虚构无单收货', ...patch }];
    assert.equal(arriveAs(f, clerk, line()).lines[0].stockId, board.id);
    assert.equal(arriveAs(f, clerk, line({ stockId: board.id })).lines[0].stockId, board.id);
    assert.equal(f.ops.repo.balance(board.id), 20_000);
  } finally {
    f.store.close();
  }
});

test('真的不同的规格仍然被拒：材质、尺寸、规格说明不同的，到货选它、采购明细关联它、到货对采购明细都不行', () => {
  const f = businessFixture();
  try {
    const spec = { name: '虚构规格纸板', kind: 'raw', unit: '张', material: 'K=K', flute: 'BC', length: 1200, width: 800, dimensionUnit: 'mm', specification: '一等' };
    const board = f.ops.saveItem(spec, clerk);
    const { kind: _kind, ...item } = spec;
    for (const patch of [{ material: 'K=A' }, { width: 801 }, { length: 120, width: 80, dimensionUnit: null }, { specification: '二等' }]) {
      const other = { ...item, ...patch };
      // 到货明确选它
      assert.throws(
        () => arriveAs(f, clerk, [{ stockId: board.id, item: other, quantity: '10', differenceReason: '虚构' }]),
        /所选库存品的尺寸、材质、楞型、规格或单位不一致，不允许合并。/,
        JSON.stringify(patch),
      );
      // 采购明细关联它
      assert.throws(
        () =>
          f.ops.savePurchase(
            { supplierId: f.supplier.id, orderDate: '2026-10-01', status: '已订货', lines: [{ ...other, stockItemId: board.id, quantity: '10' }] },
            clerk,
          ),
        /明细规格与所选库存品不一致/,
        JSON.stringify(patch),
      );
      // 到货对采购明细
      const purchase = f.ops.savePurchase(
        { supplierId: f.supplier.id, orderDate: '2026-10-01', status: '已订货', lines: [{ ...item, quantity: '10' }] },
        clerk,
      );
      assert.throws(
        () => arriveAs(f, clerk, [{ purchaseLineId: purchase.lines[0].id, item: other, quantity: '10' }]),
        /实收规格、材质、楞型或单位与采购明细不符/,
        JSON.stringify(patch),
      );
    }
    assert.equal(f.ops.repo.balance(board.id), 0);
  } finally {
    f.store.close();
  }
});

test('核对入库的预览和实际一致：没选库存品的到货行写清入到已有的哪个（已归档的会自动恢复）、还是新建，现在多少、核对后多少；预览不建也不恢复', () => {
  const f = businessFixture();
  try {
    const board = f.ops.saveItem({ name: '虚构E三层', kind: 'raw', unit: '张', length: 800, width: 600, dimensionUnit: 'mm', material: 'W=A', flute: 'E' }, clerk);
    f.ops.move(board.id, { action: 'in', quantity: '450', date: '2026-10-20', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: board.version }, clerk);
    const glue = f.ops.repo.items(true, f.glue.id)[0];
    assert.ok(changeLifecycle(f.store, 'stock_items', { action: 'archive', items: [{ id: glue.id, version: glue.version }] }, f.actor).results[0].success);
    const stockCount = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_items');
    const before = stockCount();
    const draft = saveDoc(f.flow, 
      'arrival',
      {
        date: '2026-10-27',
        supplierId: f.supplier.id,
        reference: randomUUID(),
        lines: [
          { item: { name: '虚构E三层', unit: '张', length: 80, width: 60, dimensionUnit: 'cm', material: 'w=a', flute: 'e' }, quantity: '100', differenceReason: '虚构' },
          { item: { name: '虚构衬板', unit: '张' }, quantity: '20', differenceReason: '虚构' },
          { item: { name: '虚构全新纸板', unit: '张' }, quantity: '30', differenceReason: '虚构' },
          { item: { name: '虚构全新纸板', unit: '张' }, quantity: '5', differenceReason: '虚构' },
          { stockId: board.id, item: { name: '虚构E三层', unit: '张', length: 800, width: 600, dimensionUnit: 'mm', material: 'W=A', flute: 'E' }, quantity: '10', differenceReason: '虚构' },
        ],
      },
      clerk,
    );
    const preview = f.flow.preview(draft.id, clerk);
    const rows = preview.changes.map((c) => [c.stockId, c.target ?? null, c.sameNewAs ?? null, c.currentUnits, c.afterUnits]);
    assert.deepEqual(rows, [
      [null, { id: board.id, name: '虚构E三层', archived: false }, null, 450_000, 550_000],
      [null, { id: f.glue.id, name: '虚构衬板', archived: true }, null, 0, 20_000],
      [null, null, null, 0, 30_000],
      // 同一库存品的后几行：“现在”接着上一行核对后的数写（现在 + 变化 = 核对后）
      [null, null, 3, 30_000, 35_000],
      [board.id, null, null, 550_000, 560_000],
    ]);
    // 预览只读：没建出库存品，归档也没动
    assert.equal(stockCount(), before);
    assert.equal(f.store.archived('stock_items', f.glue.id), true);
    // 实际入库和预览说的一样
    const done = viewOfKind(f.flow.confirm(draft.id, { previewDigest: preview.previewDigest, requestId: randomUUID(), acknowledged: true }, clerk), 'arrival');
    assert.deepEqual(done.lines.map((l) => l.stockId).slice(0, 2), [board.id, f.glue.id]);
    assert.equal(done.lines[2].stockId, done.lines[3].stockId);
    assert.equal(f.ops.repo.balance(board.id), 560_000);
    assert.equal(f.ops.repo.balance(f.glue.id), 20_000);
    assert.equal(f.ops.repo.balance(Number(done.lines[2].stockId)), 35_000);
    assert.equal(stockCount(), before + 1);
  } finally {
    f.store.close();
  }
});

test('核对入库预览之后，没选库存品的到货行将要入的原材料变了（别人新建了一样的、它有出入库、改了名），确认时报“已变化”，不悄悄换对象', () => {
  const f = businessFixture();
  try {
    const item = { name: '虚构E三层', unit: '张', material: 'A=A', flute: 'E', length: 800, width: 600, dimensionUnit: 'mm' };
    const arrival = () =>
      saveDoc(f.flow, 'arrival', { date: '2026-10-27', supplierId: f.supplier.id, reference: randomUUID(), lines: [{ item, quantity: '100', differenceReason: '虚构' }] }, clerk);
    const confirm = (d: { id: number }, p: { previewDigest: string }) =>
      viewOfKind(f.flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, clerk), 'arrival');
    const changed = /预览以后数据已变化，请重新预览。/;
    // 预览写“新建”，确认前别人建了一样的原材料
    const first = arrival(),
      firstPreview = f.flow.preview(first.id, clerk);
    assert.equal(firstPreview.changes[0].target ?? null, null);
    const other = f.ops.saveItem({ ...item, kind: 'raw' }, clerk);
    assert.throws(() => confirm(first, firstPreview), changed);
    // 重新预览就入到别人建的那个
    const again = f.flow.preview(first.id, clerk);
    assert.equal(again.changes[0].target?.id, other.id);
    // 预览写“入到已有的”，确认前它有出入库
    f.ops.move(other.id, { action: 'in', quantity: '450', date: '2026-10-27', notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: other.version }, clerk);
    assert.throws(() => confirm(first, again), changed);
    // 预览写“入到已有的”，确认前它改了名
    const second = arrival(),
      secondPreview = f.flow.preview(second.id, clerk);
    assert.equal(secondPreview.changes[0].target?.id, other.id);
    const current = f.ops.repo.items(true, other.id)[0];
    f.ops.saveItem({ ...current, name: '虚构E三层（旧）', version: current.version }, clerk, other.id);
    assert.throws(() => confirm(second, secondPreview), changed);
    // 没人动：照常入库，入的就是预览说的那个
    const third = arrival(),
      thirdPreview = f.flow.preview(third.id, clerk);
    const done = confirm(third, thirdPreview);
    assert.equal(thirdPreview.changes[0].target ?? null, null);
    assert.notEqual(done.lines[0].stockId, other.id);
    assert.equal(f.ops.repo.balance(Number(done.lines[0].stockId)), 100_000);
  } finally {
    f.store.close();
  }
});
