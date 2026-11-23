// 库存流水的底线（server/operations/ledger.ts）：写流水时结余不能负、不能超上限、必须是整数；
// 按流水重算结余时逐笔算出前后结余，会变负或超上限的交给调用方报错。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, many, rows } from '../server/core/index.js';
import { OperationsService } from '../server/operations/index.js';
import { stockLedger } from '../server/operations/index.js';
import { MAX_STOCK_UNITS } from '../shared/core/index.js';
import { rawInput, stackActor } from './stack-fixture.js';

function setup() {
  const store = new Store(':memory:');
  const item = new OperationsService(store).saveItem(rawInput, stackActor);
  const move = (delta: number, before = 0, after = 0) =>
    stockLedger.insertMovement(store, {
      stockId: item.id,
      action: delta < 0 ? 'out' : 'in',
      delta,
      before,
      after,
      sourceKind: 'manual',
      sourceId: null,
      date: '2026-10-27',
      notes: '虚构流水',
      actor: stackActor,
    });
  const balances = () =>
    many(
      store.db,
      rows.stock_movements.pick({ before_units: true, after_units: true }),
      'SELECT before_units,after_units FROM stock_movements WHERE item_id=? ORDER BY created_at,rowid',
      item.id,
    ).map((m) => [m.before_units, m.after_units]);
  return { store, item, move, balances };
}

test('写流水时结余为负、超过上限或不是整数都拒收，并说清是库存不足或数量超限', () => {
  const { store, move } = setup();
  try {
    for (const after of [-1, MAX_STOCK_UNITS + 1, 1.5])
      assert.throws(() => move(1000, 0, after), /库存不足或数量超限，不能记这笔流水。/, String(after));
    assert.equal(typeof move(MAX_STOCK_UNITS, 0, MAX_STOCK_UNITS), 'string', '正好到上限可以记');
    assert.equal(typeof move(1000, 0, 0), 'string', '不关联采购明细和订单的流水照常记');
  } finally {
    store.close();
  }
});

test('按流水重算结余：逐笔改成前一笔的结余和加上本笔后的结余，对得上的不动', () => {
  const { store, move, balances } = setup();
  try {
    move(100000, 0, 0);
    move(-30000, 5, 5);
    move(20000, 70000, 90000);
    move(-90000, 1, 0);
    stockLedger.rebalanceMovements(store, () => assert.fail('结余不会变负'));
    assert.deepEqual(balances(), [[0, 100000], [100000, 70000], [70000, 90000], [90000, 0]]);
  } finally {
    store.close();
  }
});

test('重算时结余正好到 0 或正好到上限都可以', () => {
  const { store, move, balances } = setup();
  try {
    move(MAX_STOCK_UNITS);
    stockLedger.rebalanceMovements(store, () => assert.fail('正好到上限可以'));
    move(-MAX_STOCK_UNITS);
    stockLedger.rebalanceMovements(store, () => assert.fail('正好到 0 可以'));
    assert.deepEqual(balances(), [[0, MAX_STOCK_UNITS], [MAX_STOCK_UNITS, 0]]);
  } finally {
    store.close();
  }
});

test('重算时结余会变负或超过上限，按库存品名称交给调用方报错', () => {
  for (const deltas of [[10000, -20000], [MAX_STOCK_UNITS, 1]]) {
    const { store, move } = setup();
    try {
      for (const d of deltas) move(d);
      assert.throws(
        () => stockLedger.rebalanceMovements(store, (name) => {
          throw new Error('结余不够：' + name);
        }),
        new RegExp('^Error: 结余不够：' + rawInput.name + '$'),
        deltas.join(','),
      );
    } finally {
      store.close();
    }
  }
});
