// 新建客户、产品前的查重只有一套（server/core/duplicate-records.ts，名字键在 shared/core/name-keys.ts）：
// 人工新建、识别导入、助手都用它。只用 :memory: 库和虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/errors.js';
import { assertNewProductAllowed, duplicateCustomers, productDuplicates, type ProductLike } from '../server/core/duplicate-records.js';
import { importPlan } from '../server/import/import-plan.js';
import { duplicateKey, looseKey, nameKey } from '../shared/core/name-keys.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { evaluateDraft } from '../shared/import/draft-evaluation.js';
import { blankField, headerFields, lineFields, orderDraftSchema, type ImportWorkspaceView } from '../shared/import/order-draft.js';

test('名字键三档：宽松只去空白和大小写，名字键再统一全角半角，查重键再去分隔符号', () => {
  assert.equal(looseKey(' 虚构 Box A '), '虚构boxa');
  assert.notEqual(looseKey('ＡＢＣ'), looseKey('abc'), '宽松键不管全角半角（订单指纹口径不变）');
  assert.equal(nameKey('ＡＢＣ 纸箱'), 'abc纸箱');
  for (const v of ['虚构纸箱-A', '虚构纸箱 a', '虚构纸箱（A）', '虚构纸箱(A)', '虚构纸箱_A', '虚构纸箱·A'])
    assert.equal(duplicateKey(v), '虚构纸箱a', v);
  assert.equal(duplicateKey(null), '');
  assert.notEqual(duplicateKey('虚构纸箱A'), duplicateKey('虚构纸箱B'));
});

test('客户查重：分隔符、全角、大小写、末尾标点都不算区别；已归档的也查；空名字不查', () => {
  const store = new Store(':memory:');
  try {
    const a = store.saveCustomer(customerSchema.parse({ name: '虚构贸易（甲）' })),
      b = store.saveCustomer(customerSchema.parse({ name: 'Fictional Trade Co.' }));
    store.markArchived('customers', b.id, 'fixture');
    assert.deepEqual(duplicateCustomers(store, '虚构贸易-甲').map((r) => r.id), [a.id]);
    assert.deepEqual(duplicateCustomers(store, 'fictional trade co').map((r) => [r.id, r.archived]), [[b.id, true]]);
    assert.deepEqual(duplicateCustomers(store, '虚构贸易乙'), []);
    assert.deepEqual(duplicateCustomers(store, ' - '), []);
  } finally {
    store.close();
  }
});

const box = { length: 300, width: 200, height: 150, dimensionUnit: 'mm' as const, material: 'K=A', flute: 'BC' };

test('产品查重三条：料号相同一律拦；同名同尺寸材质拦；同名不同尺寸材质（或没写全）确认是另一个产品才建；都含已归档', () => {
  const store = new Store(':memory:');
  try {
    const coded = store.saveProduct(productSchema.parse({ name: '虚构料号箱', customerProductCode: 'XG-001' })),
      full = store.saveProduct(productSchema.parse({ name: '虚构纸箱 甲', ...box })),
      bare = store.saveProduct(productSchema.parse({ name: '虚构纸箱甲' }));
    store.markArchived('products', full.id, 'fixture');
    const ids = (input: ProductLike) => {
      const r = productDuplicates(store, input);
      return { code: r.sameCode.map((x) => x.id), same: r.sameProduct.map((x) => x.id), name: r.sameName.map((x) => x.id) };
    };
    // 1. 料号相同（写法不同也算），确认了也不建
    assert.deepEqual(ids({ name: '别的名字', customerProductCode: 'xg 001' }), { code: [coded.id], same: [], name: [] });
    assert.throws(() => assertNewProductAllowed(store, { name: '别的名字', customerProductCode: 'xg 001' }, true), /客户料号“xg 001”已经用在：虚构料号箱/);
    // 2. 同名、尺寸材质都一样（厘米换成毫米比；归档的也算），确认了也不建
    assert.deepEqual(ids({ name: '虚构纸箱-甲', ...box, length: 30, width: 20, height: 15, dimensionUnit: 'cm' }), { code: [], same: [full.id], name: [bare.id] });
    assert.throws(() => assertNewProductAllowed(store, { name: '虚构纸箱甲', ...box }, true), /尺寸、材质都相同的产品：虚构纸箱 甲（300 × 200 × 150 mm \/ K=A \/ BC，已归档）/);
    // 3. 同名、尺寸不同：没确认拦下并列出已有的同名产品，确认了放行
    const bigger = { name: '虚构纸箱甲', ...box, length: 400 };
    assert.deepEqual(ids(bigger), { code: [], same: [], name: [full.id, bare.id] });
    assert.throws(
      () => assertNewProductAllowed(store, bigger, false),
      (e: unknown) => e instanceof AppError && e.code === 'same-name-product' && /虚构纸箱 甲（300 × 200 × 150 mm \/ K=A \/ BC，已归档）；虚构纸箱甲（没写尺寸材质）/.test(e.message),
    );
    assert.equal(assertNewProductAllowed(store, bigger, true).sameName.length, 2);
    // 没写全的说不上相同，也按第 3 条确认
    assert.deepEqual(ids({ name: '虚构纸箱甲' }), { code: [], same: [], name: [full.id, bare.id] });
    assert.deepEqual(ids({ name: '虚构纸箱乙' }), { code: [], same: [], name: [] });
    assert.deepEqual(ids({ name: '', customerProductCode: null }), { code: [], same: [], name: [] });
  } finally {
    store.close();
  }
});

test('同一张订单两行新建同名产品：资料完全一样的合成一个、不用确认；资料不一样的各自确认', () => {
  const store = new Store(':memory:');
  try {
    const field = (value: string | null) => ({ ...blankField(), value });
    const workspace = (id: string, lines: Record<string, string>[]): ImportWorkspaceView => {
      const header: Record<string, string> = { buyerName: '虚构新客户' + id, orderDate: '2026-11-01', deliveryDate: '2026-11-10', currency: 'CNY' };
      const draft = orderDraftSchema.parse({
        header: Object.fromEntries(headerFields.map((k) => [k, field(header[k] ?? null)])),
        lines: lines.map((l, i) => ({ id: '00000000-0000-4000-8000-00000000000' + (i + 1), fields: Object.fromEntries(lineFields.map((k) => [k, field(l[k] ?? null)])) })),
        warnings: [],
      });
      const products = Object.fromEntries(draft.lines.map((l) => [l.id, { mode: 'new' as const }]));
      return { id, fileHash: 'h-' + id, fileName: id + '.xlsx', revision: 1, size: 1, createdAt: '2026-11-01', parsed: { format: 'xlsx' }, draft, evaluation: evaluateDraft(draft), mode: 'order', changes: [], canUndo: false, mapping: { customer: { mode: 'new' }, products, roundingPolicy: 'exact-cents' } };
    };
    const line = (extra: Record<string, string> = {}) => ({ productName: '虚构双胞箱', quantity: '100', unit: '只', unitPrice: '1.5', length: '300', width: '200', height: '150', dimensionUnit: 'mm', material: 'K=A', flute: 'BC', ...extra });
    const same = importPlan(store, workspace('a', [line(), line({ quantity: '50' })]));
    assert.deepEqual(same.confirmations, []);
    const [firstRef, secondRef] = same.products;
    assert.ok(firstRef && secondRef && 'key' in firstRef && 'key' in secondRef);
    assert.equal(firstRef.key, secondRef.key, '执行时按 key 只建一个');
    const differ = importPlan(store, workspace('b', [line(), line({ length: '400' })]));
    assert.deepEqual(differ.confirmations.map((c) => [c.line, c.existing.length]), [[1, 1], [2, 1]]);
    assert.match(differ.confirmations[0].existing[0], /^本单第 2 行：虚构双胞箱（400 × 200 × 150 mm/);
  } finally {
    store.close();
  }
});
