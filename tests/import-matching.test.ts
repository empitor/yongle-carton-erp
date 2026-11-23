// 识别导入的对应和正式导入走流程：编辑后选择按项失效、刷新保留、预览只复用已有档案、相近产品要人确认、归档的不能导。
// 候选规则本身在 import-candidates.test.ts。
import { sales } from '../server/sales/index.js';
import { REPEAT_ORDER_REASON, emptyImportMapping, productCandidatesForLine } from '../shared/import/import-matching.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { orderSchema, productSchema } from '../shared/core/domain.js';
import { lineFields, type LineField, type OrderDraft } from '../shared/import/order-draft.js';
import { draftFromForm, orderFormSchema } from '../shared/import/order-form.js';
import { matchDraft } from '../server/import/matching.js';
import { standardOrderDraft } from '../server/import/standard-order.js';
import { testImports } from './order-import-fixture.js';
import { createOrderWorkflowFixture, workflowAnalysis } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { actor as baseActor, grant } from './actor-fixture.js';

const actor = { ...baseActor, permissions: grant('business:edit', 'import:execute') };

const draft = (): OrderDraft => {
  const a = draftFromForm(orderFormSchema.parse(workflowAnalysis()));
  return {
    header: a.header,
    lines: a.lines.map((fields) => ({ id: randomUUID(), fields })),
    warnings: [],
  };
};

const knownLine = (d: OrderDraft) => {
  const f = d.lines[0].fields;
  const values: Partial<Record<LineField, string>> = {
    productName: '虚构匹配纸箱',
    specification: '300×200×150 mm',
    length: '300',
    width: '200',
    height: '150',
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
  };
  for (const key of lineFields) {
    const value = values[key];
    if (value !== undefined) f[key].value = value;
  }
  return d.lines[0];
};

function requiredDraft(w: { draft: OrderDraft | null }) {
  assert.ok(w.draft, '工作区应有识别结果');
  return w.draft;
}

async function recognized(f: ReturnType<typeof createOrderWorkflowFixture>) {
  const w = (await f.imports.upload(imageFixture(), '虚构匹配测试.png')).workspace;
  return f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, actor);
}

test('人工与AI草稿编辑共用按项失效；刷新保留选择与失效原因，不重新识别', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const c = sales(f.store).customers()[0];
    const p = sales(f.store).createProduct(productSchema.parse({ name: '虚构既有产品' }));
    const recognizedDraft = requiredDraft(w);
    const mapping = emptyImportMapping(recognizedDraft);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    for (const l of recognizedDraft.lines)
      mapping.products[l.id] = { mode: 'existing', id: p.id, version: p.version };
    w = f.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, actor);
    const savedDraft = requiredDraft(w);
    const a = savedDraft.lines[0].id,
      b = savedDraft.lines[1].id;
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [{ op: 'set-line', lineId: a, field: 'notes', value: '无关备注', reason: '测试' }],
      },
      'manual',
      actor,
    );
    assert.deepEqual(w.mapping, mapping);
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [{ op: 'set-line', lineId: a, field: 'productName', value: '虚构变更产品', reason: '测试' }],
      },
      'ai',
      actor,
    );
    assert.equal(w.mapping?.products[a].mode, 'pending');
    assert.equal(w.mapping?.products[b].mode, 'existing');
    const reopened = testImports({ directory: join(f.dir, 'imports'), settings: f.settings });
    try {
      const restored = reopened.get(w.id);
      assert.equal(restored.id, w.id);
      assert.equal(restored.fileHash, w.fileHash);
      assert.ok(restored.mappingInvalidated);
      assert.match(restored.mappingInvalidated.products[a], /重新选择/);
      assert.equal(restored.mapping?.products[b].mode, 'existing');
    } finally {
      reopened.close();
    }
    assert.equal(f.recognitionCalls(), 1);
    assert.equal(sales(f.store).orders().length, 0);
    await assert.rejects(
      f.execution.preview(w.id, { expectedRevision: w.revision }, actor),
      /原产品选择已失效/,
    );
    const currentMapping = w.mapping;
    assert.ok(currentMapping);
    w = f.imports.mapping(
      w.id,
      {
        expectedRevision: w.revision,
        mapping: {
          ...currentMapping,
          products: {
            ...currentMapping.products,
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
    const c = sales(f.store).customers()[0];
    const recognizedDraft = requiredDraft(w);
    const products = recognizedDraft.lines.map((l) =>
      sales(f.store).createProduct(productSchema.parse({ name: l.fields.productName.value })),
    );
    const mapping = emptyImportMapping(recognizedDraft);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    recognizedDraft.lines.forEach(
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
    assert.equal(sales(f.store).orders().length, 0);
    assert.equal(sales(f.store).products().length, 2);
    const readonly = matchDraft(f.store, w);
    assert.equal(readonly.customerResolution.customer?.id, c.id);
    const preview = await f.execution.preview(w.id, { expectedRevision: w.revision }, actor);
    const result = await f.execution.execute(
      w.id,
      { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true },
      actor,
    );
    const order = sales(f.store).order(result.orderId);
    assert.ok(order);
    assert.equal(order.customerId, c.id);
    assert.equal(sales(f.store).orders().length, 1);
    assert.equal(sales(f.store).products().length, 2);
    assert.equal(f.recognitionCalls(), 1);
    await f.execution.execute(w.id, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true }, actor);
    assert.equal(sales(f.store).orders().length, 1);
  } finally {
    f.close();
  }
});

test('本客户以前订过的同名同规格产品，正式预览直接关联，不再逐个确认', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const w = await recognized(f);
    const c = sales(f.store).customers()[0];
    const recognizedDraft = requiredDraft(w);
    const products = recognizedDraft.lines.map((l) =>
      sales(f.store).createProduct(productSchema.parse({ name: l.fields.productName.value })),
    );
    await assert.rejects(
      f.execution.preview(w.id, { expectedRevision: w.revision }, actor),
      /已找到产品候选/,
      '只有名字一样、没订过，还是要问',
    );
    sales(f.store).saveOrder(
      orderSchema.parse({
        customerId: c.id,
        orderDate: '2026-01-05',
        deliveryDate: '2026-01-20',
        status: '已确认',
        lines: recognizedDraft.lines.map((l, i) => ({
          productId: products[i].id,
          specification: l.fields.specification.value,
          quantity: 10,
          unitPriceCents: 100,
          unit: '只',
        })),
      }),
    );
    const matched = matchDraft(f.store, w);
    assert(recognizedDraft.lines.every((l) => matched.productCandidates[l.id][0].recommended));
    // 识别结果页拿同一份客户历史、用同一个规则算，和正式预览结论一样
    assert.equal(matched.customerHistory?.customerId, c.id);
    assert.ok(matched.customerHistory);
    for (const l of recognizedDraft.lines) {
      const local = productCandidatesForLine(l, matched.products, matched.customerHistory.specs);
      assert.deepEqual(local, matched.productCandidates[l.id]);
      assert(local[0].reasons.includes(REPEAT_ORDER_REASON));
    }
    const preview = await f.execution.preview(w.id, { expectedRevision: w.revision }, actor);
    assert.deepEqual(
      preview.plan.products.map((p) => {
        assert.ok(p.mode === 'existing');
        return [p.mode, p.id];
      }),
      products.map((p) => ['existing', p.id]),
    );
    assert.equal(sales(f.store).products().length, 2);
    // 已关联的老产品看档案里的资料：档案全的不提示“资料可后续补充”“尺寸单位待确认”
    const full = sales(f.store).createProduct(
      productSchema.parse({ name: '虚构资料全的箱', length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: 'K=A', flute: 'BC' }),
    );
    const fullMapping = emptyImportMapping(recognizedDraft);
    fullMapping.customer = { mode: 'existing', id: c.id, version: c.version };
    for (const l of recognizedDraft.lines) fullMapping.products[l.id] = { mode: 'existing', id: full.id, version: full.version };
    const standard = standardOrderDraft(f.store, { ...w, mapping: fullMapping });
    assert.ok(standard);
    assert.deepEqual(standard.notices.filter((s) => /可后续补充|尺寸单位待确认/.test(s)), []);
    assert.ok(w.evaluation);
    assert.equal(w.evaluation.issues.some((i) => /可后续补充|尺寸单位待确认/.test(i.message)), false, '识别结果不按原件的字另算一遍');
  } finally {
    f.close();
  }
});

test('选了新建的照办，不要求“用户原话说过”：方案列出会新建的产品和相近的已有档案（归档的也算），同名的人确认后才建', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const c = sales(f.store).customers()[0];
    const old = sales(f.store).createProduct(productSchema.parse({ name: '聊天纸箱甲', material: 'K=A', flute: 'BC' }));
    const stopped = sales(f.store).createProduct(productSchema.parse({ name: '聊天纸箱甲', length: 400, width: 300, height: 200, dimensionUnit: 'mm', material: '牛卡', flute: 'B' }));
    f.store.markArchived('products', stopped.id, 'fixture');
    const recognizedDraft = requiredDraft(w);
    const mapping = emptyImportMapping(recognizedDraft);
    mapping.customer = { mode: 'existing', id: c.id, version: c.version };
    for (const l of recognizedDraft.lines) mapping.products[l.id] = { mode: 'new' };
    w = f.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, actor);
    const preview = await f.execution.preview(w.id, { expectedRevision: w.revision }, actor);
    const [first, second] = preview.plan.products;
    assert.equal(first.mode, 'new');
    assert.ok(first.mode === 'new' && second.mode === 'new');
    assert.ok(first.similar.some((s) => s.includes('聊天纸箱甲')), '相近的已有档案列出来给人看');
    assert.deepEqual(second.similar, []);
    assert.deepEqual(preview.plan.confirmations.map((x) => x.line), [1]);
    assert.ok(preview.plan.confirmations[0].existing.includes('聊天纸箱甲（400 × 300 × 200 mm / 牛卡 / B，已归档）'), '归档的同名也算，写全尺寸材质');
    await assert.rejects(
      f.execution.execute(w.id, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true }, actor),
      /已有同名产品/,
      '同名的没确认不建',
    );
    await f.execution.execute(
      w.id,
      { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true, distinctProducts: [requiredDraft(w).lines[0].id] },
      actor,
    );
    assert.equal(sales(f.store).products().filter((p) => p.name === '聊天纸箱甲').length, 2);
    assert.ok(sales(f.store).product(old.id));
  } finally {
    f.close();
  }
});

test('正式预览也读取同一候选规则，尺寸相同但名称不同不能默默新建重复产品', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const line = requiredDraft(w).lines[0],
      known = knownLine(draft());
    sales(f.store).createProduct(
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
    assert.equal(sales(f.store).products().length, 1);
    assert.equal(sales(f.store).orders().length, 0);
  } finally {
    f.close();
  }
});

test('已归档的识别文件不能导入：先出了预览再归档，重新预览和执行都拒收；恢复后能导', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = await recognized(f);
    const early = await f.execution.preview(w.id, { expectedRevision: w.revision }, actor);
    f.imports.changeArchive({ action: 'archive', items: [{ id: w.id, version: w.revision }] }, actor);
    w = f.imports.get(w.id);
    await assert.rejects(f.execution.preview(w.id, { expectedRevision: w.revision }, actor), /已归档，先恢复再导入/);
    await assert.rejects(f.execution.execute(w.id, { expectedRevision: early.plan.source.revision, previewDigest: early.previewDigest, acknowledged: true }, actor));
    assert.equal(sales(f.store).orders().length, 0, '没有导进去');
    f.imports.changeArchive({ action: 'restore', items: [{ id: w.id, version: w.revision }] }, actor);
    w = f.imports.get(w.id);
    const preview = await f.execution.preview(w.id, { expectedRevision: w.revision }, actor);
    await f.execution.execute(w.id, { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true }, actor);
    assert.equal(sales(f.store).orders().length, 1);
  } finally {
    f.close();
  }
});
