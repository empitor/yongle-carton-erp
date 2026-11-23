// 客户、产品候选和选择失效的规则（shared/import/import-matching.ts、客户对应、同一批里的同一产品）：哪些直接对应已有档案，
// 哪些要人选或确认，哪些不拦新建；不走识别流程。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { blocksNewProduct, emptyImportMapping, invalidateImportMapping, productCandidatesForLine, resolveCustomerCandidates } from '../shared/import/import-matching.js';
import { Store } from '../server/core/index.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { blankField, draftLineFieldsSchema, lineFields, type LineField, type OrderDraft } from '../shared/import/order-draft.js';
import { draftFromForm, orderFormSchema } from '../shared/import/order-form.js';
import { resolveImportCustomer } from '../server/import/customer-resolution.js';
import { standardOrderDraft } from '../server/import/standard-order.js';
import { sameProductInBatch } from '../shared/core/product-details.js';
import { workflowAnalysis } from './assistant-workflow-fixture.js';
import { workspaceRecord } from './import-fixtures.js';

type Line = OrderDraft['lines'][number];
type Values = Partial<Record<LineField, string | null>>;

function setFields(fields: Line['fields'], values: Values) {
  for (const key of lineFields) {
    const value = values[key];
    if (value !== undefined) fields[key].value = value;
  }
}

function productRecord(id: number, input: z.input<typeof productSchema>) {
  const date = '2026-01-01T00:00:00.000Z';
  return { ...productSchema.parse(input), id, version: 1, createdAt: date, updatedAt: date };
}

const draft = (): OrderDraft => {
  const a = draftFromForm(orderFormSchema.parse(workflowAnalysis()));
  return {
    header: a.header,
    lines: a.lines.map((fields) => ({ id: randomUUID(), fields })),
    warnings: [],
  };
};

const knownLine = (d: OrderDraft) => {
  setFields(d.lines[0].fields, {
    productName: '虚构匹配纸箱',
    specification: '300×200×150 mm',
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
  });
  return d.lines[0];
};

test('客户完全一致或只差排版唯一解析，同名及唯一相似均只返回候选，不新建或合并；已归档的单独说', () => {
  const store = new Store(':memory:');
  try {
    const c = sales(store).createCustomer(
      customerSchema.parse({ name: '虚构精确客户有限公司', contact: '张甲' }),
    );
    assert.equal(resolveImportCustomer(store, c.name).customer?.id, c.id);
    assert.equal(resolveImportCustomer(store, '虚构精确客户').state, 'resolved', '只差公司后缀就并入');
    assert.equal(sales(store).customers().length, 1);
    const spaced = sales(store).createCustomer(customerSchema.parse({ name: '虚构 晨星（宁波）有限公司' }));
    assert.equal(resolveImportCustomer(store, '虚构晨星(宁波)有限公司').customer?.id, spaced.id, '空格、全半角括号不算不同');
    const twin = sales(store).createCustomer(customerSchema.parse({ name: c.name, contact: '李乙' }));
    const same = resolveImportCustomer(store, c.name);
    assert.equal(same.state, 'ambiguous');
    assert.deepEqual(new Set(same.candidates.map((x) => x.id)), new Set([c.id, twin.id]));
    const archived = sales(store).createCustomer(customerSchema.parse({ name: '虚构归档客户有限公司' }));
    store.db
      .prepare('INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)')
      .run('customers', archived.id, '2026-11-01T00:00:00.000Z', 'fictional-user');
    assert.equal(resolveImportCustomer(store, archived.name).state, 'archived');
  } finally {
    store.close();
  }
});

test('产品候选以名称及明确单位尺寸比较，多候选不消歧，未知单位和冲突不推荐', () => {
  const store = new Store(':memory:');
  try {
    const p = sales(store).createProduct(
      productSchema.parse({
        name: '虚构匹配纸箱',
        length: 30,
        width: 20,
        height: 15,
        dimensionUnit: 'cm',
        material: '牛卡',
        flute: 'B',
      }),
    );
    const d = draft(),
      line = knownLine(d);
    assert.equal(productCandidatesForLine(line, [p])[0].recommended, true);
    line.fields.specification.value = '300×200×150';
    line.fields.length.value = '30';
    line.fields.width.value = '20';
    line.fields.height.value = '15';
    line.fields.dimensionUnit.value = 'cm';
    assert.equal(productCandidatesForLine(line, [p])[0].recommended, true);
    const noDimensions = structuredClone(line);
    for (const k of ['length', 'width', 'height'] as const) noDimensions.fields[k].value = null;
    noDimensions.fields.dimensionUnit.value = 'mm';
    assert.equal(productCandidatesForLine(noDimensions, [p])[0].recommended, true);
    noDimensions.fields.dimensionUnit.value = 'cm';
    assert.equal(productCandidatesForLine(noDimensions, [p])[0].recommended, false);
    noDimensions.fields.specification.value = '9'.repeat(400) + '×20×15 cm';
    assert.equal(productCandidatesForLine(noDimensions, [p])[0].recommended, false);
    noDimensions.fields.length.value = '错误';
    assert.equal(productCandidatesForLine(noDimensions, [p])[0].recommended, false);
    line.fields.length.value = '300';
    line.fields.width.value = '200';
    line.fields.height.value = '150';
    line.fields.dimensionUnit.value = '英寸';
    assert.equal(productCandidatesForLine(line, [p])[0].recommended, false);
    line.fields.dimensionUnit.value = 'mm';
    line.fields.length.value = '301';
    assert.equal(productCandidatesForLine(line, [p])[0].recommended, false);
    line.fields.length.value = '300';
    const twin = sales(store).createProduct(productSchema.parse({ ...p, name: p.name }));
    assert.equal(productCandidatesForLine(line, [p, twin]).filter((c) => c.recommended).length, 2);
    const unrelated = sales(store).createProduct(
      productSchema.parse({ name: '完全不同产品', material: '牛卡', flute: 'B' }),
    );
    assert.equal(productCandidatesForLine(line, [unrelated]).length, 0);
  } finally {
    store.close();
  }
});

test('已匹配但材质楞型缺失只提示资料不完整，正式投影不报匹配失败', () => {
  const store = new Store(':memory:');
  try {
    const p = sales(store).createProduct(
      productSchema.parse({
        name: '虚构匹配纸箱',
        length: 300,
        width: 200,
        height: 150,
        dimensionUnit: 'mm',
      }),
    );
    const d = draft();
    knownLine(d);
    const c = sales(store).createCustomer(customerSchema.parse({ name: d.header.buyerName.value }));
    const mapping = emptyImportMapping(d);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    for (const l of d.lines)
      mapping.products[l.id] = { mode: 'existing', id: p.id, version: p.version };
    const candidate = productCandidatesForLine(d.lines[0], [p])[0];
    assert.equal(candidate.recommended, true);
    assert.deepEqual(candidate.missing, ['材质', '楞型']);
    const workspace = workspaceRecord({ id: randomUUID(), fileHash: '虚构', revision: 1, draft: d, mapping });
    const projected = standardOrderDraft(store, workspace);
    assert.ok(projected);
    assert.equal(projected.fields.lines[0].productId, p.id);
    assert(!projected.issues.some((x) => /匹配失败|产品尚未选择/.test(x)));
    assert(projected.notices.some((x) => x.includes('材质') && x.includes('楞型')));
  } finally {
    store.close();
  }
});

test('无关字段及等值单位转换保留匹配，关键字段只使对应客户或产品失效', () => {
  const before = draft();
  knownLine(before);
  const mapping = emptyImportMapping(before);
  mapping.customer = { mode: 'existing', id: 1, version: 1 };
  for (const l of before.lines) mapping.products[l.id] = { mode: 'existing', id: 2, version: 1 };
  const unrelated = structuredClone(before);
  unrelated.header.notes.value = '普通备注';
  unrelated.lines[0].fields.quantity.value = '200';
  unrelated.lines[0].fields.unitPrice.value = '2.00';
  assert.deepEqual(invalidateImportMapping(mapping, before, unrelated).mapping, mapping);
  const converted = structuredClone(before);
  Object.assign(converted.lines[0].fields.dimensionUnit, { value: 'cm' });
  setFields(converted.lines[0].fields, { length: '30', width: '20', height: '15' });
  assert.deepEqual(invalidateImportMapping(mapping, before, converted).mapping, mapping);
  const renamed = structuredClone(before);
  renamed.lines[0].fields.specification.value = '不同规格';
  const changed = invalidateImportMapping(mapping, before, renamed);
  assert.equal(changed.mapping?.customer.mode, 'existing');
  assert.equal(changed.mapping?.products[before.lines[0].id].mode, 'pending');
  assert.equal(changed.mapping?.products[before.lines[1].id].mode, 'existing');
  assert.match(changed.invalidated.products[before.lines[0].id], /原产品选择已失效/);
  renamed.header.buyerName.value = '新名称';
  const customer = invalidateImportMapping(mapping, before, renamed).invalidated.customer;
  assert.ok(customer);
  assert.match(customer, /原客户选择已失效/);
});

test('名称相近的客户：只差后缀并入，错别字问一下，不静默新建', () => {
  const list = [
    { id: 1, name: '宁波虚构信息科技有限公司', version: 1, contact: '', phone: '', address: '' },
    { id: 2, name: '上海别的纸业有限公司', version: 1, contact: '', phone: '', address: '' },
  ];
  const state = (n: string) => resolveCustomerCandidates(list, n);
  for (const n of ['宁波虚构信息科技有限公司 ', '宁波虚构信息科技', '宁波虚构信息科技(有限公司)', '宁波虚构信息科技有限公司（盖章）'])
    assert.equal(state(n).customer?.id, 1, n);
  for (const n of ['宁波虚够信息科技有限公司', '宁波虚构科技有限公司', '宁波市虚构信息科技有限公司', '虚构信息科技', '宁波虚构信息技术有限公司']) {
    assert.equal(state(n).state, 'ambiguous', n);
    assert.deepEqual(state(n).candidates.map((c) => c.id), [1], n);
  }
  assert.equal(state('杭州完全不同包装厂').state, 'new');
  // 两家都只差后缀时不能替用户选
  const two = resolveCustomerCandidates([...list, { id: 3, name: '宁波虚构信息科技', version: 1, contact: '', phone: '', address: '' }], '宁波虚构信息科技公司');
  assert.equal(two.state, 'ambiguous');
});

test('名字里的数字不同就不算相近', () => {
  const list = [{ id: 1, name: '虚构纸箱1厂', version: 1, contact: '', phone: '', address: '' }];
  assert.equal(resolveCustomerCandidates(list, '虚构纸箱2厂').state, 'new');
  assert.equal(resolveCustomerCandidates(list, '虚构纸箱1厂有限公司').state, 'resolved');
});

test('本客户老产品：唯一同名候选、以前订过同规格就直接用；多个同名、规格或材质对不上、别的客户订过都还要问', () => {
  const line = (spec: string, material: string | null = null) => {
    const fields = draftFromForm(orderFormSchema.parse(workflowAnalysis())).lines[0];
    fields.productName.value = '虚构老箱';
    fields.specification.value = spec;
    fields.material.value = material;
    return { id: randomUUID(), fields };
  };
  const old = productRecord(1, { name: '虚构老箱', material: '牛卡', flute: '' });
  const history = { 1: ['40x30x20'] };
  const pick = (l: Line, products: Parameters<typeof productCandidatesForLine>[1], h?: Record<number, string[]>) => {
    const result = productCandidatesForLine(l, products, h).find((c) => c.id === 1);
    assert.ok(result);
    return result;
  };
  assert.equal(pick(line('40×30×20'), [old]).recommended, false, '没有本客户的记录还要问');
  assert.equal(pick(line('40×30×20'), [old], history).recommended, true, '同名、以前订过同规格');
  assert.equal(pick(line('40×30×20', '牛卡'), [old], history).recommended, true, '材质也一样');
  assert.equal(pick(line('40×30×20', '白卡'), [old], history).recommended, false, '材质不一样');
  assert.equal(pick(line('50×30×20'), [old], history).recommended, false, '规格不一样');
  assert.equal(pick(line('40×30×20'), [old], { 2: ['40x30x20'] }).recommended, false, '订过的是别的产品');
  const twin = { ...old, id: 2 };
  assert.equal(
    productCandidatesForLine(line('40×30×20'), [old, twin], history).filter((c) => c.recommended).length,
    0,
    '两个同名档案要人选',
  );
});

test('尺寸相同但名称不同的产品不拦新建；同名或尺寸材质楞型都相同才要先确认', () => {
  const c = (...reasons: string[]) =>
    ({ id: 1, name: '虚构', reasons, conflicts: [], recommended: false, missing: [] });
  assert.equal(blocksNewProduct(c('尺寸一致')), false);
  assert.equal(blocksNewProduct(c('规格尺寸一致（单位明确）', '尺寸一致')), false);
  assert.equal(blocksNewProduct(c('尺寸一致', '材质一致')), false);
  assert.equal(blocksNewProduct(c('名称一致')), true);
  assert.equal(blocksNewProduct(c('客户料号一致（需核对客户归属）')), true);
  assert.equal(blocksNewProduct(c('尺寸一致', '材质一致', '楞型一致')), true);
});

test('名称相近的产品：同名同数字并入，名称包含并入，错别字问一下，尺寸不同不混', () => {
  const line = (name: string, dimensions: [string, string, string], unit: string | null, requirements: string | null = null): Line => {
    const [length, width, height] = dimensions;
    const values: Values = {
      productName: name, productCode: null, specification: null, length, width, height,
      dimensionUnit: unit, material: null, flute: null, requirements,
    };
    const fields = draftLineFieldsSchema.parse(Object.fromEntries(lineFields.map((key) => {
      const value = values[key];
      return [key, value === undefined ? blankField() : { value, certainty: 'recognized', note: '' }];
    })));
    return { id: 'x', fields };
  };
  const products = [
    productRecord(1, { name: '虚构方形箱', length: 62, width: 26, height: 9, dimensionUnit: 'cm', requirements: '按虚构文件打印' }),
    productRecord(2, { name: '虚构外箱（双瓦楞）（电商）', length: 71, width: 41, height: 44, dimensionUnit: null }),
    productRecord(3, { name: '虚构彩箱甲（电商）', length: 59, width: 36, height: 8, dimensionUnit: 'cm' }),
    productRecord(4, { name: '虚构彩箱乙（电商）', length: 59, width: 36, height: 8, dimensionUnit: 'cm' }),
  ];
  const auto = (l: Line) => productCandidatesForLine(l, products).filter((c) => c.recommended).map((c) => c.id);
  const blocks = (l: Line) => productCandidatesForLine(l, products).filter(blocksNewProduct).map((c) => c.id);
  assert.deepEqual(auto(line('虚构方形箱', ['62', '26', '9'], 'cm', '另一种写法')), [1], '加工要求不同');
  assert.deepEqual(auto(line('虚构方形箱', ['62', '26', '9'], null)), [1], '这次没写单位');
  assert.deepEqual(auto(line('虚构外箱（双瓦楞）（电商）', ['71', '41', '44'], null)), [2], '都没写单位');
  assert.deepEqual(auto(line('虚构外箱（双瓦楞）（电商）', ['71', '41', '44'], 'cm')), [2], '这次写了单位');
  assert.deepEqual(auto(line('虚构外箱（双瓦楞）', ['71', '41', '44'], null)), [2], '少了后缀');
  assert.deepEqual(auto(line('虚构彩箱甲（电商）', ['59', '36', '8'], 'cm')), [3], '同名优先，同尺寸的另一款不算');
  assert.deepEqual(auto(line('虚构方形相', ['62', '26', '9'], 'cm')), [], '错别字不自动');
  assert.deepEqual(blocks(line('虚构方形相', ['62', '26', '9'], 'cm')), [1], '错别字要问');
  assert.deepEqual(auto(line('虚构方形箱', ['70', '26', '9'], 'cm')), [], '同名不同尺寸不并');
  assert.deepEqual(blocks(line('另一款纸箱', ['59', '36', '8'], 'cm')), [], '同尺寸不同名可以新建');
  assert.deepEqual(auto(line('虚构方形箱', ['620', '260', '90'], 'mm')), [1], '换算后相同');
});

test('同一批导入里的两行：名称尺寸相同、其他不冲突才算同一个产品，加工要求不同不算冲突；缺单位、缺尺寸不猜', () => {
  const box = { name: '虚构邮购盒', length: 88, width: 15, height: 5.5, dimensionUnit: 'cm', material: '', flute: '', requirements: '', customerProductCode: '' };
  assert.equal(sameProductInBatch(box, { ...box, requirements: '按虚构文件打印' }), true);
  assert.equal(sameProductInBatch(box, { ...box, material: 'K=A' }), true, '一边没写不算冲突');
  assert.equal(sameProductInBatch({ ...box, material: 'K=K' }, { ...box, material: 'K=A' }), false);
  assert.equal(sameProductInBatch(box, { ...box, height: 6 }), false);
  assert.equal(sameProductInBatch(box, { ...box, name: '虚构别的盒' }), false);
  assert.equal(sameProductInBatch(box, { ...box, length: 880, width: 150, height: 55, dimensionUnit: 'mm' }), true, '换算后相同');
  assert.equal(sameProductInBatch(box, { ...box, dimensionUnit: null }), false, '一边没单位不猜');
  assert.equal(sameProductInBatch({ ...box, length: null }, { ...box, length: null }), false, '没尺寸不猜');
});

test('名称包含但数字不同、或多出说明文字的，只列候选不自动对应', () => {
  let id = 0;
  {
    const save = (name: string) => productRecord(++id, { name, length: 10, width: 20, height: 30, dimensionUnit: 'cm' });
    const line = (name: string) => {
      const a = draftFromForm(orderFormSchema.parse(workflowAnalysis()));
      const fields = a.lines[0];
      setFields(fields, {
        productName: name,
        specification: '',
        length: '10',
        width: '20',
        height: '30',
        dimensionUnit: 'cm',
        material: '',
        flute: '',
        productCode: '',
      });
      return { id: randomUUID(), fields };
    };
    const one = save('虚构纸箱1');
    const plain = save('虚构纸箱甲');
    const pick = (name: string, p: ReturnType<typeof productRecord>) =>
      productCandidatesForLine(line(name), [p]).find((c) => c.id === p.id);
    assert.equal(pick('虚构纸箱10', one)?.recommended, false, '1 和 10 是两个货');
    assert.equal(pick('虚构纸箱甲加厚', plain)?.recommended, false, '加厚是另一款');
    assert.equal(pick('虚构纸箱甲（虚构渠道）', plain)?.recommended, true, '只差括号说明还是同一个');
  }
});
