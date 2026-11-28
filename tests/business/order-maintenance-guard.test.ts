// 本机管理员改订单的两种拦截（用户定“两种都拦住”，server/flow/rules/order-edit-guard.ts 的 maintenanceEditGuard）：
// 某一行已有已出库的送货，不许给这一行换产品；数量不许改得比已发的少。别的连带照旧（删行、改大数量、撤销后再换）。
// 待送货单（没出库）引用的那一行换产品不拦，出库时由送货核对拒下。编辑窗和数据管理两条路都经订单服务同一处。内存库、虚构数据。
import { test } from 'node:test';
// 删除引擎要各模块登记的删除规则（删行时连带改送货单用）
import '../../server/import/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderOf } from '../support/flow-fixture.js';
import { splitDeliveryFixture } from '../support/maintenance-fixture.js';

type Fixture = ReturnType<typeof splitDeliveryFixture>;
/** 改这张订单的明细（原样带回，按下标改） */
const withLine = (f: Fixture, id: number, index: number, patch: Record<string, unknown>) =>
  orderOf(f.store, id).lines.map((l, i) => (i === index ? { ...l, ...patch } : l));
/** 订单、送货单、流水的样子（拦下以后都不动） */
const state = (f: Fixture, id: number) => JSON.stringify([orderOf(f.store, id), f.deliveries(), f.moves()]);

test('已出库的那一行换产品：编辑窗、数据管理都拒，提示写行号、品名、已出库数量和送货单号，什么都不动', () => {
  const f = splitDeliveryFixture();
  try {
    const other = f.base.product({ name: '虚构另一种纸箱' });
    const order = f.order([300]),
      shipped = f.ship([{ order }]);
    const before = state(f, order.id);
    const reason = '第 1 行“虚构纸箱”已经出库 100 只（送货单 ' + shipped.number + '），不能换产品。要换，先撤销这张送货单，再改订单。';
    assert.throws(() => f.editOrder(order.id, { lines: withLine(f, order.id, 0, { productId: other.id }) }), (e: Error) => e.message === reason);
    const now = orderOf(f.store, order.id);
    assert.throws(
      () =>
        f.dataManagement.execute(
          { module: 'orders', action: 'update', items: [{ id: now.id, version: now.version }], patch: { lines: withLine(f, order.id, 0, { productId: other.id }) }, reason: '虚构维护', requestId: randomUUID() },
          f.who,
          's1',
        ),
      (e: Error) => e.message.includes(reason),
    );
    assert.equal(state(f, order.id), before);
    f.undo(shipped.id);
    const swapped = f.editOrder(order.id, { lines: withLine(f, order.id, 0, { productId: other.id }) });
    assert.equal(swapped.lines[0].productId, other.id, '撤销了这次送货以后能换');
  } finally {
    f.store.close();
  }
});

test('已出库的那一行数量改得比已发的少：拒；改成等于或多于已发的、删掉这一行照旧放行，进度跟着重算', () => {
  const f = splitDeliveryFixture();
  try {
    const order = f.order([300, 200]),
      shipped = f.ship([{ order }]);
    assert.throws(
      () => f.editOrder(order.id, { lines: withLine(f, order.id, 0, { quantity: 50 }) }),
      (e: Error) => e.message === '第 1 行“虚构纸箱”已发 100 只，数量不能改成 50 只（比已发的少）。要少发，先更正送货单 ' + shipped.number + '，或者撤销这张送货单，再改订单。',
    );
    assert.equal(f.editOrder(order.id, { lines: withLine(f, order.id, 0, { quantity: 100 }) }).lines[0].quantity, 100);
    const kept = f.editOrder(order.id, { lines: [orderOf(f.store, order.id).lines[1]] });
    assert.deepEqual(kept.lines.map((l) => l.quantity), [200], '删掉已出库的那一行照旧交给连带处理');
  } finally {
    f.store.close();
  }
});

test('有几行撞上就逐行列出；送货单超过 5 张写“等 N 张”', () => {
  const f = splitDeliveryFixture();
  try {
    const other = f.base.product({ name: '虚构另一种纸箱' });
    const order = f.order([700, 300]);
    const numbers = Array.from({ length: 6 }, () => f.ship([{ order, quantity: '10' }]).number);
    const second = f.ship([{ order, line: 1, quantity: '20' }]).number;
    const lines = orderOf(f.store, order.id).lines.map((l, i) => (i === 0 ? { ...l, productId: other.id } : { ...l, quantity: 5 }));
    assert.throws(
      () => f.editOrder(order.id, { lines }),
      (e: Error) =>
        e.message ===
        '第 1 行“虚构纸箱”已经出库 60 只（送货单 ' + numbers.slice(0, 5).join('、') + ' 等 6 张），不能换产品。要换，先撤销这些送货单，再改订单。' +
          '第 2 行“虚构纸箱”已发 20 只，数量不能改成 5 只（比已发的少）。要少发，先更正送货单 ' + second + '，或者撤销这张送货单，再改订单。',
    );
  } finally {
    f.store.close();
  }
});

test('待送货单（没出库）引用的那一行换产品：不拦，能存；这张待送货单出库时被送货核对拒下', () => {
  const f = splitDeliveryFixture();
  try {
    const other = f.base.product({ name: '虚构另一种纸箱' });
    const order = f.order([300]),
      waiting = f.pending([{ order }]);
    assert.equal(f.editOrder(order.id, { lines: withLine(f, order.id, 0, { productId: other.id }) }).lines[0].productId, other.id);
    assert.throws(() => f.base.check(waiting), /成品库存的产品与订单明细不一致/);
  } finally {
    f.store.close();
  }
});
