// 助手问合计用的 records.summarize（tools/records-summary.ts）：订单金额和只数的口径、采购单没单价的不猜、
// 未到数量按单位分、按每张产出几只算要几张纸。内存库、虚构数据。
import { sales } from '../server/sales/index.js';
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/errors.js';
import { OperationsService } from '../server/operations/index.js';
import { toolsOf } from './assistant-fixture.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';
import { actor } from './actor-fixture.js';
import { readAs } from './read-result.js';

function setup() {
  const store = new Store(':memory:');
  const tools = toolsOf(store),
    summarize = (args: object) => tools.read('records.summarize', args, actor);
  const product = sales(store).createProduct(productSchema.parse({ name: '虚构纸箱' }));
  const order = (customerId: number, status: string, quantities: number[], unitPriceCents = 100) =>
    sales(store).saveOrder(
      orderSchema.parse({
        customerId,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-20',
        status,
        lines: quantities.map((quantity) => ({ productId: product.id, quantity, unit: '只', unitPriceCents })),
      }),
    );
  return { store, summarize, order, close: () => store.close() };
}

test('订单合计：金额、只数、单数都只算有效订单（不含待确认、已取消）；按客户分的同一口径', () => {
  const f = setup();
  try {
    const a = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构甲' })),
      b = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构乙' }));
    f.order(a.id, '已确认', [100]);
    f.order(a.id, '待确认', [50], 200);
    f.order(b.id, '已取消', [30]);
    f.order(b.id, '已确认', [20], 50);
    const m = readAs(f.summarize({ module: 'orders' }), {
      metrics: z.looseObject({
        byCustomer: z.array(z.looseObject({ customerName: z.unknown(), orders: z.unknown(), quantity: z.unknown(), amount: z.unknown() })),
      }),
    }).metrics;
    assert.equal(m.amount, '110.0000000');
    assert.equal(m.quantity, 120);
    assert.deepEqual(
      m.byCustomer.map((c) => [c.customerName, c.orders, c.quantity, c.amount]).sort(),
      [
        ['虚构乙', 1, 20, '10.0000000'],
        ['虚构甲', 1, 100, '100.0000000'],
      ],
    );
  } finally {
    f.close();
  }
});

test('采购单合计：没单价的单独计数、不进金额（不猜）；未到数量按单位分、小数照原样；已取消的不算', () => {
  const f = setup();
  try {
    const ops = new OperationsService(f.store),
      supplier = ops.saveSupplier({ name: '虚构纸板厂' }, actor);
    const purchase = (status: string, quantity: string, unitPrice?: string) =>
      ops.savePurchase(
        {
          supplierId: supplier.id,
          orderDate: '2026-11-01',
          status,
          lines: [{ name: '虚构纸板', length: 1000, width: 800, dimensionUnit: 'mm', unit: '张', quantity, priceBasis: 'quantity', ...(unitPrice ? { unitPrice } : {}) }],
        },
        actor,
      );
    purchase('已订货', '100', '1.0000');
    purchase('已订货', '1.5');
    purchase('已取消', '7', '1.0000');
    const m = readAs(f.summarize({ module: 'purchases' }), { metrics: z.looseObject({}) }).metrics;
    assert.equal(m.amount, '100.0000000');
    assert.equal(m.unpriced, 1);
    assert.deepEqual(m.outstanding, [{ unit: '张', quantity: '101.5' }]);
  } finally {
    f.close();
  }
});

test('按每张产出几只算要几张纸：各型号各自向上取整，或共用时的最少张数；订单不存在 404', () => {
  const f = setup();
  try {
    const c = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构甲' }));
    const order = f.order(c.id, '已确认', [181, 182]);
    const allocate = (mode: string) => readAs(f.summarize({ module: 'orders', allocation: { orderId: order.id, unitsPerSheet: 4, mode } }), { lines: z.array(z.looseObject({ sheets: z.unknown(), exactShare: z.unknown() })) });
    const each = allocate('per-product');
    assert.deepEqual(each.lines.map((l) => [l.sheets, l.exactShare]), [
      [46, '45 + 1/4'],
      [46, '45 + 2/4'],
    ]);
    assert.deepEqual([each.totalPieces, each.perProductSheets, each.sharedMinimumSheets, each.requiredSheets], [363, 92, 91, 92]);
    const shared = allocate('shared');
    assert.equal(shared.requiredSheets, 91);
    assert.equal(shared.requiresDistribution, true);
    assert.throws(() => f.summarize({ module: 'orders', allocation: { orderId: 999, unitsPerSheet: 4, mode: 'shared' } }), (e: unknown) => e instanceof AppError && e.status === 404);
  } finally {
    f.close();
  }
});
