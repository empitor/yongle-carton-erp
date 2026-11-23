// 财务读业务来源的语句条数不随单据多少变（server/finance/source-scan.ts 和只读窗口的 sources 一组）：补扫（有要补的、
// 没有要补的）、结账检查、月度台账，5 张和 50 张来源发出的语句一样多；没有要补的时候不读来源内容；共用的对照结果
// 不带出事务里没提交的改动。只数语句，不比快慢。
// 全部是虚构数据，只用内存库。
import '../server/flow/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { catchUp } from '../server/finance/events/catch-up.js';
import { FinanceClosing } from '../server/finance/reports/closing.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceMonthly } from '../server/finance/reports/monthly.js';
import { scanSources } from '../server/finance/events/source-scan.js';
import { deliveryDoc, maker, newSettings, physical } from './finance-fixture.js';
import { quietLog } from './finance-catch-up-fixture.js';

/** 财务从 2026-01 启用，n 张 2026-01 的已确认送货单（还没同步） */
function books(n: number) {
  const s = new Store(':memory:');
  newSettings(s);
  for (let i = 1; i <= n; i++) physical(s, i, 'delivery', '2026-01-10', deliveryDoc(String(i)));
  return s;
}
const synced = (s: Store) => {
  const events = new FinanceEvents(s);
  while (events.sync(maker).remaining);
  return s;
};

/** 运行 run 时这个库准备的语句（每条 SQL 一次） */
function statementsOf(s: Store, run: () => unknown) {
  const seen: string[] = [],
    prepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql: string) => (seen.push(sql), prepare(sql));
  try {
    run();
    return seen;
  } finally {
    s.db.prepare = prepare;
  }
}
/** 读业务表（单据、库存流水）的语句 */
const business = (seen: string[]) => seen.filter((sql) => /\b(flow_documents|stock_movements)\b/.test(sql));
/** 读来源内容（单据、库存品的 document 列）的语句 */
const content = (seen: string[]) => business(seen).filter((sql) => /\bdocument\b/.test(sql));

/** 同一件事在 5 张和 50 张来源的库上各做一遍，回两边的语句 */
function bothSizes(prepare: (s: Store) => Store, run: (s: Store) => unknown) {
  return [5, 50].map((n) => {
    const s = prepare(books(n));
    try {
      return statementsOf(s, () => run(s));
    } finally {
      s.close();
    }
  });
}

test('补扫有要补的：判断要不要补、补一批，读业务表的语句条数不随单据多少变（对照一次、按批读一次原文）', () => {
  const [few, many] = bothSizes((s) => s, (s) => new FinanceEvents(s).pending(maker));
  assert.equal(few.length, many.length, '判断要不要补');
  assert.deepEqual(content(many), [], '判断要不要补不读内容');
  const [fewSync, manySync] = bothSizes((s) => s, (s) => new FinanceEvents(s).sync(maker));
  assert.equal(business(fewSync).length, business(manySync).length, '补一批');
  assert.equal(content(manySync).length, 1, '原文按批一次读完');
  const s = books(5);
  try {
    const plan = s.db
      .prepare('EXPLAIN QUERY PLAN ' + content(manySync)[0])
      .all('[]')
      .map((r) => String(r.detail));
    assert.ok(!plan.some((step) => /^(SCAN|SEARCH) f USING INDEX/.test(step)), '按编号找单据，不按种类把单据扫一遍：' + plan.join(' | '));
  } finally {
    s.close();
  }
});

test('对照结果共用：事务里算的不留下，事务回滚以后对照的是回滚后的库', () => {
  const s = synced(books(1));
  try {
    assert.equal(scanSources(s.db).unseen.length, 0, '事务外对照一次（记下）');
    s.db.exec('BEGIN');
    s.db.prepare('UPDATE fin_source_observations SET source_version=source_version+100').run();
    assert.equal(scanSources(s.db).unseen.length, 1, '事务里看得到没提交的改动');
    s.db.exec('ROLLBACK');
    assert.equal(scanSources(s.db).unseen.length, 0, '回滚了，观察记录又对得上');
  } finally {
    s.close();
  }
});

test('补扫没有要补的：语句条数不随单据多少变，也不读来源内容', () => {
  const [few, many] = bothSizes(synced, (s) => catchUp(s, maker, quietLog));
  assert.equal(few.length, many.length);
  assert.deepEqual(content(few), []);
  assert.deepEqual(content(many), []);
});

test('结账检查、月度台账：都同步了和都还没同步，语句条数都不随单据多少变', () => {
  const reads = (s: Store) => {
    new FinanceClosing(s).check(maker, { period: '2026-01' });
    new FinanceMonthly(s).get(maker, { period: '2026-01' });
    new FinanceMonthly(s).detail(maker, { period: '2026-01', pageSize: 200 });
  };
  for (const [label, prepare] of [
    ['都同步了', synced],
    ['都还没同步', (s: Store) => s],
  ] as const) {
    const [few, many] = bothSizes(prepare, reads);
    assert.equal(few.length, many.length, label);
  }
});
