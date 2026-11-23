// 同一张单据冲销重做多次的冲销链（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { one, rows } from '../server/core/index.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceOverview } from '../server/finance/reports/overview.js';
import { FinanceStatements } from '../server/finance/parties/statements.js';
import { FinanceEventViews } from '../server/finance/events/event-views.js';
import { FinanceEventHandling } from '../server/finance/events/event-handling.js';
import { maker, subledger } from './finance-fixture.js';
import { flowFinance } from './finance-flow-fixture.js';

test('单据已撤销的“有差异”：说明写已撤销、不重做；业务单据列表同一单据的几条挨着，按先后排', async () => {
  const t = await flowFinance();
  try {
    const first = t.deliver('10');
    const second = t.deliver('20');
    t.sync();
    t.book(first.id, true);
    t.book(second.id, true);
    t.reverse(first.id);
    t.sync();
    const diff = t.current(first.id);
    assert.equal(diff.status, 'difference');
    assert.match(String(diff.problem), /^单据已撤销.*不再重做/);
    assert.equal(t.listed(diff.id).rebuild, 0, '只红字冲销，不重做');
    const result = new FinanceEventHandling(t.f.store).correct(maker, Number(diff.id), {
      version: Number(diff.version),
      requestId: t.randomUUID(),
      date: '2026-10-28',
      reason: '虚构：撤销送货',
    });
    assert.equal(result.status, 'corrected');
    assert.equal(result.handled, '已红字冲销原凭证');
    // 列表：第一张的原事件和冲销那条挨着，组里按先后
    const listed = new FinanceEventViews(t.f.store).list(maker, { pageSize: 200 }).rows.filter((r) =>
      [String(first.id), String(second.id)].includes(String(r.source_id)),
    );
    const firstRows = listed.map((r, i) => [String(r.source_id), i] as const).filter(([s]) => s === String(first.id));
    assert.equal(firstRows.length, 2);
    assert.equal(firstRows[1][1] - firstRows[0][1], 1, '同一张单据的两条挨着');
    const group = listed.filter((r) => String(r.source_id) === String(first.id));
    assert.ok(Number(group[0].id) < Number(group[1].id), '组里先来的在前');
    assert.deepEqual(group.map((r) => r.reversal_state), ['reversed', 'reversal']);
    // 送货详情的财务一段：两行成对，没有被替代的空行
    const related = new FinanceOverview(t.f.store).related(maker, 'delivery', first.id, {}).rows;
    assert.ok(related.every((r) => r.status !== 'superseded'));
    assert.deepEqual(related.map((r) => r.reversal_state), ['reversed', 'reversal']);
  } finally {
    t.f.store.close();
  }
});

test('到货单冲销重做两次：逐笔、对账单里整条链挨着，按先后排', async () => {
  const t = await flowFinance();
  try {
    const a = t.receive('6000', '虚构供应商单号-两层');
    t.sync();
    t.book(a.id, true);
    // 已入库的到货单只能“更正到货单”：撤销原单、另出替代单；财务红冲原来那笔，由替代单入账
    let current = a.id;
    const docs = [a.id];
    const change = (quantity: string) => {
      const before = current;
      t.correctArrival(before, quantity);
      const doc = one(
        t.f.store.db,
        rows.flow_documents.pick({ replaced_by: true }),
        'SELECT replaced_by FROM flow_documents WHERE id=?',
        before,
      );
      if (doc?.replaced_by == null) throw new Error('测试数据：到货单 ' + before + ' 更正后没有替代单');
      current = doc.replaced_by;
      docs.push(current);
      t.sync();
      // 更正单那条“有差异”：红冲原单的凭证、由更正单入账（原单自己的事件已标成已更正）
      t.correctAll(current, 'arrival');
      if (t.current(current).status === 'ready') t.book(current, true);
    };
    change('5500');
    const other = t.receive('1000', '虚构供应商单号-夹在中间');
    t.sync();
    t.book(other.id, true);
    change('5000');
    // 每次更正出一张新单号的替代单：原单、第一张替代单、第二张替代单
    const [number, second, third] = docs.map((id) => t.number(id));
    const payables = new FinanceParties(t.f.store).obligations(maker, { kind: 'payable', pageSize: 200 }).rows;
    // 替代单单号不同，按冲销链（链头是原单那笔）取整条链
    const head = payables.find((r) => r.source_number === number && r.reversal_state === 'reversed');
    assert.ok(head, '原单那笔在逐笔里，标已冲销');
    const chain = payables.filter((r) => r.pair_group === head.pair_group);
    assert.equal(chain.length, 5);
    const at = payables.indexOf(chain[0]);
    assert.deepEqual(payables.slice(at, at + 5), chain, '整条链挨着');
    assert.deepEqual(
      chain.map((r) => [r.reversal_state, Number(r.rerecorded)]),
      [
        ['reversed', 0],
        ['reversal', 0],
        ['reversed', 1],
        ['reversal', 0],
        [null, 1],
      ],
    );
    assert.equal(subledger(t.f.store, 'payable'), 500000 + 100000, '应付只剩最后一次的和另一张');
    const statement = new FinanceStatements(t.f.store).statement(maker, {
      kind: 'payable',
      partyId: String(chain[4].party_id),
      from: '2026-10-01',
      to: '2026-12-31',
    });
    const texts = statement.items.map((r) => r.description);
    const first = texts.indexOf('到货单 ' + number);
    assert.deepEqual(texts.slice(first, first + 5), [
      '到货单 ' + number,
      '红字冲销 到货单 ' + number,
      '到货单 ' + second + '（更正后重记）',
      '红字冲销 到货单 ' + second + '（冲 ' + statement.items[first + 2].date + ' 重记的那笔）',
      '到货单 ' + third + '（更正后重记）',
    ]);
  } finally {
    t.f.store.close();
  }
});
