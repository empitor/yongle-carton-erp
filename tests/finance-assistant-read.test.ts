// 助手读财务的只读工具（server/finance/assistant.ts）：说明、权限、不启用财务也能查盈亏、按日期查那个月（内存库、虚构数据）
import { pageActor } from './actor-fixture.js';
import { quietLog } from './finance-catch-up-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Store } from '../server/core/index.js';
import { readFinanceTool } from '../server/finance/assistant.js';
import { financeReadTools, financeToolDescriptions } from '../shared/finance/finance-tools.js';

const reader = pageActor({ id: 'finance-reader', name: '虚构财务', permissions: ['finance:view'] });
/** 月度台账读工具的结果里取期间 */
const monthlyPeriod = z.object({ period: z.string() });

test('财务工具各有说明；理论和实际盈亏不用启用财务也能查；模型传 date 就按那个月查', () => {
  const texts = financeReadTools.map((name) => financeToolDescriptions[name]);
  assert.equal(new Set(texts).size, financeReadTools.length, '说明不能都一样');
  assert.match(financeToolDescriptions['finance.monthly'], /理论盈亏.*实际盈亏/);
  const store = new Store(':memory:');
  try {
    assert.ok(readFinanceTool(store, reader, 'finance.monthly', {}, quietLog), '没启用财务也有结果');
    assert.equal(monthlyPeriod.parse(readFinanceTool(store, reader, 'finance.monthly', { date: '2026-10-01' }, quietLog)).period, '2026-10');
  } finally {
    store.close();
  }
});

test('助手的财务只读工具：没有财务权限的账号每一个都被拒', () => {
  const s = new Store(':memory:');
  try {
    for (const tool of financeReadTools)
      assert.throws(() => readFinanceTool(s, pageActor({ id: 'no', name: '虚构只读账号', permissions: [] }), tool, {}, quietLog), /权限/, tool);
  } finally {
    s.close();
  }
});
