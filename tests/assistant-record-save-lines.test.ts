// 助手改订单（records.propose_save，server/assistant/tools/records-save.ts）：明细原样交给订单的表单结构核对，
// 不是对象的明细（null、文字）被拒收，不悄悄丢掉再出卡片。虚构数据、内存库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsOf } from './assistant-fixture.js';
import { clerk, flowFixture } from './flow-fixture.js';

test('改订单时明细里有 null 或一段文字：出方案就被拒，不丢掉那一行照样出卡片', () => {
  const f = flowFixture();
  const order = f.order(20);
  const tools = toolsOf(f.store);
  const line = { productId: f.product.id, quantity: 20, unit: '只', unitPriceCents: 100 };
  for (const bad of [null, '虚构的一行文字'])
    assert.throws(
      () => tools.prepare('records.propose_save', { module: 'orders', id: order.id, patch: { lines: [line, bad] } }, clerk, 'test'),
      (e: unknown) => e instanceof Error && e.name === 'ZodError',
      String(bad),
    );
});

test('助手新建采购单漏写计价方式：出方案就被拒，提示选按平方米还是按张，不按默认算钱', () => {
  const f = flowFixture();
  const tools = toolsOf(f.store);
  const line = { ...f.raw, stockItemId: f.raw.id, quantity: '100', unitPrice: '2' };
  const propose = (extra: Record<string, unknown>) =>
    tools.prepare('records.propose_save', { module: 'purchases', patch: { supplierId: f.supplier.id, orderDate: '2026-11-01', status: '待订货', lines: [{ ...line, ...extra }] } }, clerk, 'test');
  assert.throws(() => propose({}), /priceBasis[\s\S]*请选择按平方米还是按张/);
  assert.equal(propose({ priceBasis: 'area' }).tool, 'records.propose_save');
});
