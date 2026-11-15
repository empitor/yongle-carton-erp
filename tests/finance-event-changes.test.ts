// 财务事件详情里的“改了什么”（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events.js';
import { eventChanges } from '../server/finance/event-changes.js';
import { FinanceEventViews } from '../server/finance/event-views.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, event, setDoc } from './finance-fixture.js';
import { readSnapshot, type FinanceSourceLine } from '../server/finance/source-snapshot.js';

test('改了什么：到货两行同一种纸板、没关联采购明细时改了库存品名称，两行都列出来；新增的行写数量（带单位）和单价（“元/m²”）；不比金额时不出“金额 … → —”', () => {
  const board = { name: '虚构纸板', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' };
  const arrivalLine = (quantity: string, unitPrice: string, priceBasis: 'quantity' | 'area' = 'quantity', item = board) => ({
    stockId: 7,
    purchaseLineId: null,
    item,
    quantity,
    stockedQuantity: quantity,
    unitPrice,
    priceBasis,
    taxMode: '未税',
    taxRate: '0',
  });
  const side = (lines: FinanceSourceLine[], amount: number | null) => ({
    doc: { supplierId: 1, supplierName: '虚构供应商', lines },
    date: '2026-01-10',
    amount,
  });
  // 管理员改了库存品名称，到货明细里的纸板资料跟着对齐（同一种纸板的两行都改）
  const renamed = { ...board, name: '虚构纸板二号' };
  const changed = eventChanges(
    'arrival',
    side([arrivalLine('100', '1.00'), arrivalLine('200', '2.00')], 50000),
    side([arrivalLine('100', '1.00', 'quantity', renamed), arrivalLine('200', '2.00', 'quantity', renamed)], 50000),
  );
  assert.deepEqual(changed, [
    { label: '第 1 行（虚构纸板二号）：品名', before: '虚构纸板', after: '虚构纸板二号' },
    { label: '第 2 行（虚构纸板二号）：品名', before: '虚构纸板', after: '虚构纸板二号' },
  ]);
  const extra = eventChanges(
    'arrival',
    side([arrivalLine('100', '1.00')], 10000),
    side([arrivalLine('100', '1.00'), { ...arrivalLine('50', '1.20', 'area'), stockId: 8 }], 14800),
  );
  assert.deepEqual(
    extra.find((c) => /新增$/.test(c.label)),
    { label: '第 2 行（虚构纸板）：新增', before: '—', after: '数量 50 张，单价 1.20 元/m²' },
  );
  const deliveryLine = (quantity: string, unitPriceExact: string) => ({
    orderLineId: 3,
    productName: '虚构纸箱',
    unit: '只',
    quantity,
    unitPriceExact,
    taxMode: '未税',
    taxRate: '13',
  });
  const delivery = (lines: FinanceSourceLine[], amount: number | null) => ({
    doc: { customerId: 1, customerName: '虚构客户', lines },
    date: '2026-01-10',
    amount,
  });
  // 单据已撤销：重新评估后没有金额，不是金额被清空，不比金额
  assert.deepEqual(
    eventChanges('delivery', delivery([deliveryLine('10', '1.5000')], 1500), delivery([deliveryLine('10', '1.5000')], null), {
      compareAmount: false,
    }),
    [],
  );
});

test('改了什么：有效的更正单被改了数量，金额照样比（更正单有金额）；说明叫人看“改了什么”', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    physical(s, 1, 'delivery', '2026-01-10', deliveryDoc('10'));
    events.sync(maker, { requestId: 'scan' });
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate' });
    postDrafts(s);
    // 原单冲销，按 8 只开更正单；两边“红字冲销并重做”后更正单入账
    s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
    physical(s, 2, 'delivery', '2026-01-12', { ...deliveryDoc('8'), correctionOf: 1 });
    events.sync(maker, { requestId: 'rescan' });
    assert.equal(event(s, 2).event_type, 'delivery.reversed', '更正单的事件类型是冲销那一种');
    for (const source of [2, 1]) {
      const e = event(s, source);
      new FinanceEventHandling(s).correct(maker, e.id, {
        version: Number(e.version),
        date: '2026-01-20',
        requestId: 'correct-' + source,
        reason: '虚构更正',
      });
    }
    postDrafts(s);
    assert.equal(Number(event(s, 2).amount_cents), 80000);
    // 管理员把已入账的更正单改成 9 只
    setDoc(s, 2, '$.lines[0].quantity', '9');
    events.sync(maker, { requestId: 'edit' });
    const edited = event(s, 2);
    assert.equal(edited.status, 'difference');
    assert.equal(edited.amount_cents, null, '红字冲销并重做以前金额列还空着');
    assert.equal(readSnapshot(edited).documentAmount, 90000, '按单据现在的内容算出的金额记在快照里');
    const changes = new FinanceEventViews(s).get(maker, edited.id).changes;
    assert.deepEqual(
      changes.find((c) => c.label === '金额'),
      { label: '金额', before: '800.00 元', after: '900.00 元' },
      '更正单有金额，照样比',
    );
    assert.match(String(edited.problem), /改了什么见详情/);
  } finally {
    s.close();
  }
});

test('改了什么：一边还缺税率时按理论金额比并写明口径，两边口径一样时照旧比金额', () => {
  const line = (orderLineId: number, orderNumber: string, price: string, productName = '虚构纸箱', quantity = '800') => ({
    orderId: orderLineId,
    orderLineId,
    orderNumber,
    productName,
    unit: '只',
    quantity,
    unitPriceExact: price,
    taxRate: '13',
    taxMode: '含税',
  });
  const side = (lines: FinanceSourceLine[], amount: number, extra: { taxPending?: boolean; theoretical?: number } = {}) => ({
    doc: { customerName: '虚构客户', lines },
    date: '2026-01-10',
    amount,
    ...extra,
  });
  // 补过 13% 税率的 750.00（含税 847.50）改成 250 只、重记后又缺税率（理论金额 625.00）：两边按理论金额比
  const taxed = eventChanges(
    'delivery',
    side([line(1, 'ZX-1', '2.5000', '虚构纸箱', '300')], 84750, { taxPending: false, theoretical: 75000 }),
    side([line(1, 'ZX-1', '2.5000', '虚构纸箱', '250')], 62500, { taxPending: true, theoretical: 62500 }),
  );
  assert.deepEqual(
    taxed.find((c) => c.label.startsWith('理论金额')),
    { label: '理论金额（不含税，一边还缺税率）', before: '750.00 元', after: '625.00 元' },
  );
  assert.ok(!taxed.some((c) => c.label === '金额'), '不拿含税金额和理论金额直接比');
  // 两边口径一样时照旧比金额
  const same = eventChanges(
    'delivery',
    side([line(1, 'ZX-1', '2.5000', '虚构纸箱', '300')], 84750, { taxPending: false, theoretical: 75000 }),
    side([line(1, 'ZX-1', '2.5000', '虚构纸箱', '250')], 70625, { taxPending: false, theoretical: 62500 }),
  );
  assert.deepEqual(same.find((c) => c.label === '金额'), { label: '金额', before: '847.50 元', after: '706.25 元' });
});

test('改了什么：到货明细解除了采购明细（采购单号跟着清掉），写成这一行的“对应采购单”变化', () => {
  const line = (purchase: { purchaseLineId: number | null; purchaseId: number | null; purchaseNumber: string }) => ({
    stockId: 7,
    item: { name: '虚构纸板', unit: '张' },
    quantity: '10',
    stockedQuantity: '10',
    unitPrice: '1.00',
    priceBasis: 'quantity' as const,
    ...purchase,
  });
  const side = (l: ReturnType<typeof line>) => ({
    doc: { supplierId: 1, supplierName: '虚构供应商', lines: [l] },
    date: '2026-01-10',
    amount: 1000,
  });
  assert.deepEqual(
    eventChanges(
      'arrival',
      side(line({ purchaseLineId: 5, purchaseId: 3, purchaseNumber: 'CG-虚构-3' })),
      side(line({ purchaseLineId: null, purchaseId: null, purchaseNumber: '' })),
    ),
    [{ label: '第 1 行（虚构纸板）：对应采购单', before: 'CG-虚构-3', after: '—' }],
  );
});
