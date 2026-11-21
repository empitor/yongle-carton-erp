// 到货和更正到货单跟采购单走（server/flow/arrival-correction.ts、server/operations/）：采购进度按有效到货算，
// 多批次、多行、跨两张采购的更正，界面、概览、助手读到的一致，接口和输入的校验，改成 0 的行。内存库、虚构数据。
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/core/db.js';
import { businessBase } from './business-base-fixture.js';
import { FlowService } from '../server/flow/service.js';
import { buildDashboard } from '../server/business/dashboard.js';
import { toolsOf } from './assistant-fixture.js';
import { planCorrection } from '../server/flow/correction.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { DataManagementService } from '../server/admin/data-management-service.js';
import { flowInput } from '../shared/business/physical-flow.js';
import { matchesPurchase } from '../shared/business/purchase-filters.js';
import { PurchaseDetails } from '../src/records/PurchaseDetails.js';
import { startHttp } from './http-fixture.js';
import { saveDoc, applyCorrection, previewCorrection } from './receive-fixture.js';
import { one, rows } from '../server/core/index.js';
import { arrivalCorrectionExtraSchema, correctionResultSchema, type PurchaseView } from '../shared/business/index.js';
import { actor, superActor } from './actor-fixture.js';
import { readAs } from './read-result.js';

/** 采购单上的一条到货记录 */
type Receipt = PurchaseView['receipts'][number];

/** 一张已订货的采购单：count 种纸板各 10000 张、单价 2.1234；arrival(各行数量, 送货单号) 存一张挂采购明细的到货单 */
function fixture(count = 1) {
  const base = businessBase(actor),
    { store, ops, flow } = base;
  const supplier = base.supplier({ name: '虚构履约供应商' });
  const items = Array.from({ length: count }, (_, i) =>
    base.raw({ name: '虚构纸板' + (i + 1), specification: '规格' + (i + 1), length: 100, width: 80, dimensionUnit: 'cm', material: 'K=A', flute: 'BC' }),
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      status: '已订货',
      orderDate: '2026-10-01',
      lines: items.map((s) => ({ ...s, stockItemId: s.id, quantity: '10000', unitPrice: '2.1234', priceBasis: 'quantity' })),
    },
    actor,
  );
  const current = () =>
    new FlowService(store).views.purchases(true).find((p) => p.id === purchase.id) ?? assert.fail('采购单 ' + purchase.id + ' 读不到');
  const confirm = (d: { id: number }) => base.check(d);
  const arrival = (quantities = ['10000'], reference: string = randomUUID()) =>
    saveDoc(
      flow,
      'arrival',
      {
        date: '2026-10-20',
        supplierId: supplier.id,
        reference,
        lines: quantities.map((quantity, i) => ({
          stockId: items[i].id,
          purchaseLineId: purchase.lines[i].id,
          item: items[i],
          quantity,
          unitPrice: '2.1234',
          priceBasis: 'quantity',
        })),
      },
      actor,
    );
  const correction = (receipt: Receipt, quantities: string[], partial = false) => {
    const input = {
      expectedVersion: receipt.version,
      reason: '虚构验收：原登记数量录错',
      items: quantities
        .map((quantity, i) => ({ index: i, lineId: receipt.correctionLines[i].lineId, quantity }))
        .filter((_, i) => !partial || i === 0),
    };
    const preview = previewCorrection(ops.store, receipt.id, input, actor);
    return { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest };
  };
  const correct = (quantities: string[], receipt = current().receipts.find((r) => r.effective), partial = false) => {
    assert.ok(receipt);
    return applyCorrection(ops.store, receipt.id, correction(receipt, quantities, partial), actor);
  };
  return { store, ops, flow, supplier, items, purchase, current, confirm, arrival, correction, correct };
}
const snapshot = (store: Store) =>
  Object.fromEntries(
    ['flow_documents', 'purchase_lines', 'purchases', 'stock_items', 'stock_movements', 'operation_requests', 'business_audit', 'flow_refs', 'flow_receipt_keys'].map(
      (t) => [t, store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()],
    ),
  );

test('采购进度只算有效到货：多产品、多批次累加，待入库、取消、撤销的不算', () => {
  const f = fixture(3);
  try {
    assert.equal(f.current().arrivalProgress, '未到货');
    const draft = f.arrival(['2000']);
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    f.flow.cancel(draft.id, { version: draft.version, reason: '测试取消', acknowledged: true }, actor);
    const d = f.confirm(f.arrival(['5000', '10000']));
    f.confirm(f.arrival(['2000']));
    const p = f.current();
    assert.deepEqual(p.lines.map((l) => l.arrivalStatus), ['部分到货', '已到齐', '未到货']);
    assert.deepEqual(p.lines.map((l) => l.receivedQuantity), ['7000', '10000', '0']);
    assert.deepEqual([p.businessStatus, p.arrivalProgress], ['已订货', '部分到货']);
    assert(matchesPurchase(p, { businessStatus: '已订货', arrivalProgress: '部分到货' }));
    assert(!matchesPurchase(p, { businessStatus: '已订货', arrivalProgress: '全部到货' }));
    assert.deepEqual([p.arrivalSummary.completedLines, p.arrivalSummary.totalLines], [1, 3]);
    f.flow.reverse(d.id, { version: d.version, reason: '虚构冲销', acknowledged: true }, superActor());
    assert.deepEqual([f.current().lines[0].receivedQuantity, f.current().lines[1].receivedQuantity], ['2000', '0']);
    assert.equal(
      one(f.store.db, rows.purchase_lines.pick({ received_units: true }), 'SELECT received_units FROM purchase_lines WHERE id=?', p.lines[0].id)
        ?.received_units,
      2000000,
    );
  } finally {
    f.store.close();
  }
});

test('多批次只更正其中一批，多行只改一行，能接着更正、改成 0 再改回来', () => {
  const f = fixture(2);
  try {
    f.confirm(f.arrival(['4000', '10000'], '第一批'));
    f.confirm(f.arrival(['6000'], '第二批'));
    const first = () => f.current().receipts.find((r) => r.effective && r.reference === '第一批');
    f.correct(['2000'], first(), true);
    assert.deepEqual(f.current().lines.map((l) => l.receivedQuantity), ['8000', '10000']);
    assert.equal(f.current().arrivalSummary.completedLines, 1);
    f.correct(['1000'], first(), true);
    assert.equal(f.current().lines[0].receivedQuantity, '7000');
    f.correct(['0'], first(), true);
    assert.deepEqual(f.current().lines.map((l) => l.receivedQuantity), ['6000', '10000']);
    f.correct(['3000'], first(), true);
    assert.equal(f.current().lines[0].receivedQuantity, '9000');
    assert.equal(f.current().receipts.filter((r) => r.effective).length, 2);
  } finally {
    f.store.close();
  }
});

test('一张到货跨两张采购，部分更正同步更新两张采购并保持原流水', () => {
  const f = fixture();
  try {
    const p2 = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        status: '已订货',
        orderDate: '2026-10-01',
        lines: [{ ...f.items[0], stockItemId: f.items[0].id, quantity: '10000', unitPrice: '1', priceBasis: 'quantity' }],
      },
      actor,
    );
    const d = f.arrival(['10000']);
    const saved = saveDoc(
      f.flow,
      'arrival',
      { ...d, version: d.version, lines: [...d.lines, { ...d.lines[0], purchaseLineId: p2.lines[0].id, quantity: '10000' }] },
      actor,
      d.id,
    );
    f.confirm(saved);
    const result = f.correct(['5000']);
    assert.equal(result.purchases.length, 2);
    assert.equal(new FlowService(f.store).views.purchases().find((p) => p.id === p2.id)?.arrivalProgress, '全部到货');
    assert.equal(f.ops.balance(f.items[0].id), 15000000);
  } finally {
    f.store.close();
  }
});

test('只能更正有效的已入库到货：待入库的、已被更正替代的拒绝；换个人拿同一请求号是另一个请求，照样按已被替代拒绝', () => {
  const f = fixture();
  try {
    const draft = f.arrival();
    const draftReceipt = f.current().receipts.find((r) => r.flowId === draft.id) ?? assert.fail('采购单上没有待入库那张的到货记录');
    assert.throws(() => f.correction(draftReceipt, ['5000']), /只能更正有效的已入库到货/);
    f.confirm(draft);
    const receipt = f.current().receipts.find((r) => r.effective);
    assert.ok(receipt);
    const input = f.correction(receipt, ['5000']);
    applyCorrection(f.ops.store, receipt.id, input, actor);
    assert.throws(() => f.correction(receipt, ['4000']), /只能更正有效的已入库到货/);
    assert.throws(() => applyCorrection(f.ops.store, receipt.id, input, { ...actor, id: '另一用户' }), /只能更正有效的已入库到货/);
  } finally {
    f.store.close();
  }
});

test('更正以后采购详情、列表进度、经营概览和助手读到的是同一个结果', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    f.correct(['5000']);
    const p = f.current();
    const record = readAs(toolsOf(f.store).read('records.get', { module: 'purchases', id: p.id }, actor), { record: z.looseObject({}) });
    assert.deepEqual(record.record.lines, p.lines);
    const dashboard = buildDashboard(f.store, [], {});
    assert.equal(dashboard.overview.purchases.outstanding[0].quantity, '5000');
    assert.equal(Number(p.receivedAmount), 10617, '采购单的有效到货金额');
    assert.equal(dashboard.overview.purchases.arrivedCents, 1061700, '经营概况的到货金额（分）和它一致：两张到货单都按实际入库数量');
    // 右侧面板里采购单详情的正文
    const html = renderToStaticMarkup(createElement(PurchaseDetails, { row: p }));
    assert.match(html, /待到/);
    assert.match(html, /5000/);
    // 业务页面不说“冲销”：被更正替换的原到货标“已更正”
    assert.match(html, /已更正/);
    assert.doesNotMatch(html, /已冲销/);
    assert.match(html, /已入库/);
    assert.match(html, /更正后的数量/, '到货记录和到货单本身同一套叫法：已入库，标明是更正后的数量');
    assert.equal(p.arrivalProgress, '部分到货');
    assert.deepEqual([p.arrivalSummary.completedLines, p.arrivalSummary.totalLines], [0, 1]);
  } finally {
    f.store.close();
  }
});

test('更正接口（POST /api/flow/:id/correct）要页面凭证；两个请求同时更正只成一个，返回同步后的采购进度', async () => {
  const f = fixture(),
    h = await startHttp(f.store);
  try {
    f.confirm(f.arrival());
    const receipt = f.current().receipts[0],
      input = f.correction(receipt, ['5000']);
    const url = '/flow/' + receipt.flowId + '/correct',
      body = {
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        requestId: input.requestId,
        previewDigest: input.previewDigest,
        lines: input.items.map(({ lineId: _lineId, ...l }) => l),
      };
    assert.equal((await h.post(url, body, null)).status, 403);
    const outcomes = await Promise.all([h.post(url, body), h.post(url, { ...body, requestId: randomUUID() })]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    const result = correctionResultSchema('arrival', arrivalCorrectionExtraSchema).parse(
      await (outcomes.find((r) => r.status === 200) ?? assert.fail('两个请求都没成')).json(),
    );
    assert.equal(result.purchases[0].arrivalProgress, '部分到货');
  } finally {
    await h.close();
    f.store.close();
  }
});

test('更正的行重复、超过订购量、小数张、原始流水缺失都拒绝，不写业务', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    const r = f.current().receipts[0],
      head = { expectedVersion: r.version, reason: '虚构验收：原登记数量录错' };
    const before = snapshot(f.store);
    for (const lines of [
      [
        { index: 0, quantity: '5000' },
        { index: 0, quantity: '5000' },
      ],
      [{ index: 0, quantity: '10001' }],
      [{ index: 0, quantity: '5.001' }],
    ])
      assert.throws(() => planCorrection(f.ops.store, r.flowId, { ...head, lines }, actor));
    assert.deepEqual(snapshot(f.store), before);
    f.store.db.exec('DELETE FROM stock_movements');
    assert.throws(() => f.correction(r, ['5000']), /流水数量不一致/);
    assert.equal(f.current().lines[0].receivedQuantity, '10000');
  } finally {
    f.store.close();
  }
});

test('到货更正把某一行改成 0：替代单留着这一行、不记 0 数量流水，数据列表读得出来；每一行都改成 0 要改用撤销；新登记的到货仍不许 0', () => {
  const f = fixture(2);
  try {
    const admin = localAdministratorActor(superActor());
    const moves = () =>
      f.store.db
        .prepare('SELECT seq,id,item_id,delta_units,source_kind,source_id FROM stock_movements ORDER BY seq')
        .all()
        .map((m) => ({ ...m }));
    const effective = () => f.current().receipts.find((r) => r.effective) ?? assert.fail('采购单上没有有效的到货记录');
    const record = (flowId: number) =>
      f.flow.arrivalRecords({ includeInactive: true }).find((r) => r.flowId === flowId) ?? assert.fail('没有到货单 ' + flowId + ' 的到货记录');

    f.confirm(f.arrival(['4000', '10000'], '虚构更正成零'));
    // 第一行其实没到货：更正成 0，第二行不动
    f.correct(['0'], effective(), true);
    const replacement = f.flow.get(effective().flowId, 'arrival');
    assert.ok(replacement.correctionOf, '有效的是替代单');
    assert.deepEqual(
      replacement.lines.map((l) => [l.quantity, l.acceptedQuantity, l.rejectedQuantity, l.stockedQuantity]),
      [
        ['0', '0', '0', '0'],
        ['10000', '10000', '0', '10000'],
      ],
      '替代单留着更正成 0 的这一行',
    );
    assert.deepEqual(f.current().lines.map((l) => l.receivedQuantity), ['0', '10000']);
    assert.deepEqual([f.ops.balance(f.items[0].id), f.ops.balance(f.items[1].id)], [0, 10000000]);
    // 替代单名下只有第二行的一笔入库，没有 0 数量的流水
    const own = (id: number) =>
      moves()
        .filter((m) => m.source_kind === 'flow_arrival' && m.source_id === String(id))
        .map((m) => [Number(m.item_id), Number(m.delta_units)]);
    assert.deepEqual(own(replacement.id), [[f.items[1].id, 10000000]]);
    assert.equal(record(replacement.id).inventoryStatus, '已入库');
    // 管理员的数据列表读得出全部到货单（原单、替代单）
    assert.equal(new DataManagementService(f.store).list('arrival', admin).records.length, 2);

    // 每一行都是 0 等于这次到货没发生：再做一次更正会被拦下，提示撤销
    const before = moves();
    assert.throws(() => f.correction(effective(), ['0', '0']), /更正后每一行都是 0，等于这次到货没有发生。请关掉这个窗口，改用“撤销这次到货”。/);
    assert.deepEqual(moves(), before, '被拦下后流水没变');

    // 更正成 0 的那一行还能再更正回来（替代单又换一张）
    f.correct(['3000'], effective(), true);
    assert.deepEqual(f.current().lines.map((l) => l.receivedQuantity), ['3000', '10000']);
    assert.ok(moves().every((m) => Number(m.delta_units) !== 0), '库里没有 0 数量的流水');

    // 新登记、待入库的到货单每行仍必须大于 0
    assert.throws(() => f.arrival(['0'], '虚构零数量登记'), /数量必须大于零/);
    const pending = f.arrival(['100'], '虚构待入库');
    const cur = f.flow.get(pending.id);
    const zero = { ...flowInput('arrival', cur), lines: [{ ...flowInput('arrival', cur).lines[0], quantity: '0' }], version: cur.version };
    assert.throws(() => f.flow.save('arrival', zero, admin, pending.id), /数量必须大于零/);
    assert.equal(f.flow.get(pending.id, 'arrival').lines[0].quantity, '100');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});
