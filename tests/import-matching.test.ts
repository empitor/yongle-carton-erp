import { blocksNewProduct, resolveCustomerCandidates } from '../shared/import-matching.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { customerSchema, productSchema } from '../shared/domain.js';
import {
  emptyImportMapping,
  invalidateImportMapping,
  productCandidatesForLine,
} from '../shared/import-matching.js';
import { analysisSchema, type OrderDraft } from '../shared/order-draft.js';
import { resolveImportCustomer } from '../server/import/customer-resolution.js';
import { matchDraft } from '../server/import/matching.js';
import { standardOrderDraft } from '../server/import/standard-order.js';
import { ImportManager } from '../server/import/manager.js';
import { createOrderWorkflowFixture, workflowAnalysis } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { actor as baseActor } from './assistant-fixture.js';
const actor = { ...baseActor, permissions: ['business:edit', 'import:execute'] };
const draft = (): OrderDraft => {
  const a = analysisSchema.parse(workflowAnalysis());
  return {
    header: a.header,
    lines: a.lines.map((fields) => ({ id: randomUUID(), fields })),
    warnings: [],
  };
};
const knownLine = (d: OrderDraft) => {
  const f = d.lines[0].fields;
  for (const [key, value] of Object.entries({
    productName: '虚构匹配纸箱',
    specification: '300×200×150 mm',
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
  }))
    f[key as keyof typeof f].value = value;
  return d.lines[0];
};
async function recognized(f: ReturnType<typeof createOrderWorkflowFixture>) {
  let w = (await f.imports.upload(imageFixture(), '虚构匹配测试.png')).workspace;
  const a = f.settings.view().active!;
  w = f.imports.consent(w.id, {
    expectedRevision: w.revision,
    accepted: true,
    presetId: a.id,
    endpoint: a.endpoint,
    model: a.model,
    apiStyle: a.apiStyle,
  });
  return f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, actor);
}
test('客户完全一致唯一解析，同名及唯一相似均只返回候选，不新建或合并', () => {
  const store = new Store(':memory:');
  try {
    const c = store.saveCustomer(
      customerSchema.parse({ name: '虚构精确客户有限公司', contact: '张甲' }),
    );
    assert.equal(resolveImportCustomer(store, c.name).customer?.id, c.id);
    assert.equal(resolveImportCustomer(store, '虚构精确客户').state, 'resolved', '只差公司后缀就并入');
    assert.equal(store.customers().length, 1);
    const twin = store.saveCustomer(customerSchema.parse({ name: c.name, contact: '李乙' }));
    const same = resolveImportCustomer(store, c.name);
    assert.equal(same.state, 'ambiguous');
    assert.deepEqual(new Set(same.candidates.map((x) => x.id)), new Set([c.id, twin.id]));
  } finally {
    store.close();
  }
});
test('产品候选以名称及明确单位尺寸比较，多候选不消歧，未知单位和冲突不推荐', () => {
  const store = new Store(':memory:');
  try {
    const p = store.saveProduct(
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
    const twin = store.saveProduct(productSchema.parse({ ...p, name: p.name }));
    assert.equal(productCandidatesForLine(line, [p, twin]).filter((c) => c.recommended).length, 2);
    const unrelated = store.saveProduct(
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
    const p = store.saveProduct(
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
    const c = store.saveCustomer(customerSchema.parse({ name: d.header.buyerName.value }));
    const mapping = emptyImportMapping(d);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    for (const l of d.lines)
      mapping.products[l.id] = { mode: 'existing', id: p.id, version: p.version };
    const candidate = productCandidatesForLine(d.lines[0], [p])[0];
    assert.equal(candidate.recommended, true);
    assert.deepEqual(candidate.missing, ['材质', '楞型']);
    const projected = standardOrderDraft(store, { draft: d, mapping } as any)!;
    assert.equal(projected.fields.lines[0].productId, p.id);
    assert(!projected.issues.some((x) => /匹配失败|产品尚未选择/.test(x)));
    assert(projected.notices.some((x) => x.includes('配纸/材质') && x.includes('类型/楞型')));
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
  for (const [k, v] of Object.entries({ length: '30', width: '20', height: '15' }))
    converted.lines[0].fields[k as 'length'].value = v;
  assert.deepEqual(invalidateImportMapping(mapping, before, converted).mapping, mapping);
  const renamed = structuredClone(before);
  renamed.lines[0].fields.specification.value = '不同规格';
  const changed = invalidateImportMapping(mapping, before, renamed);
  assert.equal(changed.mapping?.customer.mode, 'existing');
  assert.equal(changed.mapping?.products[before.lines[0].id].mode, 'pending');
  assert.equal(changed.mapping?.products[before.lines[1].id].mode, 'existing');
  assert.match(changed.invalidated.products[before.lines[0].id], /原产品选择已失效/);
  renamed.header.buyerName.value = '新名称';
  assert.match(
    invalidateImportMapping(mapping, before, renamed).invalidated.customer!,
    /原客户选择已失效/,
  );
});
test('人工与AI草稿编辑共用按项失效；刷新保留选择与失效原因，不重新识别', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const c = f.store.customers()[0];
    const p = f.store.saveProduct(productSchema.parse({ name: '虚构既有产品' }));
    const mapping = emptyImportMapping(w.draft!);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    for (const l of w.draft!.lines)
      mapping.products[l.id] = { mode: 'existing', id: p.id, version: p.version };
    w = f.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, actor);
    const a = w.draft!.lines[0].id,
      b = w.draft!.lines[1].id;
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [
          { op: 'set-line', lineId: a, field: 'notes', value: '无关备注', reason: '测试' },
        ],
      },
      'manual',
      actor,
    );
    assert.deepEqual(w.mapping, mapping);
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [
          {
            op: 'set-line',
            lineId: a,
            field: 'productName',
            value: '虚构变更产品',
            reason: '测试',
          },
        ],
      },
      'ai',
      actor,
    );
    assert.equal(w.mapping?.products[a].mode, 'pending');
    assert.equal(w.mapping?.products[b].mode, 'existing');
    const reopened = new ImportManager({ directory: join(f.dir, 'imports'), settings: f.settings });
    try {
      const restored = reopened.get(w.id);
      assert.equal(restored.id, w.id);
      assert.equal(restored.fileHash, w.fileHash);
      assert.match(restored.mappingInvalidated!.products[a], /重新选择/);
      assert.equal(restored.mapping?.products[b].mode, 'existing');
    } finally {
      reopened.close();
    }
    assert.equal(f.recognitionCalls(), 1);
    assert.equal(f.store.orders().length, 0);
    await assert.rejects(
      f.execution.preview(w.id, { expectedRevision: w.revision }, actor),
      /原产品选择已失效/,
    );
    w = f.imports.mapping(
      w.id,
      {
        expectedRevision: w.revision,
        mapping: {
          ...w.mapping!,
          products: {
            ...w.mapping!.products,
            [a]: { mode: 'existing', id: p.id, version: p.version },
          },
        },
      },
      actor,
    );
    assert.equal(w.mappingInvalidated?.products[a], undefined);
  } finally {
    f.close();
  }
});
test('匹配保存失败保留原草稿；完整预览与正式导入只复用已有档案且幂等', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const c = f.store.customers()[0];
    const products = w.draft!.lines.map((l) =>
      f.store.saveProduct(productSchema.parse({ name: l.fields.productName.value })),
    );
    const mapping = emptyImportMapping(w.draft!);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    w.draft!.lines.forEach(
      (l, i) =>
        (mapping.products[l.id] = {
          mode: 'existing',
          id: products[i].id,
          version: products[i].version,
        }),
    );
    assert.throws(
      () => f.imports.mapping(w.id, { expectedRevision: w.revision - 1, mapping }, actor),
      /版本|变化/,
    );
    assert.equal(f.imports.get(w.id).mapping, undefined);
    w = f.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, actor);
    assert.equal(f.store.orders().length, 0);
    assert.equal(f.store.products().length, 2);
    const readonly = matchDraft(f.store, w);
    assert.equal(readonly.customerResolution.customer?.id, c.id);
    w = f.imports.confirm(w.id, { expectedRevision: w.revision, acknowledged: true }, actor);
    const preview = await f.execution.preview(w.id, { expectedRevision: w.revision }, actor);
    const result = await f.execution.execute(
      w.id,
      { previewId: preview.id, acknowledged: true },
      actor,
    );
    assert.equal(f.store.order(result.orderId)!.customerId, c.id);
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.store.products().length, 2);
    assert.equal(f.recognitionCalls(), 1);
    await f.execution.execute(w.id, { previewId: preview.id, acknowledged: true }, actor);
    assert.equal(f.store.orders().length, 1);
  } finally {
    f.close();
  }
});
test('正式预览也读取同一候选规则，尺寸相同但名称不同不能默默新建重复产品', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const line = w.draft!.lines[0],
      known = knownLine(draft());
    f.store.saveProduct(
      productSchema.parse({
        name: '虚构另一名称',
        length: 300,
        width: 200,
        height: 150,
        dimensionUnit: 'mm',
        material: '牛卡',
        flute: 'B',
      }),
    );
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: Object.entries(known.fields)
          .filter(([k]) =>
            [
              'productName',
              'specification',
              'length',
              'width',
              'height',
              'dimensionUnit',
              'material',
              'flute',
            ].includes(k),
          )
          .map(([field, v]) => ({
            op: 'set-line',
            lineId: line.id,
            field,
            value: v.value,
            reason: '虚构尺寸',
          })),
      },
      'manual',
      actor,
    );
    await assert.rejects(
      f.execution.preview(w.id, { expectedRevision: w.revision }, actor),
      /已找到产品候选/,
    );
    assert.equal(f.store.products().length, 1);
    assert.equal(f.store.orders().length, 0);
  } finally {
    f.close();
  }
});

test('尺寸相同但名称不同的产品不拦新建；同名或尺寸材质楞型都相同才要先确认', () => {
  const c = (...reasons: string[]) =>
    ({ id: 1, name: '虚构', reasons, conflicts: [], recommended: false, missing: [] }) as any;
  assert.equal(blocksNewProduct(c('尺寸一致')), false);
  assert.equal(blocksNewProduct(c('规格尺寸一致（单位明确）', '尺寸一致')), false);
  assert.equal(blocksNewProduct(c('尺寸一致', '材质一致')), false);
  assert.equal(blocksNewProduct(c('名称一致')), true);
  assert.equal(blocksNewProduct(c('客户料号一致（需核对客户归属）')), true);
  assert.equal(blocksNewProduct(c('尺寸一致', '材质一致', '楞型一致')), true);
});

test('名称相近的客户：只差后缀并入，错别字问一下，不静默新建', () => {
  const list = [
    { id: 1, name: '宁波虚构信息科技有限公司', version: 1, contact: '', phone: '', address: '' },
    { id: 2, name: '上海别的纸业有限公司', version: 1, contact: '', phone: '', address: '' },
  ] as any[];
  const state = (n: string) => resolveCustomerCandidates(list, n);
  for (const n of ['宁波虚构信息科技有限公司 ', '宁波虚构信息科技', '宁波虚构信息科技(有限公司)', '宁波虚构信息科技有限公司（盖章）'])
    assert.equal(state(n).customer?.id, 1, n);
  for (const n of ['宁波虚够信息科技有限公司', '宁波虚构科技有限公司', '宁波市虚构信息科技有限公司', '虚构信息科技', '宁波虚构信息技术有限公司']) {
    assert.equal(state(n).state, 'ambiguous', n);
    assert.deepEqual(state(n).candidates.map((c) => c.id), [1], n);
  }
  assert.equal(state('杭州完全不同包装厂').state, 'new');
  // 两家都只差后缀时不能替用户选
  const two = resolveCustomerCandidates([...list, { id: 3, name: '宁波虚构信息科技', version: 1, contact: '', phone: '', address: '' }] as any, '宁波虚构信息科技公司');
  assert.equal(two.state, 'ambiguous');
});

test('名称相近的产品：同名同数字并入，名称包含并入，错别字问一下，尺寸不同不混', () => {
  const field = (value: any) => ({ value, sources: [], quote: '', certainty: 'recognized', note: '' });
  const line = (name: string, l: any, w: any, h: any, unit: any, requirements: any = null) =>
    ({
      id: 'x',
      fields: {
        productName: field(name), productCode: field(null), specification: field(null),
        length: field(l), width: field(w), height: field(h), dimensionUnit: field(unit),
        material: field(null), flute: field(null), requirements: field(requirements),
      },
    }) as any;
  const products = [
    { id: 1, name: '虚构方形箱', length: 62, width: 26, height: 9, dimensionUnit: 'cm', requirements: '按虚构文件打印', version: 1 },
    { id: 2, name: '虚构外箱（双瓦楞）（电商）', length: 71, width: 41, height: 44, dimensionUnit: null, version: 1 },
    { id: 3, name: '虚构彩箱甲（电商）', length: 59, width: 36, height: 8, dimensionUnit: 'cm', version: 1 },
    { id: 4, name: '虚构彩箱乙（电商）', length: 59, width: 36, height: 8, dimensionUnit: 'cm', version: 1 },
  ] as any[];
  const auto = (l: any) => productCandidatesForLine(l, products).filter((c) => c.recommended).map((c) => c.id);
  const blocks = (l: any) => productCandidatesForLine(l, products).filter(blocksNewProduct).map((c) => c.id);
  assert.deepEqual(auto(line('虚构方形箱', '62', '26', '9', 'cm', '另一种写法')), [1], '加工要求不同');
  assert.deepEqual(auto(line('虚构方形箱', '62', '26', '9', null)), [1], '这次没写单位');
  assert.deepEqual(auto(line('虚构外箱（双瓦楞）（电商）', '71', '41', '44', null)), [2], '都没写单位');
  assert.deepEqual(auto(line('虚构外箱（双瓦楞）（电商）', '71', '41', '44', 'cm')), [2], '这次写了单位');
  assert.deepEqual(auto(line('虚构外箱（双瓦楞）', '71', '41', '44', null)), [2], '少了后缀');
  assert.deepEqual(auto(line('虚构彩箱甲（电商）', '59', '36', '8', 'cm')), [3], '同名优先，同尺寸的另一款不算');
  assert.deepEqual(auto(line('虚构方形相', '62', '26', '9', 'cm')), [], '错别字不自动');
  assert.deepEqual(blocks(line('虚构方形相', '62', '26', '9', 'cm')), [1], '错别字要问');
  assert.deepEqual(auto(line('虚构方形箱', '70', '26', '9', 'cm')), [], '同名不同尺寸不并');
  assert.deepEqual(blocks(line('另一款纸箱', '59', '36', '8', 'cm')), [], '同尺寸不同名可以新建');
  assert.deepEqual(auto(line('虚构方形箱', '620', '260', '90', 'mm')), [1], '换算后相同');
});

test('名字里的数字不同就不算相近', () => {
  const list = [{ id: 1, name: '虚构纸箱1厂', version: 1, contact: '', phone: '', address: '' }] as any[];
  assert.equal(resolveCustomerCandidates(list, '虚构纸箱2厂').state, 'new');
  assert.equal(resolveCustomerCandidates(list, '虚构纸箱1厂有限公司').state, 'resolved');
});
