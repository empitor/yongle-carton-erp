import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { actor, flowFixture, readAs } from './assistant-fixture.js';
import { orderBasics } from './stack-fixture.js';

const dashboard = {
  overview: z.looseObject({ orders: z.looseObject({ total: z.number() }) }),
};

test('助手经营概况按指定日期筛选订单，全部日期包含范围外的订单', () => {
  const f = flowFixture();
  try {
    const { pa, line, order } = orderBasics(f.store);
    order([line(pa)]);
    const read = (args: object) => readAs(f.manager.tools.read('overview.get', args, actor), dashboard);
    assert.equal(read({ start: '2026-10-01', end: '2026-10-31' }).overview.orders.total, 1);
    assert.equal(read({ start: '2026-11-01', end: '2026-11-30' }).overview.orders.total, 0);
    assert.equal(read({ allDates: true }).overview.orders.total, 1);
    assert.equal(read({}).url, '#dashboard');
  } finally {
    f.close();
  }
});

test('助手经营概况拒绝互相矛盾的日期条件', () => {
  const f = flowFixture();
  try {
    assert.throws(() => f.manager.tools.read('overview.get', { allDates: true, months: 2 }, actor), /全部日期不能同时指定日期范围/);
    assert.throws(() => f.manager.tools.read('overview.get', { start: '2026-11-30', end: '2026-11-01' }, actor), /开始日期不能晚于结束日期/);
  } finally {
    f.close();
  }
});
