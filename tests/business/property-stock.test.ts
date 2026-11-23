// 库存的属性测试（fast-check 随机生成一串手工入库、出库、盘点）：每一步之后库存品余额等于它流水的和、从不为负；
// 会出成负库存的那一步被拒，库里流水和余额都不变。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { count, many, rows } from '../../server/core/index.js';
import { quantityString } from '../../shared/core/quantity.js';
import { clerk, flowFixture } from '../support/flow-fixture.js';

/** 一步手工操作：哪个库存品、入库出库还是盘点、多少（张、只，整数） */
const stepArb = fc.record({
  target: fc.constantFrom('raw', 'finished'),
  action: fc.constantFrom('in', 'out', 'adjust'),
  quantity: fc.integer({ min: 0, max: 50 }),
});

test('任意一串入库、出库、盘点之后，每个库存品的余额等于流水之和且不为负，出成负数的那步被拒、库里不变', () => {
  fc.assert(
    fc.property(fc.array(stepArb, { minLength: 1, maxLength: 12 }), (steps) => {
      const f = flowFixture();
      try {
        const ids = { raw: f.raw.id, finished: f.finished.id };
        const ledgerSum = (id: number) =>
          many(f.store.db, rows.stock_movements.pick({ delta_units: true }), 'SELECT delta_units FROM stock_movements WHERE item_id=?', id).reduce(
            (sum, m) => sum + m.delta_units,
            0,
          );
        const movements = () => count(f.store.db, 'SELECT count(*) AS n FROM stock_movements');
        const model = { raw: 0, finished: 0 };
        for (const s of steps) {
          const id = ids[s.target];
          const units = s.quantity * 1000;
          const item = f.ops.items(true, id)[0];
          const before = movements();
          const expected = s.action === 'in' ? model[s.target] + units : s.action === 'out' ? model[s.target] - units : units;
          const refused = (s.action !== 'adjust' && units === 0) || expected < 0;
          const run = () =>
            f.flow.stock.move(
              id,
              {
                expectedVersion: item.version,
                requestId: randomUUID(),
                action: s.action,
                quantity: quantityString(units),
                date: '2026-10-20',
                notes: '虚构操作',
                acknowledged: true,
              },
              clerk,
            );
          if (refused) {
            assert.throws(run);
            assert.equal(movements(), before);
          } else {
            run();
            model[s.target] = expected;
          }
          for (const key of ['raw', 'finished'] as const) {
            const balance = f.ops.balance(ids[key]);
            assert.equal(balance, model[key]);
            assert.equal(balance, ledgerSum(ids[key]));
            assert.ok(balance >= 0);
          }
        }
      } finally {
        f.store.close();
      }
    }),
    { numRuns: 25 },
  );
});
