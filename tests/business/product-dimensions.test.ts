// 产品尺寸可空、厘米毫米换算，识别导入时的尺寸（缺尺寸也能导、换单位不改实际大小、未知单位不猜、cm 档案对上 mm 草稿）。
// 识别导入走服务层（ImportExecutionService）直调，接口那一层的登录和凭证由 order-import-execute 守着。假 DeepSeek、内存库、临时目录、虚构数据。
import { sales } from '../../server/sales/index.js';
import { pageActor } from '../support/actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, one, rows } from '../../server/core/index.js';
import { ImportExecutionService } from '../../server/import/import-execution.js';
import { productSchema } from '../../shared/core/domain.js';
import { stockItemSchema } from '../../shared/business/index.js';
import {
  convertDimension,
  normalizeDimensionUnit,
  normalizedDimensions,
  productNotices,
} from '../../shared/core/product-details.js';
import { evaluateDraft } from '../../shared/import/draft-evaluation.js';
import { standardOrderDraft } from '../../server/import/standard-order.js';
import { docxFixture } from '../support/import-fixtures.js';
import { importWorkspace, tempDir } from '../support/order-import-fixture.js';

const importer = pageActor({ id: 'fictional-importer', name: '虚构导入员', permissions: ['business:edit', 'import:execute'] });

function analysis() {
  const header: Record<string, string | null> = {
      buyerName: '可选资料客户（虚构）',
      supplierName: '宁波甬勒包装制品有限公司',
      orderDate: '2026-10-25',
      deliveryDate: '2026-11-01',
      currency: 'CNY',
      taxMode: '含税',
      purchaseOrderNumber: 'OPTIONAL-TEST-001',
    },
    line: Record<string, string | null> = {
      productName: '名称已明确的纸箱A',
      specification: '原单规格型号保持',
      notes: '包装备注保持',
      quantity: '1000',
      unit: '只',
      unitPrice: '1.3900',
    };
  return { header, lines: [line], warnings: [] };
}

/** 识别好一份原件；preview() 出正式导入的方案，imported() 预览后正式导入 */
async function fixture(response = analysis()) {
  const store = new Store(':memory:'),
    archive = tempDir('erp-dimension-archive-'),
    f = importWorkspace(() => response, { store, archiveDirectory: archive.dir }),
    service = new ImportExecutionService(store, f.manager);
  let w = await f.upload(docxFixture(), '可选资料测试.docx');
  w = await f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
  const preview = () => service.preview(w.id, { expectedRevision: f.manager.get(w.id).revision }, importer);
  return {
    store,
    manager: f.manager,
    w,
    preview,
    async imported() {
      const p = await preview();
      return service.execute(w.id, { expectedRevision: p.plan.source.revision, previewDigest: p.previewDigest, acknowledged: true }, importer);
    },
    close() {
      f.close();
      store.close();
      archive.remove();
    },
  };
}
const withLine = (patch: Record<string, string>) => {
  const data = analysis();
  Object.assign(data.lines[0], patch);
  return data;
};

test('产品仅名称必填，真正NULL保存缺失尺寸；错误数值及错误单位仍被拒绝', () => {
  const p = productSchema.parse({ name: '仅名称' });
  assert.deepEqual([p.length, p.width, p.height, p.material, p.flute], [null, null, null, '', '']);
  const store = new Store(':memory:');
  try {
    const saved = sales(store).createProduct(p);
    assert.equal(saved.length, null);
    assert.equal(saved.dimensionUnit, null);
    const row = one(store.db, rows.products.pick({ length: true }), 'SELECT length FROM products WHERE id=?', saved.id);
    assert.ok(row);
    assert.equal(row.length, null);
    for (const wrong of [
      { name: '' },
      { name: 'A', length: 0 },
      { name: 'A', width: -1 },
      { name: 'A', height: NaN },
      { name: 'A', dimensionUnit: 'inch' },
      { name: 'A', length: 1001, dimensionUnit: 'cm' },
    ])
      assert.equal(productSchema.safeParse(wrong).success, false);
    assert.throws(() => store.db.prepare('UPDATE products SET width=0').run());
  } finally {
    store.close();
  }
});

test('厘米尺寸超上限：产品和库存品被拦，提示同一句、带毫米换算', () => {
  const issueOf = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;
  const product = productSchema.safeParse({ name: 'A', length: 1001, dimensionUnit: 'cm' });
  const stock = stockItemSchema.safeParse({ name: '虚构纸板', kind: 'raw', length: 1001, dimensionUnit: 'cm' });
  assert.equal(issueOf(product), '厘米尺寸不能超过1000cm（等于10000mm）');
  assert.equal(issueOf(stock), issueOf(product));
  assert.equal(stockItemSchema.safeParse({ name: '虚构纸板', kind: 'raw', length: 1000, dimensionUnit: 'cm' }).success, true);
});

test('缺长宽高、配纸、类型且单位未知的新产品能正式导入，字段和金额不丢', async () => {
  const f = await fixture();
  try {
    const preview = await f.preview();
    const planned = preview.plan.products[0];
    assert.ok(planned.mode === 'new');
    const input = planned.input;
    assert.deepEqual([input.length, input.dimensionUnit], [null, null]);
    assert.ok(preview.plan.warnings.some((s: string) => s.includes('可后续补充')));
    const receipt = await f.imported(),
      product = sales(f.store).products()[0],
      order = sales(f.store).order(receipt.orderId);
    assert.ok(order);
    assert.deepEqual([product.material, product.flute, product.dimensionUnit, product.length], ['', '', null, null]);
    assert.deepEqual(
      [order.lines[0].productName, order.lines[0].specification, order.lines[0].notes, order.lines[0].unitPriceExact, order.totalAmountExact],
      ['名称已明确的纸箱A', '原单规格型号保持', '包装备注保持', '1.3900', '1390.0000'],
    );
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('cm与mm均可创建产品及正式导入，小数和1cm=10mm换算往返不改变实际尺寸', async () => {
  for (const unit of ['cm', 'mm'] as const) {
    const f = await fixture(
      withLine(unit === 'cm' ? { length: '30.25', width: '20', height: '15', dimensionUnit: unit } : { length: '302.5', width: '200', height: '150', dimensionUnit: unit }),
    );
    try {
      await f.imported();
      const saved = sales(f.store).products()[0];
      assert.equal(saved.dimensionUnit, unit);
      assert.deepEqual(normalizedDimensions(saved), [302.5, 200, 150]);
    } finally {
      f.close();
    }
  }
  for (const value of [0.29, 12.5, 300.125, 10000])
    assert.equal(convertDimension(convertDimension(value, 'mm', 'cm'), 'cm', 'mm'), value);
  assert.equal(convertDimension(0.29, 'cm', 'mm'), 2.9);
});

test('草稿只切换单位时后端同步换算尺寸，保存/撤销保持原始规格和实际大小', async () => {
  const f = await fixture(withLine({ length: '300', width: '200', height: '150', dimensionUnit: 'mm' }));
  try {
    let w = f.w;
    assert.ok(w.draft);
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-line', lineId: w.draft.lines[0].id, field: 'dimensionUnit', value: 'cm', reason: '用户切换单位' }],
    });
    assert.ok(w.draft);
    const fields = w.draft.lines[0].fields;
    assert.deepEqual([fields.length.value, fields.width.value, fields.height.value], ['30', '20', '15']);
    assert.equal(fields.specification.value, '原单规格型号保持');
    assert.ok(w.evaluation);
    assert.equal(w.evaluation.totalAmount, '1390.0000');
    w = f.manager.undo(w.id, { expectedRevision: w.revision });
    assert.ok(w.draft);
    assert.equal(w.draft.lines[0].fields.length.value, '300');
    assert.equal(w.draft.lines[0].fields.dimensionUnit.value, 'mm');
  } finally {
    f.close();
  }
});

test('未知单位不当成毫米、无本地推算，保留原文且允许后续确认', async () => {
  const f = await fixture(withLine({ length: '3.5', dimensionUnit: '英寸' }));
  try {
    const planned = (await f.preview()).plan.products[0];
    assert.ok(planned.mode === 'new');
    const input = planned.input;
    assert.deepEqual([input.dimensionUnit, input.dimensionUnitRaw, input.length], [null, '英寸', 3.5]);
    await f.imported();
    assert.equal(sales(f.store).products()[0].dimensionUnit, null);
    assert.equal(sales(f.store).products()[0].dimensionUnitRaw, '英寸');
    assert.equal(normalizeDimensionUnit('unknown'), null);
  } finally {
    f.close();
  }
});

test('同名产品同类补充提醒合并一次且不是红色错误，真正尺寸错误仍阻止提交', async () => {
  const f = await fixture();
  try {
    const w = structuredClone(f.w);
    const draft = w.draft;
    assert.ok(draft);
    draft.lines.push({ ...structuredClone(draft.lines[0]), id: crypto.randomUUID() });
    w.mapping = {
      customer: { mode: 'new' },
      products: Object.fromEntries(draft.lines.map((l) => [l.id, { mode: 'new' }])),
      roundingPolicy: 'exact-cents',
    };
    const projection = standardOrderDraft(f.store, w);
    assert.ok(projection);
    assert.deepEqual(projection.issues, []);
    assert.equal(projection.notices.filter((s) => s.includes('可后续补充')).length, 1);
    const evaluation = evaluateDraft(draft);
    assert.ok(!evaluation.issues.some((i) => i.severity === 'error'));
    // 产品资料能后补的提示只按实际要用的档案算一次（标准订单投影），识别结果自己不再按原件的字算
    assert.equal(evaluation.issues.filter((i) => i.message.includes('可后续补充')).length, 0);
    assert.equal(new Set(projection.notices).size, projection.notices.length);
    draft.lines[0].fields.length.value = '-5';
    const invalid = standardOrderDraft(f.store, w);
    assert.ok(invalid);
    assert.ok(invalid.issues.length);
    assert.ok(evaluateDraft(draft).issues.some((i) => i.severity === 'error' && i.message.includes('长')));
    assert.equal(
      productNotices([
        { name: 'A', length: null },
        { name: 'A', length: null },
      ]).filter((s) => s.includes('可后续补充')).length,
      1,
    );
  } finally {
    f.close();
  }
});

test('同一实际尺寸的cm档案与mm草稿能够正确匹配，不创建重复产品或改变旧档案', async () => {
  const f = await fixture(withLine({ length: '300', width: '200', height: '150', dimensionUnit: 'mm', material: '牛卡', flute: 'B' }));
  try {
    const product = sales(f.store).createProduct(
      productSchema.parse({ name: '名称已明确的纸箱A', length: 30, width: 20, height: 15, dimensionUnit: 'cm', material: '牛卡', flute: 'B', priceCents: 139 }),
    );
    const planned = (await f.preview()).plan.products[0];
    assert.ok(planned.mode === 'existing');
    assert.deepEqual([planned.mode, planned.id], ['existing', product.id]);
    await f.imported();
    assert.equal(sales(f.store).products().length, 1);
    const saved = sales(f.store).product(product.id);
    assert.ok(saved);
    assert.deepEqual([saved.length, saved.dimensionUnit], [30, 'cm']);
    assert.equal(sales(f.store).orders()[0].lines[0].unitPriceExact, '1.3900');
  } finally {
    f.close();
  }
});
