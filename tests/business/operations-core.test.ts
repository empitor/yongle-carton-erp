// 采购库存的核心逻辑直接调用：写入共用的事务和取原记录、库存品用过没有和自动对应、库存流水查询、成品库存跟着产品（内存库，不经路由）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowFixture, clerk } from '../support/flow-fixture.js';
import { businessActor, priorRecord } from '../../server/operations/ledger/write-base.js';
import { StockItems, finishedFromProduct } from '../../server/operations/stock/stock-items.js';
import { MovementQueries } from '../../server/operations/ledger/movements.js';
import { OperationsRepository } from '../../server/operations/ledger/repository.js';
import { syncFinishedStock } from '../../server/operations/index.js';

test('写入共用的两件事：要业务编辑权限、改记录前核对版本', () => {
  const f = flowFixture();
  try {
    assert.throws(() => businessActor(null));
    const supplier = (all: boolean) => f.ops.suppliers(all, f.supplier.id)[0];
    assert.throws(() => priorRecord(supplier, { version: 99 }, clerk), /已被修改/);
    assert.equal(priorRecord(supplier, { version: f.supplier.version }, clerk).id, f.supplier.id);
  } finally {
    f.store.close();
  }
});

test('库存品用没用过（采购库存自己看得到的）、按产品找成品库存、到货时按规格对应已有的原材料、成品名称跟着产品', () => {
  const f = flowFixture();
  try {
    const items = new StockItems(f.store, new OperationsRepository(f.store));
    assert.equal(items.localUsages([f.raw.id]).get(f.raw.id) ?? null, null);
    f.arrive('虚构送货单-用过', '1');
    assert.equal(items.localUsages([f.raw.id]).get(f.raw.id) ?? null, 'moved');
    assert.equal(items.finishedStockFor(f.product.id, clerk).item.id, f.finished.id);
    assert.equal(items.rawStockMatch({ name: f.raw.name })?.id, f.raw.id);
    assert.equal(finishedFromProduct({ ...f.product, name: '虚构改名' }).name, '虚构改名');
  } finally {
    f.store.close();
  }
});

test('库存流水查询按库存品计数和列出；成品库存跟着产品改名', () => {
  const f = flowFixture();
  try {
    f.stockIn('20');
    const moves = new MovementQueries(f.store);
    assert.equal(moves.movementCount({ itemId: f.finished.id }), 1);
    assert.equal(moves.movements({ itemId: f.finished.id })[0].delta, '20');
    assert.deepEqual(moves.movementRevisions('不存在的流水'), []);
    syncFinishedStock(f.store, f.product, { ...f.product, name: '虚构产品改名' }, clerk);
    assert.equal(f.ops.items(true, f.finished.id)[0].name, '虚构产品改名');
  } finally {
    f.store.close();
  }
});
