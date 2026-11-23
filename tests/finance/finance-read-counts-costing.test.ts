// 成本计算读库的语句条数不随单据量变：5 张和 50 张来源（到货和跨期补登的盘点各一半），
// 算成本前要填的、算成本、结账核对发出的语句条数相同。只数语句，不比快慢（tests/read-counts.test.ts 的写法）。虚构数据、内存库。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Store } from '../../server/core/index.js';
import { FinanceEventVouchers } from '../../server/finance/events/event-voucher.js';
import { quantityUnits } from '../../shared/core/index.js';
import { businessChanges } from '../support/business-changes-fixture.js';
import { fixture, maker } from './finance-costing-fixture.js';
import { event } from './finance-fixture.js';

/**
 * 运行 run 时发出的读库语句条数（SELECT、WITH 开头的）。写的不数：算完成本把待算成本的事件逐条改状态、各留一条审计，本来就跟事件数走。
 */
function statements(store: Store, run: () => unknown) {
  let n = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql: string) => {
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) n++;
    return prepare(sql);
  };
  try {
    run();
    return n;
  } finally {
    store.db.prepare = prepare;
  }
}

type Costing = ReturnType<typeof fixture>;
type Raw = ReturnType<Costing['raw']>;
/**
 * 两种纸板轮流到货 count 张（不经采购单登记，有单价），每张一天，从 month 的 1 号起；暂估都生成凭证
 * （成本计算只认已生成凭证的事件，凭证记不记账不影响，省掉记账）
 */
function bookedArrivals(f: Costing, items: Raw[], month: string, count: number) {
  const arrived = Array.from({ length: count }, (_, i) =>
    f.arrive(items[i % 2], month + '-' + String(1 + Math.floor(i / 2)).padStart(2, '0'), { unitPrice: '10.0000' }),
  );
  const vouchers = new FinanceEventVouchers(f.s);
  for (const doc of arrived) {
    const e = event(f.s, doc.id, 'arrival');
    vouchers.generate(maker, e.id, { version: e.version, requestId: randomUUID() });
  }
}

/**
 * 两种纸板，2 月各到货一张，算完 2 月成本；之后补登 2 月的盘点流水（跨期补登），3 月两种纸板轮流到货，
 * 两样合起来 n 张。数 3 月算成本前要填的、算成本、结账核对的语句条数。
 */
function countFor(n: number) {
  const f = fixture();
  try {
    const items = [f.raw(), f.raw()];
    bookedArrivals(f, items, '2026-02', 2);
    f.cost('2026-02');
    const late = Math.floor(n / 2);
    const changes = businessChanges(f.s, maker);
    for (let i = 0; i < late; i++)
      changes.backdatedMovement({
        id: 'fict-late-' + i, item_id: items[i % 2].id, action: 'adjust', delta_units: -quantityUnits('0.01'),
        before_units: 0, after_units: 0, source_kind: 'manual', date: '2026-02-20', notes: '虚构盘亏补登',
        created_at: '2026-03-01T01:00:00Z',
      });
    bookedArrivals(f, items, '2026-03', n - late);
    const requirements = statements(f.s, () => f.costing.requirements(maker, { period: '2026-03' }));
    const run = statements(f.s, () => f.costing.run(maker, { period: '2026-03', requestId: randomUUID() }));
    const stale = statements(f.s, () => assert.deepEqual(f.costing.stale(maker, '2026-03'), { stale: false, reason: null }));
    return { requirements, run, stale };
  } finally {
    f.s.close();
  }
}

test('成本计算（含跨期补登）：5 张和 50 张来源，算成本前要填的、算成本、结账核对发出的语句条数相同', () => {
  const [few, many] = [5, 50].map(countFor);
  assert.deepEqual(many, few);
});
