// 账期列表（GET /finance/party-terms，server/finance/parties.ts 的 terms）：每行的约定 options 和读一个单位的一样解析补齐，
// 页面直接显示现结优惠、利息、保证金，不再自己解析存的文字（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../server/core/index.js';
import { FinanceParties } from '../../server/finance/parties/parties.js';
import { maker, newSettings } from './finance-fixture.js';

test('账期列表：每行的约定已解析补齐，和读一个单位的一样', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01');
    const parties = new FinanceParties(s);
    parties.saveTerms(maker, {
      kind: 'customer',
      partyId: 1,
      termType: 'days',
      termDays: 30,
      options: { discounts: [{ type: 'month', rate: '1' }], deposits: true },
      requestId: 'terms-list',
    });
    const [listed] = parties.terms(maker, { kind: 'customer' }).rows;
    assert.deepEqual(listed.options, {
      discounts: [{ type: 'month', days: 0, rate: '1' }],
      installments: [],
      deposits: true,
      interest: null,
    });
    assert.deepEqual(listed.options, parties.getTerms(maker, 'customer', 1)?.options);
  } finally {
    s.close();
  }
});
