// 财务来源指纹（server/finance/source-fingerprint.ts）：送货明细里出库核对时抄进来的产品材质、楞型不影响财务，
// 只改这两项指纹不变；数量变了指纹照样变。纯函数、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceHash } from '../server/finance/events/source-fingerprint.js';
import { financeFingerprint } from '../shared/business/finance-source.js';

const source = { status: 'confirmed', date: '2026-10-27' };
/** 一张送货单算进指纹的内容（按约定取，见 shared/business/finance-source.ts） */
const delivery = (line: Record<string, unknown>) =>
  financeFingerprint('delivery', {
    date: '2026-10-27',
    customerId: 1,
    lines: [{ orderId: 1, orderLineId: 1, stockId: 1, quantity: '10', unitPriceExact: '1.5000', material: 'K=A', flute: 'BC', ...line }],
  });

test('同一张送货单只改了明细的材质、楞型：财务来源指纹不变', () => {
  assert.equal(sourceHash(source, delivery({ material: 'B=B', flute: 'E' })), sourceHash(source, delivery({})));
});

test('送货明细的数量变了：财务来源指纹跟着变', () => {
  assert.notEqual(sourceHash(source, delivery({ quantity: '11' })), sourceHash(source, delivery({})));
});
