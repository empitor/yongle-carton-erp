// 识别导入时原件缺项、币种、数量单位：没写的不编造，人民币各种写法和没写都按人民币，外币拒收要人改，
// 金额对不上、超精度不导。规则在纯函数和服务层测，只留一条经请求走完核对、预览、正式导入。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/db.js';
import { startHttp } from './http-fixture.js';
import { ImportExecutionService } from '../server/import/import-execution.js';
import { projectOrder, standardOrderDraft } from '../server/import/standard-order.js';
import { z } from 'zod';
import { evaluateDraft } from '../shared/import/draft-evaluation.js';
import { draftFromForm, orderFormSchema } from '../shared/import/order-form.js';
import { orderSchema, customerSchema, productSchema } from '../shared/core/domain.js';
import { inspectCurrency } from '../shared/core/currency.js';
import { docxFixture } from './import-fixtures.js';
import { importWorkspace, tempDir } from './order-import-fixture.js';
// 订单保存要单据流转登记的改单核对、进度规则
import '../server/flow/index.js';

/** 模型替身交回的表：明细的格子要能故意填坏（对象、数字）再交给表的结构校验，所以值是 unknown */
type Form = { header: Record<string, string | null>; lines: Record<string, unknown>[] };

/** 原件上只写了最少几栏的订单；空、空字符串、全是空格、完全没填的栏目都有 */
function minimal(currency?: string | null): Form {
  return {
    header: {
      buyerName: '币种兼容客户（虚构）',
      orderDate: '2026-10-25',
      deliveryDate: '2026-11-01',
      ...(currency !== undefined ? { currency } : {}),
      notes: null,
      supplierName: null,
      taxRate: '',
      terms: '   ',
    },
    lines: [{ productName: '缺项纸箱A（虚构）', quantity: '1000', unit: '只', unitPrice: '1.3900', specification: null, notes: null, material: '' }],
  };
}
const importer = pageActor({ id: 'fictional-importer', name: '虚构导入员', permissions: ['business:edit', 'import:execute'] });

/** 经请求拿到的预览：这里要看的几项（比对的值按原样取，不在这里定类型） */
const previewReply = z.object({
  previewDigest: z.string(),
  plan: z.object({
    source: z.object({ revision: z.number() }),
    warnings: z.array(z.string()),
    order: z.object({ currency: z.unknown(), taxMode: z.unknown(), externalPurchaseOrder: z.unknown() }),
    products: z.array(z.object({ input: z.object({ length: z.unknown() }) })),
  }),
});
/** 正式导入的回执：建了哪张订单、这次执行的编号 */
const receiptReply = z.object({ orderId: z.number(), executionId: z.string() });

/** 服务层：识别出 form、能预览和正式导入（不起服务） */
async function imported(form: unknown) {
  const store = new Store(':memory:'),
    archive = tempDir('erp-import-archive-'),
    f = importWorkspace(() => form, { store, archiveDirectory: archive.dir }),
    service = new ImportExecutionService(store, f.manager);
  let w = await f.upload(docxFixture(), '虚构缺项订单.docx');
  w = await f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
  return {
    store,
    manager: f.manager,
    w,
    preview: () => service.preview(w.id, { expectedRevision: f.manager.get(w.id).revision }, importer),
    execute: (p: { previewDigest: string; plan: { source: { revision: number } } }) =>
      service.execute(w.id, { expectedRevision: p.plan.source.revision, previewDigest: p.previewDigest, acknowledged: true }, importer),
    close() {
      f.close();
      store.close();
      archive.remove();
    },
  };
}

test('币种：人民币的各种写法和没写都按人民币；外币、混合币种、类型不对都拒收', () => {
  const base = { customerId: 1, orderDate: '2026-10-25', deliveryDate: '2026-11-01', status: '已确认', lines: [{ productId: 1, quantity: 1000, unitPriceCents: 139 }] };
  for (const currency of ['CNY', 'cny', 'RMB', ' rmb ', '人民币', '人民币元', '元', '¥', '￥', 'CN¥', 'RMB ￥', '人民币（CNY）', 'RMB/¥', null, undefined, '', '  ', '未注明'])
    assert.equal(orderSchema.parse({ ...base, currency }).currency, 'CNY', String(currency));
  for (const currency of ['USD', '美元', 'US$', '$', 'EUR', '欧元', 'JPY', '日元', '港币', 'CNY/USD', '人民币/美元', 'JPY¥', '未知币种XYZ', 123, false, {}]) {
    assert.equal(orderSchema.safeParse({ ...base, currency }).success, false, JSON.stringify(currency));
    assert.equal(inspectCurrency(currency).currency, null);
  }
});

test('订单结构：没写的附加栏目留空不编造；状态、舍入、行备注类型不对拒收，行交期早于下单日拒收', () => {
  const base = { customerId: 1, orderDate: '2026-10-25', deliveryDate: '2026-11-01', status: '已确认', lines: [{ productId: 1, quantity: 1000, unitPriceCents: 139, unitPriceExact: '1.3900' }] };
  const order = orderSchema.parse(base);
  assert.equal(order.notes, '');
  assert.equal(order.costs, null);
  assert.equal(order.lines[0].specification, '');
  assert.equal(orderSchema.safeParse({ ...base, status: '模型批准' }).success, false);
  assert.equal(orderSchema.safeParse({ ...base, roundingPolicy: '自动舍入' }).success, false);
  assert.equal(orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], notes: 12 }] }).success, false);
  for (const unitPriceExact of [null, '', '   ', undefined])
    assert.equal(orderSchema.parse({ ...base, lines: [{ ...base.lines[0], unitPriceExact }] }).lines[0].unitPriceExact, undefined);
  assert.equal(orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], deliveryDate: '2020-01-01' }] }).success, false);
  assert.equal(orderSchema.safeParse({ ...base, lines: [{ ...base.lines[0], deliveryDate: '' }] }).success, true);
  assert.equal(customerSchema.parse({ name: '虚构客户', contact: null }).contact, '');
  assert.equal(productSchema.parse({ name: '虚构产品', material: null, flute: null, requirements: null }).material, '');
});

test('表上没填的栏目是“原件未提供”，不编造业务值；栏目类型不对拒收，数字转成文字', () => {
  const parsed = draftFromForm(orderFormSchema.parse(minimal()));
  assert.equal(parsed.header.currency.value, null);
  assert.equal(parsed.header.notes.value, null);
  assert.equal(parsed.header.terms.value, null, '全是空格算没填');
  assert.equal(parsed.lines[0].length.value, null);
  assert.equal(parsed.lines[0].notes.certainty, 'needs-review');
  assert.equal(parsed.lines[0].productName.certainty, 'recognized');
  assert.deepEqual(parsed.warnings, []);
  const bad = minimal();
  bad.lines[0].quantity = { value: '1000' };
  assert.equal(orderFormSchema.safeParse(bad).success, false);
  const numeric = minimal();
  numeric.lines[0].quantity = 1000;
  assert.equal(draftFromForm(orderFormSchema.parse(numeric)).lines[0].quantity.value, '1000');
});

test('经请求导入：外币被拒、中文说明；改成没写币种后按人民币导入并提醒，单位“个”记成“只”，税口径记“未明确”；重放同一预览不重复建单', async () => {
  const form = minimal('USD');
  form.lines[0].unit = '个';
  const store = new Store(':memory:'),
    archive = tempDir('erp-import-http-'),
    f = importWorkspace(() => form, { store, archiveDirectory: archive.dir }),
    h = await startHttp(store, { aiSettings: f.settings, imports: f.manager, execution: new ImportExecutionService(store, f.manager) });
  const request = (path: string, body: unknown) => h.send('/ai/imports/' + path, body, h.cookie, { headers: { 'X-ERP-AI-Token': f.settings.csrfToken } });
  try {
    let w = await f.upload(docxFixture(), '虚构缺项订单.docx');
    w = await f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false });
    const refused = await request(w.id + '/preview', { expectedRevision: w.revision });
    assert.equal(refused.status, 400);
    const error = z.object({ message: z.string() }).parse(await refused.json());
    assert.match(error.message, /原币种.*无法自动转换/);
    assert.doesNotMatch(error.message, /Invalid input|expected/);
    assert.equal(store.orders().length, 0);
    w = f.manager.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-header', field: 'currency', value: '', reason: '虚构核对：原件没写币种' }],
    });
    const res = await request(w.id + '/preview', { expectedRevision: w.revision }),
      previewBody: unknown = await res.json();
    assert.equal(res.status, 200, JSON.stringify(previewBody));
    const preview = previewReply.parse(previewBody);
    assert.equal(preview.plan.order.currency, 'CNY');
    assert.ok(preview.plan.warnings.some((s) => s.includes('默认保存')));
    assert.equal(preview.plan.order.taxMode, '未明确', '不默认含税');
    assert.equal(preview.plan.order.externalPurchaseOrder, '');
    assert.equal(preview.plan.products[0].input.length, null);
    const result = await request(w.id + '/execute', { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true }),
      receiptBody: unknown = await result.json();
    assert.equal(result.status, 200, JSON.stringify(receiptBody));
    const receipt = receiptReply.parse(receiptBody);
    const order = store.order(receipt.orderId);
    assert.ok(order, '建了订单');
    assert.equal(order.currency, 'CNY');
    assert.equal(order.lines[0].unit, '只');
    assert.equal(order.lines[0].unitPriceExact, '1.3900');
    assert.equal(order.totalAmountExact, '1390.0000');
    assert.equal(order.lines[0].notes, '');
    const replay = await request(w.id + '/execute', { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true });
    assert.equal(replay.status, 200);
    assert.equal(receiptReply.parse(await replay.json()).executionId, receipt.executionId);
    assert.equal(store.orders().length, 1);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await h.close();
    f.close();
    store.close();
    archive.remove();
  }
});

test('没写数量单位的明细按“只”导入', async () => {
  const form = minimal('RMB');
  form.lines[0].unit = null;
  const f = await imported(form);
  try {
    const receipt = await f.execute(await f.preview());
    assert.equal(f.store.order(receipt.orderId)?.lines[0].unit, '只');
  } finally {
    f.close();
  }
});

test('新建和已有档案都在预览前汇总所有缺项和错误，不重复；预览被拒，识别结果和原件保留、不留半截记录', async () => {
  const data = minimal('USD');
  data.header.orderDate = null;
  data.header.deliveryDate = null;
  data.lines[0].quantity = null;
  data.lines[0].unitPrice = null;
  // 没写单位按“只”不算错；写了别的单位（箱）才要人换算
  data.lines[0].unit = '箱';
  const f = await imported(data);
  try {
    for (const existing of [false, true]) {
      let w = f.manager.get(f.w.id);
      assert.ok(w.draft, '有识别结果');
      const lineId = w.draft.lines[0].id;
      if (existing) {
        const c = f.store.saveCustomer(customerSchema.parse({ name: '币种兼容客户（虚构）' }));
        const p = f.store.saveProduct(productSchema.parse({ name: '缺项纸箱A（虚构）' }));
        w = { ...w, mapping: { customer: { mode: 'existing', id: c.id, version: c.version }, products: { [lineId]: { mode: 'existing', id: p.id, version: p.version } }, roundingPolicy: 'exact-cents' } };
      } else w = { ...w, mapping: { customer: { mode: 'new' }, products: { [lineId]: { mode: 'new' } }, roundingPolicy: 'exact-cents' } };
      const check = standardOrderDraft(f.store, w);
      assert.ok(check, '有标准订单的核对结果');
      const issues = check.issues;
      for (const label of ['币种', '订单日期', '交货日期', '数量', '单价', '数量单位'])
        assert.ok(issues.join('；').includes(label), label + ':' + issues.join('；'));
      assert.equal(new Set(issues).size, issues.length);
    }
    await assert.rejects(f.preview());
    assert.equal(f.store.orders().length, 0);
    assert.ok(f.manager.get(f.w.id).draft);
  } finally {
    f.close();
  }
});

test('多明细各自的税率、口径、交期和规格照原件落库，普通编辑不丢', async () => {
  const data = minimal('RMB');
  Object.assign(data.lines[0], { taxRate: '13%', taxMode: '含税', deliveryDate: '2026-11-01', specification: '产品A规格', notes: '防潮包装' });
  data.lines.push({ productName: '缺项纸箱B（虚构）', quantity: '2000', unit: '只', unitPrice: '0.7300', taxRate: '13', taxMode: '含税', deliveryDate: '2026-11-03', notes: '分批交货' });
  const f = await imported(data);
  try {
    const receipt = await f.execute(await f.preview());
    let order = f.store.order(receipt.orderId);
    assert.ok(order, '建了订单');
    assert.equal(order.lines.length, 2);
    assert.equal(order.totalAmountExact, '2850.0000');
    assert.equal(order.lines[0].taxRate, '13%');
    assert.equal(order.lines[1].deliveryDate, '2026-11-03');
    assert.equal(order.lines[0].specification, '产品A规格');
    assert.equal(order.lines[1].specification, '');
    const input = orderSchema.parse({ ...order, lines: order.lines.map(({ taxRate: _r, taxMode: _m, deliveryDate: _d, ...rest }) => rest) });
    f.store.saveOrder(input, order.id, order.version);
    order = f.store.order(order.id);
    assert.ok(order, '改后订单还在');
    assert.equal(order.lines[0].taxRate, '13%');
    assert.equal(order.lines[1].deliveryDate, '2026-11-03');
    assert.equal(order.lines[1].taxMode, '含税');
  } finally {
    f.close();
  }
});

test('原件金额和数量×单价对不上、单价超过四位小数、金额不是数：识别结果报错，不能导入', () => {
  const store = new Store(':memory:');
  try {
    for (const patch of [{ statedAmount: '999' }, { unitPrice: '1.23456' }, { statedAmount: 'ABC' }] as Record<string, string>[]) {
      const form = minimal('CNY');
      Object.assign(form.lines[0], patch);
      const d = draftFromForm(orderFormSchema.parse(form)),
        draft = { ...d, lines: d.lines.map((fields, i) => ({ id: 'line-' + i, fields })) };
      if (patch.statedAmount) assert.ok(evaluateDraft(draft).issues.some((i) => i.severity === 'error'), JSON.stringify(patch));
      // 投影成正式订单（standardOrderDraft 有识别结果时就是它，没关联客户产品）
      assert.ok(projectOrder(store, draft, undefined).issues.length > 0, JSON.stringify(patch));
    }
  } finally {
    store.close();
  }
});
