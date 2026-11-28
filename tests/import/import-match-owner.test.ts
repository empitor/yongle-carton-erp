// 识别导入匹配页：选了属别家客户的产品，“归属冲突”那句和下单、导入、助手报的是同一句（shared/core/product-details.ts 的 productCustomerIssue），
// 目标客户名用选定的客户档案名。只算数据，虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productCustomerIssue, type Product } from '../../shared/core/index.js';
import { productStatus } from '../../src/import/ImportMatch.js';

const product: Product = {
  id: 7,
  name: '虚构甲专用箱',
  length: null,
  width: null,
  height: null,
  dimensionUnit: null,
  material: '',
  flute: '',
  requirements: '',
  customerId: 1,
  customerName: '虚构甲',
  priceCents: 0,
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

test('选了属别家客户的产品：归属冲突，说明和别处同一句、带选定客户的名字；能用的不算冲突', () => {
  const choice = { mode: 'existing' as const, id: product.id, version: product.version };
  const found = (customer: { id: number | null; name?: string }) => ({ product, unavailable: false, customer, loaded: true, list: [] });
  const conflict = productStatus(choice, found({ id: 2, name: '虚构乙' }));
  assert.deepEqual(conflict, { tone: 'danger', chip: '归属冲突', text: productCustomerIssue(product, { id: 2, name: '虚构乙' }) });
  assert.equal(conflict.text, '这个产品是 虚构甲 的，要给 虚构乙 用请新建一份');
  assert.notEqual(productStatus(choice, found({ id: 1, name: '虚构甲' })).chip, '归属冲突');
});
