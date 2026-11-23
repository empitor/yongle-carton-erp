// 来源指纹只含财务用得到的内容（全部是虚构数据，只用内存库）
import { sales } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customerSchema } from '../shared/core/domain.js';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceEventViews } from '../server/finance/events/event-views.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, arrivalDoc, event, setDoc } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { sourceHash, withNumber } from '../server/finance/events/source-fingerprint.js';
import { flowDocumentContent, flowDocumentSchema } from '../shared/business/flow-document.js';
import { financeFingerprint } from '../shared/business/finance-source.js';
import { count } from '../server/core/index.js';

/**
 * 财务不读的字段（[单据, 路径, 值]）：说明、经办记录、出库送达、对方单号、原文数量面积、抄来的订单和采购资料、
 * 算出来的面积金额、纸板的规格说明、完工的操作员和任务。单据 1、2 是送货，3、4 是到货，5、6 是完工单。
 */
const NOISE: [number, string, unknown][] = [
  ...[1, 2, 3, 4, 5, 6].map((id): [number, string, unknown] => [id, '$.notes', '虚构：事后补的备注']),
  [2, '$.address', '虚构地址'],
  [2, '$.confirmedBy', '虚构：换了确认人'],
  [2, '$.shippedBy', '虚构：换了出库人'],
  [2, '$.shippedAt', '2026-01-10T06:00:00.000Z'],
  [2, '$.movements', ['虚构流水-9']],
  [2, '$.allowOverdelivery', true],
  [4, '$.sourceId', '00000000-0000-4000-8000-000000000001'],
  [2, '$.correctionReason', '虚构原因'],
  [2, '$.correctedAt', '2026-01-11T00:00:00.000Z'],
  [2, '$.reversal', { reason: '虚构', by: '虚构', at: '2026-01-11T00:00:00.000Z', movements: [] }],
  [2, '$.cancellation', { reason: '虚构', by: '虚构', at: '2026-01-11T00:00:00.000Z' }],
  [2, '$.lines[0].notes', '虚构：明细备注'],
  [2, '$.lines[0].specification', '虚构：改了规格'],
  [2, '$.lines[0].orderNumber', '虚构订单号-改'],
  [2, '$.lines[0].externalPurchaseOrder', '虚构客户采购单号-改'],
  [2, '$.lines[0].customerProductCode', '虚构客户料号-改'],
  [2, '$.lines[0].height', 120],
  [2, '$.lines[0].amountExact', '100.00'],
  [3, '$.lines[0].statedQuantity', '9'],
  [3, '$.lines[0].statedArea', '1.5'],
  [4, '$.actualTime', '09:30'],
  [4, '$.reference', '虚构供应商单号-改'],
  [4, '$.confirmedBy', '虚构：换了确认人'],
  [4, '$.lines[0].differenceReason', '虚构：差异原因'],
  [4, '$.lines[0].rejectedQuantity', '0.000'],
  [4, '$.lines[0].area', '8.0'],
  [4, '$.lines[0].amount', '100.00'],
  [4, '$.lines[0].purchaseId', 7],
  [4, '$.lines[0].purchaseNumber', '虚构采购单号'],
  [4, '$.lines[0].supplierName', '虚构供应商-抄写'],
  [4, '$.lines[0].item.specification', '虚构：改了规格'],
  [4, '$.lines[0].item.material', '虚构：改了材质'],
  [4, '$.lines[0].item.flute', 'E'],
  [4, '$.lines[0].item.height', 5],
  [4, '$.lines[0].item.notes', '虚构备注'],
  [6, '$.operator', '虚构：换了操作员'],
  [6, '$.taskId', 10],
  [6, '$.productName', '虚构纸箱-改名'],
  [6, '$.movements', ['虚构流水-8']],
];

test('来源指纹只含财务用得到的内容：送货、到货、完工单改了财务不读的字段（说明、经办、对方单号、抄来的资料、算出来的数），财务事件和观察记录都不动；改数量、单价照旧发现', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    const productionDoc = {
      productId: 1,
      finishedStockId: null,
      goodQuantity: '10',
      scrapQuantity: '0',
      operator: '虚构操作员',
      materials: [{ stockId: 1, issued: '10', returned: '0' }],
      notes: '',
    };
    // 1、3、5 留在待处理（可记账、待计算成本），2、4 生成凭证并记账，6 算过成本
    physical(s, 1, 'delivery', '2026-01-10', { ...deliveryDoc('1'), notes: '' });
    physical(s, 2, 'delivery', '2026-01-10', { ...deliveryDoc('1'), notes: '' });
    physical(s, 3, 'arrival', '2026-01-10', { ...arrivalDoc('10'), notes: '' });
    physical(s, 4, 'arrival', '2026-01-10', { ...arrivalDoc('10'), notes: '' });
    physical(s, 5, 'production', '2026-01-10', productionDoc);
    physical(s, 6, 'production', '2026-01-10', productionDoc);
    events.sync(maker);
    for (const source of [2, 4])
      new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
    postDrafts(s);
    s.db.prepare("UPDATE fin_events SET status='costed',version=version+1 WHERE id=?").run(event(s, 6).id);
    const state = () => ({
      events: s.db.prepare('SELECT id,status,version,source_version,source_hash,snapshot FROM fin_events ORDER BY id').all(),
      observed: s.db
        .prepare('SELECT source_kind,source_id,status,event_id FROM fin_source_observations ORDER BY source_kind,source_id')
        .all(),
    });
    const before = state();
    const ids = [1, 2, 3, 4, 5, 6].map((source) => Number(event(s, source).id));
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((source) => event(s, source).status),
      ['ready', 'generated', 'ready', 'generated', 'cost_pending', 'costed'],
    );
    for (const [id, path, value] of NOISE) setDoc(s, id, path, value);
    events.sync(maker);
    assert.deepEqual(state(), before, '只改说明：事件条数、状态、版本、指纹、快照和观察记录都不变');
    assert.deepEqual(
      s.db
        .prepare(
          `SELECT o.source_id FROM fin_source_observations o JOIN flow_documents f ON f.id=cast(o.source_id AS INTEGER)
          WHERE o.source_version<>f.version`,
        )
        .all(),
      [],
      '看到的版本号跟上了，不会每次同步都重扫',
    );
    assert.deepEqual(events.sync(maker), { processed: 0, remaining: false });

    // 改了数量、单价照旧发现：已入账的走“有差异”，没入账的换成新的一条
    setDoc(s, 1, '$.lines[0].quantity', '2');
    setDoc(s, 2, '$.lines[0].quantity', '2');
    setDoc(s, 4, '$.lines[0].unitPrice', '12.00');
    setDoc(s, 5, '$.goodQuantity', '9');
    events.sync(maker);
    assert.equal(event(s, 1).status, 'ready');
    assert.equal(Number(event(s, 1).amount_cents), 20000, '没入账的送货单换成新的一条，金额跟着变');
    assert.equal(event(s, 2).status, 'difference');
    assert.equal(event(s, 4).status, 'difference');
    assert.notEqual(Number(event(s, 5).id), ids[4], '完工单数量变了换成新的一条待计算成本');
    assert.equal(event(s, 5).status, 'cost_pending');
    assert.equal(Number(event(s, 3).id), ids[2], '没改的到货单不动');
    assert.equal(event(s, 6).status, 'costed');
  } finally {
    s.close();
  }
});

test('来源指纹：财务读的照旧发现——按面积计价的纸板长宽，“改了什么”列出来；只改了不在“改了什么”里的（明细关联的产品），说明不叫人去看“改了什么”', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    // 2：按面积计价的到货；3：普通送货
    physical(s, 2, 'arrival', '2026-01-10', {
      supplierId: 1,
      supplierName: '虚构供应商',
      lines: [
        {
          stockId: 1,
          item: { name: '虚构纸板', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' },
          quantity: '10',
          stockedQuantity: '10',
          unitPrice: '2.00',
          priceBasis: 'area',
          taxMode: '未税',
          taxRate: '0',
        },
      ],
    });
    physical(s, 3, 'delivery', '2026-01-10', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ orderLineId: 3, productId: 1, unit: '只', quantity: '1', unitPriceExact: '100.0000', taxMode: '未税', taxRate: '0' }],
    });
    events.sync(maker);
    assert.equal(Number(event(s, 2).amount_cents), 1600, '0.8 m² × 10 张 × 2 元');
    for (const source of [2, 3])
      new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
    postDrafts(s);
    setDoc(s, 2, '$.lines[0].item.length', 1200);
    setDoc(s, 3, '$.lines[0].productId', 2);
    events.sync(maker);
    const changes = (source: number) => {
      const e = event(s, source);
      assert.equal(e.status, 'difference');
      return { problem: String(e.problem), changes: new FinanceEventViews(s).get(maker, e.id).changes };
    };
    const area = changes(2);
    assert.match(area.problem, /改了什么见详情/);
    assert.deepEqual(
      area.changes.find((c) => /：长宽$/.test(c.label)),
      { label: '第 1 行（虚构纸板）：长宽', before: '1000 × 800 mm', after: '1200 × 800 mm' },
    );
    assert.deepEqual(area.changes.find((c) => c.label === '金额'), { label: '金额', before: '16.00 元', after: '19.20 元' });
    const product = changes(3);
    assert.deepEqual(product.changes, [], '关联的产品不在“改了什么”的比较范围里');
    assert.doesNotMatch(product.problem, /改了什么/, '“改了什么”一节不显示，说明就不叫人去看它');
    assert.match(product.problem, /^单据内容改过了，往来单位、日期、金额、数量、单价、税率都没变/);
  } finally {
    s.close();
  }
});

test('记账以后确认送达：送达日期、送达人不算来源改过，同步没有新动静、不多出“有差异”、不卡结账；撤销的单据详情里不出“金额 … → —”', async () => {
  const t = await flowFinance();
  try {
    const d = t.deliver('10');
    t.sync();
    const booked = t.book(d.id, true);
    assert.equal(booked.status, 'generated');
    const count = t.count();
    const delivered = t.f.flow.markDelivered(d.id, { version: t.f.flow.get(d.id).version }, t.admin);
    assert.ok(delivered.deliveredAt, '送货单已送达');
    assert.equal(t.sync(), 0, '确认送达后同步没有要处理的');
    assert.equal(t.count(), count, '不多出事件');
    assert.deepEqual(t.current(d.id), booked, '事件一个字都没动');
    assert.equal(t.differences(), 0, '没有“有差异”');
    assert.equal(t.closingOk(), true, '不卡结账');
    // 撤销以后：单据没变，只是撤销了，“改了什么”什么都不列（金额不比）
    const other = t.deliver('20');
    t.sync();
    t.book(other.id, true);
    t.reverse(other.id);
    t.sync();
    const diff = t.current(other.id);
    assert.equal(diff.status, 'difference');
    assert.match(String(diff.problem), /^单据已撤销/);
    assert.deepEqual(new FinanceEventViews(t.f.store).get(maker, diff.id).changes, [], '只是撤销：不出“金额 … → —”');
  } finally {
    t.f.store.close();
  }
});

test('已入账的送货、到货单：只改说明不多事件、不改状态；更正后财务看到原单“已被更正替代”、替代单是更正单', async () => {
  const t = await flowFinance();
  try {
    const d = t.deliver('10');
    const a = t.receive('6000', '虚构供应商单号-指纹');
    t.sync();
    t.book(d.id, true);
    t.book(a.id, true);
    const before = {
      count: t.count(),
      delivery: t.current(d.id),
      arrival: t.current(a.id),
    };
    assert.equal(before.delivery.status, 'generated');
    assert.equal(before.arrival.status, 'generated');
    // 只改说明（编辑）：送货单、到货单的备注都不进来源指纹
    t.info(d.id, { notes: '管理员补备注' });
    t.info(a.id, { notes: '管理员补备注' });
    assert.equal(t.sync(), 0, '只改备注：没有要处理的');
    assert.equal(t.count(), before.count, '不多出事件');
    assert.deepEqual(t.current(d.id), before.delivery, '送货单的事件一个字都没动');
    assert.deepEqual(t.current(a.id), before.arrival, '到货单的事件一个字都没动');
    // 到货单改数量只有“更正到货单”：原单被替代，财务同样发现，说明写“已被更正替代”，由替代单入账
    t.correctArrival(a.id, '5500');
    t.sync();
    assert.equal(t.current(a.id).status, 'difference');
    assert.match(String(t.current(a.id).problem), /^单据已被更正替代/);
    // 送货单改数量走“更正送货单”：原单同样“已被更正替代”，替代单是一张更正单
    const replacement = t.correct(d.id, { lines: [{ index: 0, quantity: '11' }] });
    t.sync();
    assert.match(String(t.current(d.id).problem), /^单据已被更正替代/);
    assert.equal(t.current(replacement.id).status, 'difference');
    assert.match(String(t.current(replacement.id).problem), /更正单/);
  } finally {
    t.f.store.close();
  }
});

test('单据内容不经程序被直接改动（防篡改的保险）：来源指纹对不上，财务标成“有差异”，说明写“单据内容改过了”，详情列出改前改后', async () => {
  const t = await flowFinance();
  try {
    const d = t.deliver('10');
    t.sync();
    const booked = t.book(d.id, true);
    // 程序里改数量只能走更正（原单撤销、出替代单）；这里直接改库，在原单上把数量改成 12
    t.tamperQuantity(d.id, '12');
    t.sync();
    const diff = t.current(d.id);
    assert.equal(diff.status, 'difference');
    assert.match(String(diff.problem), /^单据内容改过了/);
    const detail = new FinanceEventViews(t.f.store).get(maker, diff.id);
    const labels = detail.changes.map((c) => c.label);
    assert.ok(labels.includes('金额'), '金额变了');
    assert.ok(!labels.some((l: string) => /备注|地址/.test(l)), '说明字段不列');
    const listed = t.listed(diff.id);
    assert.equal(listed.rebuild, 1, '单据还有效：红字冲销后重做');
    assert.equal(listed.previous_voucher_id, booked.voucher_id, '原来那张凭证');
  } finally {
    t.f.store.close();
  }
});

test('单据在原处被程序改了（本机管理员改订单换客户，送货单跟着换）：照旧“单据内容改过了”；改两次由新的一条接手，原来那张凭证沿着链找回来', async () => {
  const { createBusinessService } = await import('../server/orders/index.js');
  const t = await flowFinance();
  try {
    const d = t.deliver('10');
    t.sync();
    const booked = t.book(d.id, true);
    const switchCustomer = (name: string) => {
      const other = sales(t.f.store).createCustomer(customerSchema.parse({ name }));
      const order = sales(t.f.store).order(t.order.id);
      assert.ok(order, '订单还在');
      createBusinessService(t.f.store).execute(
        { entity: 'orders', action: 'update', id: order.id, input: { ...order, customerId: other.id } },
        { source: 'manual-ui', operatorId: t.admin.id, superAdminMode: true, actor: t.admin },
      );
      t.sync();
      return t.current(d.id);
    };
    const first = switchCustomer('虚构换后客户甲');
    assert.equal(first.status, 'difference');
    assert.match(String(first.problem), /^单据内容改过了/);
    assert.equal(t.listed(first.id).previous_voucher_id, booked.voucher_id, '原来那张凭证');
    const second = switchCustomer('虚构换后客户乙');
    assert.notEqual(second.id, first.id, '新的一条接手');
    assert.equal(second.status, 'difference');
    assert.equal(t.listed(second.id).previous_voucher_id, booked.voucher_id, '改了两次也找得到原来那张凭证');
    assert.equal(
      count(t.f.store.db, "SELECT count(*) FROM fin_events WHERE status='difference' AND source_id=?", String(d.id)),
      1,
      '只剩一条要处理的',
    );
  } finally {
    t.f.store.close();
  }
});

test('来源指纹直接算：财务不读的字段、键的先后不影响指纹，数量、日期、状态变了指纹就变；单号补进快照不进指纹', () => {
  const source = { status: 'confirmed', date: '2026-01-20' };
  const hash = (at: typeof source, content: unknown) => sourceHash(at, financeFingerprint('delivery', content));
  const doc = { customerId: 1, notes: '虚构备注', lines: [{ quantity: '2', unitPriceExact: '10.0000', notes: '行备注' }] };
  const base = hash(source, doc);
  assert.equal(hash(source, { ...doc, notes: '改了备注', address: '虚构地址' }), base);
  assert.equal(hash(source, { lines: doc.lines, notes: doc.notes, customerId: 1 }), base, '键的先后不算');
  assert.notEqual(hash(source, { ...doc, lines: [{ ...doc.lines[0], quantity: '3' }] }), base);
  assert.notEqual(hash({ ...source, date: '2026-01-21' }, doc), base);
  assert.notEqual(hash({ ...source, status: 'reversed' }, doc), base);
  assert.deepEqual(withNumber({ a: 1 }, 'FICT-1'), { a: 1, number: 'FICT-1' });
  assert.deepEqual(withNumber({ a: 1 }, null), { a: 1 });
});

test('库里的单据按写入时核对过的内容存：财务按单据结构读出来算的来源指纹，和按库里原文算的一样（读法换了指纹不变）', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('3'));
    physical(s, 2, 'arrival', '2026-01-10', arrivalDoc('10'));
    // 单据流转写入时存的是按库里的单据结构核对后的内容（server/flow/documents/document-store.ts 用 flowDocumentContent）
    for (const [id, kind] of [[1, 'delivery'], [2, 'arrival']] as const) {
      const row = s.db.prepare('SELECT document FROM flow_documents WHERE id=?').get(id);
      assert.ok(row);
      const content = flowDocumentContent(flowDocumentSchema(kind).parse(JSON.parse(String(row.document))));
      businessChanges(s).rewrite(id, content);
    }
    new FinanceEvents(s).sync(maker);
    for (const [id, kind] of [[1, 'delivery'], [2, 'arrival']] as const) {
      const row = s.db.prepare('SELECT status,date,document FROM flow_documents WHERE id=?').get(id);
      assert.ok(row);
      const source = { status: String(row.status), date: String(row.date) };
      assert.equal(event(s, id).source_hash, sourceHash(source, financeFingerprint(kind, JSON.parse(String(row.document)))));
    }
  } finally {
    s.close();
  }
});
