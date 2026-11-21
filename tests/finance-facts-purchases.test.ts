// 财务从业务拿数据的只读窗口（server/flow/finance-facts/purchases.ts）：采购明细和采购退货一组的口径，
// 和财务按它挑要记的退货时语句条数不随退货多少变。全部是虚构数据，只用内存库。
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { StoredDataError, count } from '../server/core/index.js';
import { FinanceEvents } from '../server/finance/events.js';
import { returnEstimatesPending } from '../server/finance/return-estimates.js';
import { financeFacts } from '../server/flow/index.js';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { returnFixture } from './finance-costing-fixture.js';
import { maker, postDrafts, supervisor } from './finance-fixture.js';

type Returns = ReturnType<typeof returnFixture>;
/** 退 quantity 张这批到货 */
const giveBack = (f: Returns, requestId: string, quantity: string, date = '2026-02-08') =>
  f.returns.create(maker, { arrivalId: f.received.id, date, reason: '虚构质量问题', requestId, lines: [{ lineIndex: 0, quantity }] });

test('采购明细：一批编号一次查完，带采购单号、解析好的纸板资料和计价方式，金额按面积或按张算好，找不到的不在结果里', () => {
  const base = businessBase(actor);
  const supplier = base.supplier();
  const sheet = base.raw({ name: '虚构纸板甲', length: 1000, width: 800, dimensionUnit: 'mm' });
  const other = base.raw({ name: '虚构纸板乙', length: 1200, width: 900, dimensionUnit: 'mm' });
  const purchase = base.ops.savePurchase(
    {
      supplierId: supplier.id,
      orderDate: '2026-02-01',
      status: '已订货',
      lines: [
        { ...sheet, stockItemId: sheet.id, quantity: '10', unitPrice: '1.2500', priceBasis: 'area' },
        { ...other, stockItemId: other.id, quantity: '5', unitPrice: '3.0000', priceBasis: 'quantity' },
        { ...sheet, stockItemId: sheet.id, quantity: '2', priceBasis: 'quantity' },
      ],
    },
    actor,
  );
  const [area, each, unpriced] = purchase.lines.map((l) => l.id);
  const prepare = mock.method(base.store.db, 'prepare');
  const lines = financeFacts.purchases.lines(base.store.db, [unpriced, area, each, each, unpriced + 100]);
  assert.equal(prepare.mock.callCount(), 1, '一批编号一条语句');
  prepare.mock.restore();
  assert.deepEqual([...lines.keys()].sort(), [area, each, unpriced].sort(), '找不到的不在结果里，重复的只给一次');
  const first = lines.get(area);
  assert.deepEqual(
    first && { ...first, item: { length: first.item.length, width: first.item.width, dimensionUnit: first.item.dimensionUnit } },
    { purchaseId: purchase.id, purchaseNumber: purchase.number, quantityUnits: 10000, item: { length: 1000, width: 800, dimensionUnit: 'mm' }, amount: '10' },
    '按面积：1 m × 0.8 m × 10 张 × 1.25 元',
  );
  assert.deepEqual([first?.item.unit, first?.item.priceBasis, first?.item.unitPrice], ['张', 'area', '1.2500']);
  assert.equal(lines.get(each)?.amount, '15', '按张：5 张 × 3 元');
  assert.equal(lines.get(unpriced)?.amount, null, '没写单价的算不出');
  assert.equal(financeFacts.purchases.lines(base.store.db, []).size, 0);
});

test('采购退货：表头只给编号和状态（已确认、已撤销都给），按编号读出整张原文，解析出退了哪几行', () => {
  const f = returnFixture();
  try {
    const first = giveBack(f, 'return-1', '3');
    const second = giveBack(f, 'return-2', '2', '2026-02-09');
    f.returns.reverse(supervisor, first.id, { version: first.version, reason: '虚构退错了' });
    assert.deepEqual(financeFacts.purchases.returnHeads(f.s.db), [
      { id: first.id, status: 'reversed' },
      { id: second.id, status: 'confirmed' },
    ]);
    const rows = financeFacts.purchases.returnRows(f.s.db, [second.id, second.id + 100]);
    assert.deepEqual(
      rows.map(({ document: _document, updatedAt: _at, ...r }) => r),
      [{ id: second.id, number: second.number, arrivalId: f.received.id, status: 'confirmed', date: '2026-02-09' }],
      '找不到的不在结果里',
    );
    assert.deepEqual(rows.map((r) => financeFacts.purchases.returnLines(r)), [[{ lineIndex: 0, quantity: '2' }]]);
  } finally {
    f.s.close();
  }
});

test('采购退货内容读不出来：按编号照样交出原文，解析那一步抛 StoredDataError（财务逐张跳过）；严格结构，多出或写错的项也算读不出来', () => {
  const f = returnFixture();
  try {
    const bad = giveBack(f, 'return-bad', '3');
    const read = () => financeFacts.purchases.returnRows(f.s.db, [bad.id]).map((r) => financeFacts.purchases.returnLines(r));
    businessChanges(f.s).tamper('purchase_returns', bad.id, '$.extra', '虚构多出的项');
    assert.throws(read, StoredDataError);
    businessChanges(f.s).tamper('purchase_returns', bad.id, '$', { lines: [{ lineIndex: 0, quantity: '3' }] });
    assert.throws(read, StoredDataError, '只剩明细、缺了别的项');
    businessChanges(f.s).tamper('purchase_returns', bad.id, '$.lines', '虚构的坏明细');
    assert.equal(financeFacts.purchases.returnRows(f.s.db, [bad.id]).length, 1, '原文照样交出');
    assert.throws(read, StoredDataError);
  } finally {
    f.s.close();
  }
});

test('到货有没有已确认的退货：有就是，撤销了不算，别的到货不算', () => {
  const f = returnFixture();
  try {
    assert.equal(financeFacts.purchases.hasConfirmedReturn(f.s.db, f.received.id), false);
    const back = giveBack(f, 'return-1', '3');
    assert.equal(financeFacts.purchases.hasConfirmedReturn(f.s.db, f.received.id), true);
    assert.equal(financeFacts.purchases.hasConfirmedReturn(f.s.db, f.received.id + 100), false);
    f.returns.reverse(supervisor, back.id, { version: back.version, reason: '虚构退错了' });
    assert.equal(financeFacts.purchases.hasConfirmedReturn(f.s.db, f.received.id), false);
  } finally {
    f.s.close();
  }
});

/** 一张到货退 n 次、每次 1 张，同步冲完暂估后，再问“有没有要记的退货”发出的语句条数 */
function pendingStatements(n: number) {
  const f = returnFixture();
  try {
    // 同一张到货的下一张退货要等上一张出的暂估凭证记了账才冲，一次同步冲一张
    for (let i = 0; i < n; i++) {
      giveBack(f, 'return-' + i, '1');
      new FinanceEvents(f.s).sync(maker);
      postDrafts(f.s);
    }
    assert.equal(count(f.s.db, "SELECT count(*) FROM fin_vouchers WHERE module_source='purchase_return' AND reversal_of IS NULL"), n, '每张都冲了');
    const prepare = mock.method(f.s.db, 'prepare');
    assert.equal(returnEstimatesPending(f.s, maker), false, '都冲过了，没有要记的');
    return prepare.mock.callCount();
  } finally {
    f.s.close();
  }
}

test('财务挑要记的退货：语句条数不随退货多少变（1 张和 5 张一样）', () => {
  assert.equal(pendingStatements(5), pendingStatements(1));
});
