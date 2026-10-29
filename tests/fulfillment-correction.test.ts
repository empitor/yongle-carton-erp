import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { legacyReceiptFixture } from './legacy-receipt-fixture.js';
import { FlowService } from '../server/flow/service.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { actor, superActor, assistantFixture } from './assistant-fixture.js';
import { buildDashboard } from '../server/business/dashboard.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import RecordDetails from '../src/RecordDetails.js';
import { ProgressSummary } from '../src/FulfillmentDetails.js';
import { matchesPurchase } from '../shared/purchase-filters.js';

function fixture(store = new Store(':memory:'), count = 1, unit = '张') {
  const ops = new OperationsService(store),
    flow = new FlowService(store);
  const supplier = ops.saveSupplier({ name: '虚构履约供应商' }, actor);
  const items = Array.from({ length: count }, (_, i) =>
    ops.saveItem(
      {
        name: '虚构纸板' + (i + 1),
        kind: 'raw',
        unit,
        specification: '规格' + (i + 1),
        length: 100,
        width: 80,
        dimensionUnit: 'cm',
        material: 'K=A',
        flute: 'BC',
      },
      actor,
    ),
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      status: '已订货',
      orderDate: '2026-10-01',
      lines: items.map((s) => ({
        ...s,
        stockItemId: s.id,
        quantity: '10000',
        unitPrice: '2.1234',
        priceBasis: 'quantity',
      })),
    },
    actor,
  );
  const current = () => store.purchases(true).find((p) => p.id === purchase.id)!;
  const confirm = (d: any) =>
    flow.confirm(
      d.id,
      {
        previewId: flow.preview(d.id, actor, 's').previewId,
        requestId: randomUUID(),
        acknowledged: true,
      },
      actor,
      's',
    );
  const arrival = (quantities = ['10000'], reference: string = randomUUID()) =>
    flow.save(
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
  const receive = (quantities = ['10000'], reference: string = randomUUID()) =>
    legacyReceiptFixture(ops,
      purchase.id,
      {
        expectedVersion: current().version,
        requestId: randomUUID(),
        reference,
        date: '2026-10-20',
        acknowledged: true,
        items: quantities.map((quantity, i) => ({ lineId: purchase.lines[i].id, quantity })),
      },
      actor,
    );
  const correction = (receipt: any, quantities: string[], partial = false) => {
    const input = {
      expectedVersion: receipt.version,
      expectedPurchaseVersion: current().version,
      reason: '虚构验收：原登记数量录错',
      items: quantities
        .map((quantity, i) => ({ index: i, lineId: receipt.correctionLines[i].lineId, quantity }))
        .filter((_, i) => !partial || i === 0),
    };
    const preview = ops.previewReceiptCorrection(purchase.id, receipt.id, input, actor);
    return { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest };
  };
  const correct = (
    quantities: string[],
    receipt = current().receipts.find((r: any) => r.effective),
    partial = false,
  ) => ops.correctReceipt(purchase.id, receipt.id, correction(receipt, quantities, partial), actor);
  return {
    store,
    ops,
    flow,
    supplier,
    items,
    purchase,
    current,
    confirm,
    arrival,
    receive,
    correction,
    correct,
  };
}
function snapshot(store: Store) {
  return Object.fromEntries(
    [
      'flow_documents',
      'purchase_receipts',
      'purchase_lines',
      'purchases',
      'stock_items',
      'stock_movements',
      'operation_requests',
      'business_audit',
      'flow_refs',
      'flow_receipt_keys',
    ].map((t) => [t, store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()]),
  );
}

test('采购进度以正式事件去重，支持多产品、多批次、混合来源及草稿/取消/冲销排除', () => {
  const f = fixture(undefined, 3);
  try {
    assert.equal(f.current().arrivalProgress, '未到货');
    const draft = f.arrival(['2000']);
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    f.flow.cancel(
      draft.id,
      { version: draft.version, reason: '测试取消', acknowledged: true },
      actor,
    );
    const d = f.confirm(f.arrival(['5000', '10000']));
    f.receive(['2000']);
    const p = f.current();
    assert.deepEqual(
      p.lines.map((l: any) => l.arrivalStatus),
      ['部分到货', '已到齐', '未到货'],
    );
    assert.deepEqual(
      p.lines.map((l: any) => l.receivedQuantity),
      ['7000', '10000', '0'],
    );
    assert.equal(p.businessStatus, '已订货');
    assert.equal(p.arrivalProgress, '部分到货');
    assert(matchesPurchase(p, { businessStatus: '已订货', arrivalProgress: '部分到货' }));
    assert(!matchesPurchase(p, { businessStatus: '已订货', arrivalProgress: '全部到货' }));
    assert.equal(p.arrivalSummary.completedLines, 1);
    assert.equal(p.arrivalSummary.totalLines, 3);
    f.flow.reverse(
      d.id,
      { version: d.version, reason: '虚构冲销', acknowledged: true },
      superActor(),
    );
    assert.equal(f.current().lines[0].receivedQuantity, '2000');
    assert.equal(f.current().lines[1].receivedQuantity, '0');
    assert.equal(
      f.store.db.prepare('SELECT received_units FROM purchase_lines WHERE id=?').get(p.lines[0].id)!
        .received_units,
      2000000,
    );
  } finally {
    f.store.close();
  }
});

test('历史已确认arrival缺少采购投影仍计数；迁移12修复缓存且不制造入库流水', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-fulfillment-migration-')),
    file = join(dir, 'test.sqlite');
  const f = fixture(new Store(file));
  f.confirm(f.arrival(['10000']));
  const moves = f.store.db.prepare('SELECT * FROM stock_movements').all();
  f.store.db.exec(
    'DELETE FROM purchase_receipts; UPDATE purchase_lines SET received_units=1; DELETE FROM schema_migrations WHERE version=12',
  );
  assert.equal(f.current().lines[0].receivedQuantity, '10000');
  f.store.close();
  const store = new Store(file);
  try {
    assert.equal(
      store.db.prepare('SELECT received_units FROM purchase_lines').get()!.received_units,
      10000000,
    );
    assert.deepEqual(store.db.prepare('SELECT * FROM stock_movements').all(), moves);
    assert.equal(store.purchases()[0].receipts[0].effective, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const source of ['flow', 'legacy'])
  test(`${source}到货10000更正5000：库存、金额、完整历史、后续再到齐与批次身份`, () => {
    const f = fixture();
    try {
      if (source === 'flow') f.confirm(f.arrival());
      else f.receive();
      const receipt = f.current().receipts[0],
        before = f.current();
      const originalMoves = f.store.db
        .prepare('SELECT * FROM stock_movements ORDER BY rowid')
        .all();
      const input = f.correction(receipt, ['5000']);
      const result = f.ops.correctReceipt(f.purchase.id, receipt.id, input, actor);
      const p = f.current();
      assert.equal(p.lines[0].quantity, '10000');
      assert.equal(p.lines[0].receivedQuantity, '5000');
      assert.equal(p.lines[0].remainingQuantity, '5000');
      assert.equal(p.arrivalProgress, '部分到货');
      assert.equal(p.businessStatus, '已订货');
      assert.equal(p.totalAmount, before.totalAmount);
      assert.equal(Number(p.receivedAmount), 10617);
      assert.equal(Number(before.receivedAmount), 21234);
      assert.equal(f.ops.repo.balance(f.items[0].id), 5000000);
      assert.equal(result.stockImpact[0].delta, '-5000');
      assert.equal(p.receipts.filter((r: any) => r.effective).length, 1);
      assert.equal(
        p.receipts.find((r: any) => r.id === receipt.id).replacedBy,
        result.replacementReceiptId,
      );
      assert.equal(p.receipts.find((r: any) => r.effective).correctionOf, receipt.id);
      assert.deepEqual(
        f.store.db
          .prepare('SELECT * FROM stock_movements ORDER BY rowid LIMIT ?')
          .all(originalMoves.length),
        originalMoves,
      );
      const snap = snapshot(f.store);
      const replay = f.ops.correctReceipt(f.purchase.id, receipt.id, input, actor);
      assert.equal(replay.replayed, true);
      assert.deepEqual(snapshot(f.store), snap);
      assert.throws(
        () =>
          f.ops.correctReceipt(f.purchase.id, receipt.id, { ...input, reason: '不同内容' }, actor),
        /不同内容/,
      );
      assert.throws(() => f.confirm(f.arrival(['5000'], receipt.reference)), /重复|旧版/);
      f.confirm(f.arrival(['5000'], '新批次-补齐'));
      assert.equal(f.current().arrivalProgress, '全部到货');
      assert.equal(f.current().lines[0].receivedQuantity, '10000');
      assert.equal(f.ops.repo.balance(f.items[0].id), 10000000);
      const audit = f.store.db
        .prepare("SELECT document FROM business_audit WHERE action='correct'")
        .get();
      assert.match(String(audit?.document), /虚构验收/);
      assert.match(String(audit?.document), /replacementReceiptId/);
      assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      f.store.close();
    }
  });

test('多批次只更正其中一批，多行只改一行，支持多次链式更正及零数量', () => {
  const f = fixture(undefined, 2);
  try {
    f.confirm(f.arrival(['4000', '10000'], '第一批'));
    f.receive(['6000'], '第二批');
    const receipt = f.current().receipts.find((r: any) => r.reference === '第一批');
    f.correct(['2000'], receipt, true);
    assert.deepEqual(
      f.current().lines.map((l: any) => l.receivedQuantity),
      ['8000', '10000'],
    );
    assert.equal(f.current().arrivalSummary.completedLines, 1);
    let latest = f
      .current()
      .receipts.find((r: any) => r.effective && r.correctionOf === receipt.id);
    f.correct(['1000'], latest, true);
    assert.equal(f.current().lines[0].receivedQuantity, '7000');
    latest = f.current().receipts.find((r: any) => r.effective && r.reference === '第一批');
    f.correct(['0'], latest, true);
    assert.deepEqual(
      f.current().lines.map((l: any) => l.receivedQuantity),
      ['6000', '10000'],
    );
    latest = f.current().receipts.find((r: any) => r.effective && r.reference === '第一批');
    f.correct(['3000'], latest, true);
    assert.equal(f.current().lines[0].receivedQuantity, '9000');
    assert.equal(f.current().receipts.filter((r: any) => r.effective).length, 2);
  } finally {
    f.store.close();
  }
});

test('旧入口精确小数按原单位更正，不混算或换算其他单位', () => {
  const f = fixture(undefined, 1, '平方米');
  try {
    f.receive(['10.125']);
    f.correct(['5.001']);
    const l = f.current().lines[0];
    assert.equal(l.receivedQuantity, '5.001');
    assert.equal(l.remainingQuantity, '9994.999');
    assert.equal(l.unit, '平方米');
    assert.equal(f.ops.repo.balance(f.items[0].id), 5001);
    assert.equal(Number(l.receivedAmount), 10.6191234);
  } finally {
    f.store.close();
  }
});

test('一张到货跨两张采购，部分更正同步更新全部采购并保持原流水', () => {
  const f = fixture();
  try {
    const p2 = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        status: '已订货',
        orderDate: '2026-10-01',
        lines: [
          {
            ...f.items[0],
            stockItemId: f.items[0].id,
            quantity: '10000',
            unitPrice: '1',
            priceBasis: 'quantity',
          },
        ],
      },
      actor,
    );
    const d = f.arrival(['10000']);
    const saved = f.flow.save(
      'arrival',
      {
        ...d,
        version: d.version,
        lines: [...d.lines, { ...d.lines[0], purchaseLineId: p2.lines[0].id, quantity: '10000' }],
      },
      actor,
      d.id,
    );
    f.confirm(saved);
    const result = f.correct(['5000']);
    assert.equal(result.purchases.length, 2);
    assert.equal(f.store.purchases().find((p) => p.id === p2.id).arrivalProgress, '全部到货');
    assert.equal(f.ops.repo.balance(f.items[0].id), 15000000);
  } finally {
    f.store.close();
  }
});

for (const used of ['4000', '6000'])
  test(`已有后续生产领料${used}：按更正后的净库存校验并原子拒绝不足`, () => {
    const f = fixture();
    try {
      f.confirm(f.arrival());
      const product = f.store.saveProduct(productSchema.parse({ name: '虚构成品' }));
      const stock = f.ops.saveItem(
        { name: '虚构成品', kind: 'finished', unit: '只', productId: product.id },
        actor,
      );
      f.confirm(
        f.flow.save(
          'production',
          {
            date: '2026-10-21',
            productId: product.id,
            finishedStockId: stock.id,
            goodQuantity: '10',
            operator: '虚构机长',
            materials: [{ stockId: f.items[0].id, issued: used }],
          },
          actor,
        ),
      );
      const before = snapshot(f.store);
      if (used === '6000') {
        assert.throws(() => f.correct(['5000']), /库存不足.*后续/);
        assert.deepEqual(snapshot(f.store), before);
      } else {
        f.correct(['5000']);
        assert.equal(f.ops.repo.balance(f.items[0].id), 1000000);
      }
    } finally {
      f.store.close();
    }
  });

test('更正校验真实身份、版本、库存快照、重复行及非有效状态', () => {
  const f = fixture();
  try {
    const draft = f.arrival();
    const draftReceipt = f.current().receipts.find((r: any) => r.flowId === draft.id);
    assert.throws(() => f.correction(draftReceipt, ['5000']), /已确认/);
    f.confirm(draft);
    const receipt = f.current().receipts.find((r: any) => r.effective),
      input = f.correction(receipt, ['5000']);
    assert.throws(
      () => f.ops.correctReceipt(f.purchase.id, receipt.id, input, { ...actor, permissions: [] }),
      /权限/,
    );
    assert.throws(
      () =>
        f.ops.correctReceipt(f.purchase.id, receipt.id, { ...input, expectedVersion: 999 }, actor),
      /版本/,
    );
    assert.throws(() =>
      f.ops.previewReceiptCorrection(
        f.purchase.id,
        receipt.id,
        { ...input, requestId: undefined, previewDigest: undefined },
        actor,
      ),
    );
    const stock = f.ops.repo.items()[0];
    f.ops.move(
      stock.id,
      {
        expectedVersion: stock.version,
        requestId: randomUUID(),
        action: 'in',
        quantity: '1',
        date: '2026-10-22',
        notes: '虚构并发入库',
        acknowledged: true,
      },
      actor,
    );
    assert.throws(() => f.ops.correctReceipt(f.purchase.id, receipt.id, input, actor), /已变化/);
    const fresh = f.correction(receipt, ['5000']);
    f.ops.correctReceipt(f.purchase.id, receipt.id, fresh, actor);
    assert.throws(() => f.correction(receipt, ['4000']), /已确认|冲销/);
    assert.throws(
      () => f.ops.correctReceipt(f.purchase.id, receipt.id, fresh, { ...actor, id: '另一用户' }),
      /不同内容/,
    );
  } finally {
    f.store.close();
  }
});

test('事务中途失败回滚替代单、库存、原单、采购、审计及请求回执', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    const r = f.current().receipts[0],
      input = f.correction(r, ['5000']),
      before = snapshot(f.store);
    f.store.db.exec(
      "CREATE TEMP TRIGGER correction_failure BEFORE INSERT ON stock_movements WHEN NEW.source_kind='flow_reversal' BEGIN SELECT RAISE(ABORT,'虚构事务故障'); END",
    );
    assert.throws(() => f.ops.correctReceipt(f.purchase.id, r.id, input, actor), /虚构事务故障/);
    assert.deepEqual(snapshot(f.store), before);
    f.store.db.exec('DROP TRIGGER correction_failure');
    f.ops.correctReceipt(f.purchase.id, r.id, input, actor);
    assert.equal(f.current().arrivalProgress, '部分到货');
  } finally {
    f.store.close();
  }
});

test('销售逐行统一未发/部分/已发完、历史未知，排除草稿、取消、冲销', () => {
  const f = fixture();
  try {
    const c = f.store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
      product = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
    const finished = ['只', '个', '张'].map((unit) =>
      f.ops.saveItem(
        { name: '虚构成品' + unit, kind: 'finished', unit, productId: product.id },
        actor,
      ),
    );
    const order = f.store.saveOrder(
      orderSchema.parse({
        customerId: c.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        lines: finished.map((s, i) => ({
          productId: product.id,
          quantity: [1000, 2000, 500][i],
          unitPriceCents: 100,
          unit: s.unit,
        })),
      }),
    );
    const current = () => f.store.order(order.id)!;
    assert.equal(current().shippingProgress, '未发货');
    finished.forEach((s) =>
      f.ops.move(
        s.id,
        {
          expectedVersion: s.version,
          requestId: randomUUID(),
          action: 'in',
          quantity: '3000',
          date: '2026-10-10',
          notes: '虚构期初',
          acknowledged: true,
        },
        actor,
      ),
    );
    const delivery = (entries: [number, string][]) =>
      f.flow.save(
        'delivery',
        {
          date: '2026-10-23',
          customerId: c.id,
          lines: entries.map(([i, quantity]) => ({
            orderId: order.id,
            orderLineId: order.lines[i].id,
            stockId: finished[i].id,
            quantity,
          })),
        },
        actor,
      );
    const draft = delivery([[0, '100']]);
    assert.equal(current().lines[0].shippedQuantity, 0);
    f.flow.cancel(draft.id, { version: draft.version, reason: '取消', acknowledged: true }, actor);
    const done = f.confirm(
      delivery([
        [0, '1000'],
        [1, '500'],
      ]),
    );
    assert.deepEqual(
      current().lines.map((l) => l.shippingStatus),
      ['已发完', '部分发货', '未发货'],
    );
    assert.deepEqual(
      current().lines.map((l) => l.remainingQuantity),
      [0, 1500, 500],
    );
    assert.equal(current().shippingSummary?.completedLines, 1);
    assert.equal(current().shippingProgress, '部分发货');
    assert.equal(current().status, '待发货');
    f.confirm(
      delivery([
        [1, '1500'],
        [2, '500'],
      ]),
    );
    assert.equal(current().shippingProgress, '已发完');
    assert.equal(current().shippingSummary?.completedLines, 3);
    f.flow.reverse(
      done.id,
      { version: done.version, reason: '撤销发货', acknowledged: true },
      superActor(),
    );
    assert.deepEqual(
      current().lines.map((l) => l.shippedQuantity),
      [0, 1500, 500],
    );
    const legacy = f.store.saveOrder(
      orderSchema.parse({
        customerId: c.id,
        status: '已发货',
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-20',
        lines: [{ productId: product.id, quantity: 100, unitPriceCents: 100, unit: '只' }],
      }),
    );
    assert.equal(legacy.lines[0].shippedQuantity, null);
    assert.equal(legacy.shippingProgress, '历史数量待核对');
    const markup = renderToStaticMarkup(
      createElement(RecordDetails, { entity: 'orders', row: legacy }),
    );
    assert.match(markup, /历史数量待核对/);
  } finally {
    f.store.close();
  }
});

test('UI详情、列表进度、概览和AI读取同一更正结果', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    f.correct(['5000']);
    const p = f.current(),
      tools = new AssistantTools(f.store);
    const record = tools.read('records.get', { module: 'purchases', id: p.id }, actor);
    assert.deepEqual(record.record.lines, p.lines);
    const dashboard = buildDashboard(f.store, [], {});
    assert.equal(dashboard.overview.purchases.outstanding[0].quantity, '5000');
    assert.equal(dashboard.overview.purchases.receivedAmount, p.receivedAmount);
    const html = renderToStaticMarkup(
      createElement(RecordDetails, { entity: 'purchases', row: p }),
    );
    assert.match(html, /待到货/);
    assert.match(html, /5000/);
    assert.match(html, /已冲销/);
    assert.match(html, /更正后有效/);
    const summary = renderToStaticMarkup(
      createElement(ProgressSummary, { row: p, purchase: true }),
    );
    assert.match(summary, /部分到货/);
    assert.match(summary, /0\/1/);
  } finally {
    f.store.close();
  }
});

test('AI注册工具使用真实Actor直接完成正式更正并核验，工具停用及只读权限生效', async () => {
  const a = assistantFixture(),
    f = fixture(a.store);
  try {
    f.confirm(f.arrival());
    const p = f.current(),
      receipt = p.receipts[0],
      input = f.correction(receipt, ['5000']);
    const { requestId, previewDigest, ...preview } = input;
    const target = { purchaseId: p.id, receiptId: receipt.id };
    a.replies.push(
      {
        state: 'working',
        message: '读取采购到货',
        toolCalls: [{ name: 'records.get', args: { module: 'purchases', id: p.id } }],
      },
      {
        state: 'working',
        message: '预检更正',
        toolCalls: [{ name: 'purchase.receipt.preview', args: { ...target, ...preview } }],
      },
      {
        state: 'working',
        message: '执行更正',
        toolCalls: [{ name: 'purchase.receipt.correct', args: { ...target, ...input } }],
      },
      {
        state: 'working',
        message: '核验真实结果',
        toolCalls: [
          { name: 'records.get', args: { module: 'purchases', id: p.id } },
          { name: 'records.get', args: { module: 'raw_inventory', id: f.items[0].id } },
        ],
      },
      {
        state: 'completed',
        message: '原登记10000张，更正后5000张，待到货5000张，部分到货；库存净减少5000张。',
        toolCalls: [],
      },
    );
    const thread = a.manager.create(actor);
    const result = await a.manager.chat(
      thread.id,
      a.input('刚才的虚构采购到货录错了，实际只到了5000张，不是10000张，帮我更正。', randomUUID()),
      actor,
      's',
      () => {},
      () => actor,
    );
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
    assert.equal(f.ops.repo.balance(f.items[0].id), 5000000);
    assert.match(result.messages.at(-1)!.text, /5000/);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM operation_requests WHERE kind='receipt-correction'")
        .get()!.n,
      1,
    );
    const registry = new AssistantToolRegistry();
    try {
      const handlers = {
        read: () => null,
        business: () => assert.fail('无权限不应执行'),
        workflow: () => null,
      };
      await assert.rejects(
        () =>
          registry.dispatch(
            'purchase.receipt.correct',
            { ...target, ...input },
            { ...actor, permissions: [] },
            handlers,
          ),
        /权限/,
      );
      registry.set(
        {
          name: 'purchase.receipt.correct',
          enabled: false,
          expectedRevision: registry.view().revision,
        },
        superActor(),
      );
      await assert.rejects(
        () =>
          registry.dispatch('purchase.receipt.correct', { ...target, ...input }, actor, handlers),
        /停用/,
      );
    } finally {
      registry.close();
    }
  } finally {
    a.close();
  }
});

test('正式HTTP更正接口验证CSRF、登录及版本并返回同步结果', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:');
  const server = createApp(f.store, { auth }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    f.confirm(f.arrival());
    const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({
        name: '虚构HTTP管理员',
        password: 'fictional-correction-password-123',
      }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const receipt = f.current().receipts[0],
      input = f.correction(receipt, ['5000']);
    const url = base + '/purchases/' + f.purchase.id + '/receipts/' + receipt.id + '/correct';
    const denied = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(input),
    });
    assert.equal(denied.status, 403);
    const submit = (value: any) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ERP-Auth-Token': auth.csrf,
          Cookie: cookie,
        },
        body: JSON.stringify(value),
      });
    const outcomes = await Promise.all([
      submit(input),
      submit({ ...input, requestId: randomUUID() }),
    ]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    const ok = outcomes.find((r) => r.status === 200)!;
    const result = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(result));
    assert.equal(result.purchases[0].arrivalProgress, '部分到货');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    auth.close();
    f.store.close();
  }
});

test('旧到货价格优先使用当时审计快照，无历史定价证据时不猜当前合同价', () => {
  const f = fixture();
  try {
    const received = f.receive(['10000']);
    f.store.db
      .prepare('UPDATE purchase_receipts SET document=? WHERE id=?')
      .run(
        JSON.stringify({ items: [{ lineId: f.purchase.lines[0].id, quantity: '10000' }] }),
        received.receiptId,
      );
    f.store.db
      .prepare("UPDATE purchase_lines SET document=json_set(document,'$.unitPrice','9') WHERE id=?")
      .run(f.purchase.lines[0].id);
    assert.equal(Number(f.current().receivedAmount), 21234);
    f.store.db.exec("DELETE FROM business_audit WHERE action='receive'");
    assert.equal(f.current().receivedAmount, null);
    f.correct(['5000']);
    assert.equal(f.current().receivedAmount, null);
    assert.equal(f.ops.repo.balance(f.items[0].id), 5000000);
  } finally {
    f.store.close();
  }
});

test('关联arrival历史缺失时保留正式采购收货凭据，不清零、不重复入库或擅自重建', () => {
  const f = fixture();
  try {
    const d = f.confirm(f.arrival());
    f.store.db.prepare('DELETE FROM flow_refs WHERE document_id=?').run(d.id);
    f.store.db.prepare('DELETE FROM flow_previews WHERE document_id=?').run(d.id);
    f.store.db.prepare('DELETE FROM flow_receipt_keys WHERE document_id=?').run(d.id);
    f.store.db.prepare('DELETE FROM flow_documents WHERE id=?').run(d.id);
    const p = f.current(),
      receipt = p.receipts[0];
    assert.equal(p.lines[0].receivedQuantity, '10000');
    assert.equal(receipt.missingFlow, d.id);
    assert.throws(() => f.correction(receipt, ['5000']), /到货单缺失/);
    assert.equal(f.ops.repo.balance(f.items[0].id), 10000000);
  } finally {
    f.store.close();
  }
});

test('旧入口连续更正保留同一批次身份，已被替代记录始终不再计数', () => {
  const f = fixture();
  try {
    f.receive(['10000'], '虚构连续更正批次');
    f.correct(['5000']);
    f.correct(['4000']);
    f.correct(['0']);
    f.correct(['2000']);
    assert.equal(f.current().lines[0].receivedQuantity, '2000');
    assert.equal(f.current().receipts.filter((r: any) => r.effective).length, 1);
    assert.equal(f.current().receipts.length, 5);
    assert(f.current().receipts.every((r: any) => r.reference === '虚构连续更正批次'));
    assert.equal(f.ops.repo.balance(f.items[0].id), 2000000);
  } finally {
    f.store.close();
  }
});

test('明细身份、重复索引、超量、整张精度及缺失原始流水均拒绝且不写业务', () => {
  const f = fixture();
  try {
    f.confirm(f.arrival());
    const r = f.current().receipts[0],
      input = f.correction(r, ['5000']);
    const { requestId: _requestId, previewDigest: _previewDigest, ...preview } = input;
    const before = snapshot(f.store);
    for (const items of [
      [{ ...preview.items[0], lineId: 99999 }],
      [preview.items[0], preview.items[0]],
      [{ ...preview.items[0], quantity: '10001' }],
      [{ ...preview.items[0], quantity: '5.001' }],
    ])
      assert.throws(() =>
        f.ops.previewReceiptCorrection(f.purchase.id, r.id, { ...preview, items }, actor),
      );
    assert.deepEqual(snapshot(f.store), before);
    f.store.db.exec('DELETE FROM stock_movements');
    assert.throws(() => f.correction(r, ['5000']), /流水数量不一致/);
    assert.equal(f.current().lines[0].receivedQuantity, '10000');
  } finally {
    f.store.close();
  }
});
